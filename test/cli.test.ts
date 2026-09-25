import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RECIPES, recipeFor } from "../src/seat/cli-recipes.js";
import { CliSeat } from "../src/seat/cli.js";
import { personaText } from "../src/preamble.js";

let dir: string;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("cli recipes", () => {
  const turn = { prompt: "hi", cwd: "/w", scratchFile: "/w/last.txt" };

  it("claude: json result and session id, resume flag on later turns", () => {
    const r = RECIPES.claude;
    expect(r.args(turn)).toEqual(["-p", "--output-format", "json", "--permission-mode", "acceptEdits", "hi"]);
    expect(r.args({ ...turn, sessionId: "s1" })).toContain("--resume");
    expect(r.parse(`{"result":"pong","session_id":"abc","is_error":false}`, turn)).toEqual({
      text: "pong",
      sessionId: "abc",
      error: undefined,
    });
    expect(r.parse(`{"result":"quota","session_id":"abc","is_error":true}`, turn).error).toBe("quota");
  });

  it("grok: text and sessionId, prompt as the -p value", () => {
    const r = RECIPES.grok;
    expect(r.args(turn).slice(0, 2)).toEqual(["-p", "hi"]);
    expect(r.args({ ...turn, sessionId: "g1" }).slice(-2)).toEqual(["-r", "g1"]);
    expect(r.parse(`{\n "text": "pong",\n "sessionId": "g1"\n}`, turn)).toEqual({ text: "pong", sessionId: "g1" });
  });

  it("agy: --print=<prompt> and conversation_id", () => {
    const r = RECIPES.agy;
    expect(r.args(turn)[0]).toBe("--print=hi");
    expect(r.parse(`{"conversation_id":"c1","status":"SUCCESS","response":"pong\\n"}`, turn)).toEqual({
      text: "pong\n",
      sessionId: "c1",
      error: undefined,
    });
  });

  it("codex: thread id from the event stream, text from the -o file, errors surfaced", () => {
    dir = mkdtempSync(join(tmpdir(), "room-cli-"));
    const t = { ...turn, scratchFile: join(dir, "last.txt") };
    writeFileSync(t.scratchFile, "pong\n");
    const r = RECIPES.codex;
    expect(r.args(t).slice(0, 2)).toEqual(["exec", "--json"]);
    expect(r.args({ ...t, sessionId: "th1" }).slice(0, 3)).toEqual(["exec", "resume", "th1"]);
    const out = `{"type":"thread.started","thread_id":"th1"}\n{"type":"turn.started"}\n`;
    expect(r.parse(out, t)).toEqual({ text: "pong", sessionId: "th1", error: undefined });
    expect(r.parse(out + `{"type":"error","message":"limit"}\n`, t).error).toBe("limit");
  });

  it("picks a recipe from cli or the command basename", () => {
    expect(recipeFor(undefined, "/opt/homebrew/bin/grok").id).toBe("grok");
    expect(recipeFor("claude", "anything").id).toBe("claude");
    expect(() => recipeFor(undefined, "hermes")).toThrow(/no CLI recipe/);
  });
});

describe("CliSeat", () => {
  it("runs one process per turn and resumes with the returned session id", async () => {
    // A recipe that runs node and echoes back what it was given.
    RECIPES.echo = {
      id: "echo",
      command: "node",
      unattended: "-",
      args: (t) => [
        "-e",
        `console.log(JSON.stringify({ text: "got:" + process.argv[1] + " sid:" + (process.argv[2] || "none"), sessionId: "S" }))`,
        t.prompt,
        ...(t.sessionId ? [t.sessionId] : []),
      ],
      parse: (out) => {
        const j = JSON.parse(out.trim()) as { text: string; sessionId: string };
        return { text: j.text, sessionId: j.sessionId };
      },
    };
    const seat = new CliSeat({ name: "e", adapter: "cli", command: "node", cli: "echo" }, async () => "cancel");
    await seat.newSession(process.cwd());
    const collect = async (p: string) => {
      let s = "";
      for await (const ev of seat.prompt(p)) if (ev.type === "text") s += ev.text;
      return s;
    };
    expect(await collect("one")).toBe("got:one sid:none");
    expect(seat.sessionId).toBe("S");
    expect(await collect("two")).toBe("got:two sid:S");
    delete RECIPES.echo;
  });
});

describe("personaText", () => {
  it("joins promptFile and prompt, and names a missing file", () => {
    dir = mkdtempSync(join(tmpdir(), "room-p-"));
    const f = join(dir, "SOUL.md");
    writeFileSync(f, "# Me\nI collect patterns.\n");
    expect(personaText({ name: "l", adapter: "acp", command: "x", promptFile: f, prompt: "Sign -l" })).toBe(
      "# Me\nI collect patterns.\n\nSign -l",
    );
    expect(personaText({ name: "l", adapter: "acp", command: "x" })).toBeUndefined();
    expect(() => personaText({ name: "l", adapter: "acp", command: "x", promptFile: join(dir, "nope") })).toThrow(/promptFile/);
  });
});
