/**
 * `room acp` as an editor sees it: the real CLI spawned as a subprocess with
 * fake seats behind it, driven by a plain ACP client that records every
 * session update and answers permission requests from a script.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import * as acp from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { newRoomName, promptText } from "../src/server/acp.js";
import { FAKE_AGENT, TSX } from "./fixtures/index.js";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "room.ts");

const dirs: string[] = [];
const procs: ChildProcess[] = [];
const tmp = (label: string) => {
  const d = mkdtempSync(join(tmpdir(), `room-acp-${label}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A roster of fake seats: `a` resumes via session/resume, `b` via session/load. */
function roster(state: string): string {
  const path = join(tmp("roster"), "roster.toml");
  const seat = (name: string, flags: string[]) =>
    `[[seats]]\nname = "${name}"\ncommand = ${JSON.stringify(TSX)}\nargs = ${JSON.stringify([FAKE_AGENT, ...flags, "--state-dir", state])}\n`;
  writeFileSync(path, [seat("a", ["--modes", "--resume"]), seat("b", ["--load"])].join("\n"));
  return path;
}

type Answer = "allow" | "always" | "deny" | "cancelled";

/** The editor side: spawns `room acp`, records updates, answers permissions in order. */
async function editor(rosterPath: string, args: string[] = []) {
  const child = spawn(TSX, [BIN, "--roster", rosterPath, "acp", "a", "b", "--wake", "all", ...args], { stdio: ["pipe", "pipe", "pipe"] });
  procs.push(child);
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
  const updates: acp.SessionNotification[] = [];
  const asked: acp.RequestPermissionRequest[] = [];
  const answers: Answer[] = [];
  const conn = acp
    .client({ name: "test-editor" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      asked.push(ctx.params);
      const a = answers.shift() ?? "deny";
      return a === "cancelled" ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: a } };
    })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      updates.push(ctx.params);
    })
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      ),
    );
  const agent = conn.agent;
  const init = await agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
  });
  const settle = () => new Promise((r) => setTimeout(r, 150));
  return {
    init,
    agent,
    updates,
    asked,
    answers,
    stderr: () => stderr,
    /** Agent message text for a session since update index `from`. */
    text(sessionId: string, from = 0): string {
      return updates
        .slice(from)
        .filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk")
        .map((u) => (u.update as { content: { type: string; text: string } }).content.text)
        .join("");
    },
    async prompt(sessionId: string, text: string) {
      const from = updates.length;
      const res = await agent.request(acp.methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
      await settle();
      return { stopReason: res.stopReason, text: this.text(sessionId, from), from };
    },
    settle,
    async close() {
      conn.close();
      child.stdin!.end();
      await new Promise<void>((r) => (child.exitCode !== null ? r() : child.once("exit", () => r())));
    },
  };
}

describe("room acp", () => {
  it("opens a room per session, streams each seat as its own paragraph, and lists its commands", async () => {
    const cwd = tmp("cwd");
    const ed = await editor(roster(tmp("state")), ["--no-git"]);
    expect(ed.init.agentInfo?.name).toBe("room");
    expect(ed.init.agentCapabilities?.loadSession).toBe(true);
    expect(ed.init.agentCapabilities?.sessionCapabilities?.resume).toBeTruthy();

    const s = await ed.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    expect(s.sessionId).toMatch(/^acp-\d{8}T\d{6}-/);
    expect(s.modes?.currentModeId).toBe("sequential");
    expect(s.modes?.availableModes.map((m) => m.id)).toEqual(["sequential", "parallel"]);
    await ed.settle();
    // Startup status lines arrive after the response, once the editor knows the session.
    expect(ed.text(s.sessionId)).toMatch(/\[room\] a: fake-agent ready, mode default/);
    const cmds = ed.updates.find((u) => u.update.sessionUpdate === "available_commands_update");
    expect(cmds?.sessionId).toBe(s.sessionId);

    const r = await ed.prompt(s.sessionId, ">> say hello from the room");
    expect(r.stopReason).toBe("end_turn");
    expect(r.text).toBe("**a>** hello from the room \n\n**b>** hello from the room ");
    expect(existsSync(join(cwd, ".room", s.sessionId, "transcript.jsonl"))).toBe(true);

    const seats = await ed.prompt(s.sessionId, "/seats");
    expect(seats.text).toMatch(/^```\n {2}room mode: sequential\n {2}a +mode default/);

    // Two sessions are two rooms.
    const s2 = await ed.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    expect(s2.sessionId).not.toBe(s.sessionId);
    await ed.close();
    expect(ed.stderr()).toMatch(/serving ACP with seats a, b/);
  }, 60_000);

  it("forwards a seat's permission request with its diff, and commits the approved edit under the seat's name", async () => {
    const cwd = tmp("repo");
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(cwd, "calc.py"), "return a - b\n");
    git("add", "calc.py");
    git("commit", "-q", "-m", "seed");
    const ed = await editor(roster(tmp("state")));
    const { sessionId } = await ed.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });

    ed.answers.push("allow");
    const r = await ed.prompt(sessionId, "@b >> edit calc.py return a + b\n>> land");
    expect(ed.asked.length).toBe(1);
    const req = ed.asked[0];
    expect(req.sessionId).toBe(sessionId);
    expect(req.toolCall.title).toBe("b: Edit calc.py");
    expect(req.toolCall.toolCallId).toBe("b:0:t1");
    expect(req.toolCall.content?.[0]).toMatchObject({ type: "diff", newText: "return a + b\n" });
    expect(req.options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    expect(readFileSync(join(cwd, "calc.py"), "utf8")).toBe("return a + b\n");
    expect(git("log", "-1", "--format=%an")).toBe("b");
    expect(r.text).toMatch(/\*\*b>\*\* edited calc.py \n\n\[land\] \n\n\[room\] b landed 1 commit on room\/acp-\S+ \([0-9a-f]+\): 1 file changed/);
    // The tool call itself, namespaced by seat and turn.
    const calls = ed.updates.slice(r.from).filter((u) => u.update.sessionUpdate === "tool_call");
    expect(calls.map((u) => (u.update as acp.ToolCall).toolCallId)).toEqual(["b:0:t1"]);

    // "Always" becomes a room rule, so the next edit is not asked for.
    ed.answers.push("always");
    await ed.prompt(sessionId, "@b >> edit calc.py return a * b");
    expect(ed.asked.length).toBe(2);
    expect(ed.asked[1].toolCall.toolCallId).toBe("b:1:t1");
    await ed.prompt(sessionId, "@b >> edit calc.py return a / b\n>> land");
    expect(ed.asked.length).toBe(2);
    expect(readFileSync(join(cwd, "calc.py"), "utf8")).toBe("return a / b\n");
    await ed.close();
  }, 60_000);

  it("cancels the running round: the seat stops and the rest of the round is dropped", async () => {
    const cwd = tmp("cwd");
    const ed = await editor(roster(tmp("state")), ["--no-git"]);
    const { sessionId } = await ed.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    const started = Date.now();
    const turn = ed.prompt(sessionId, ">> sleep 5000");
    await new Promise((r) => setTimeout(r, 500));
    await ed.agent.notify(acp.methods.agent.session.cancel, { sessionId });
    const r = await turn;
    expect(r.stopReason).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(4000);
    expect(r.text).toMatch(/\[room\] round cancelled/);
    const transcript = readFileSync(join(cwd, ".room", sessionId, "transcript.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { from: string; kind: string });
    // a's cancelled turn is a pass; b never got a turn.
    expect(transcript.filter((e) => e.from === "a").map((e) => e.kind)).toEqual(["pass"]);
    expect(transcript.some((e) => e.from === "b")).toBe(false);

    // The room still works afterwards. (a, not b: b would catch up on the sleep it never ran.)
    expect((await ed.prompt(sessionId, "@a >> say still here")).text).toBe("**a>** still here ");
    await ed.close();
  }, 60_000);

  it("offers the room's modes as session modes: parallel refuses edits without asking", async () => {
    const cwd = tmp("cwd");
    const ed = await editor(roster(tmp("state")), ["--no-git"]);
    const { sessionId } = await ed.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    await ed.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: "parallel" });
    const r = await ed.prompt(sessionId, ">> edit x.txt nope");
    expect(ed.asked).toEqual([]);
    expect(existsSync(join(cwd, "x.txt"))).toBe(false);
    expect(r.text).toMatch(/\[room\] parallel round: a, b/);
    expect(r.text).toMatch(/\*\*a>\*\* edit refused/);

    const back = await ed.prompt(sessionId, "/sequential");
    expect(back.text).toMatch(/room mode: sequential/);
    const modeUpdate = ed.updates.slice(back.from).find((u) => u.update.sessionUpdate === "current_mode_update");
    expect(modeUpdate?.update).toMatchObject({ currentModeId: "sequential" });

    await expect(ed.agent.request(acp.methods.agent.session.setMode, { sessionId, modeId: "yolo" })).rejects.toThrow();
    await ed.close();
  }, 60_000);

  it("reloads a room in a new process: history replays, seats reattach to their sessions", async () => {
    const cwd = tmp("cwd");
    const state = tmp("state");
    const rosterPath = roster(state);
    let ed = await editor(rosterPath, ["--no-git"]);
    const { sessionId } = await ed.agent.request(acp.methods.agent.session.new, { cwd, mcpServers: [] });
    await ed.prompt(sessionId, ">> remember quince");
    await ed.close();

    ed = await editor(rosterPath, ["--no-git"]);
    const loaded = await ed.agent.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] });
    expect(loaded.modes?.currentModeId).toBe("sequential");
    await ed.settle();
    const users = ed.updates.filter((u) => u.update.sessionUpdate === "user_message_chunk");
    expect(users.map((u) => (u.update as { content: { text: string } }).content.text)).toEqual([">> remember quince"]);
    const history = ed.text(sessionId);
    expect(history).toMatch(/\*\*a>\*\* remembered/);
    expect(history).toMatch(/\[room\] a: resumed session fake-/);
    expect(history).toMatch(/\[room\] b: resumed session fake-/);
    const r = await ed.prompt(sessionId, ">> recall");
    expect(r.text).toBe("**a>** quince \n\n**b>** quince ");
    await ed.close();

    // session/resume: same room, no replay.
    ed = await editor(rosterPath, ["--no-git"]);
    await ed.agent.request(acp.methods.agent.session.resume, { sessionId, cwd, mcpServers: [] });
    await ed.settle();
    expect(ed.updates.some((u) => u.update.sessionUpdate === "user_message_chunk")).toBe(false);
    expect((await ed.prompt(sessionId, "@a >> recall")).text).toBe("**a>** quince ");

    await expect(
      ed.agent.request(acp.methods.agent.session.load, { sessionId: "acp-nope", cwd, mcpServers: [] }),
    ).rejects.toThrow(/no saved room/);
    await expect(
      ed.agent.request(acp.methods.agent.session.load, { sessionId: "../../etc", cwd, mcpServers: [] }),
    ).rejects.toThrow(/not a room name/);
    await ed.close();
  }, 90_000);

  it("reports a seat that cannot start as a failed session/new, with the harness's detail", async () => {
    const state = tmp("state");
    const path = join(tmp("roster"), "roster.toml");
    writeFileSync(
      path,
      `[[seats]]\nname = "a"\ncommand = ${JSON.stringify(TSX)}\nargs = ${JSON.stringify([FAKE_AGENT, "--state-dir", state])}\n\n` +
        `[[seats]]\nname = "b"\ncommand = ${JSON.stringify(TSX)}\nargs = ${JSON.stringify([FAKE_AGENT, "--fail-session", "cannot reach the sandbox daemon"])}\n`,
    );
    const ed = await editor(path, ["--no-git"]);
    await expect(ed.agent.request(acp.methods.agent.session.new, { cwd: tmp("cwd"), mcpServers: [] })).rejects.toThrow(
      /sandbox daemon/,
    );
    await ed.close();
  }, 60_000);
});

describe("server helpers", () => {
  it("names rooms by time, safe for a branch", () => {
    expect(newRoomName(new Date("2026-09-25T19:01:02Z"))).toMatch(/^acp-20260925T190102-[a-z0-9]{1,4}$/);
  });

  it("turns prompt blocks into room text", () => {
    expect(
      promptText([
        { type: "text", text: "look at" },
        { type: "resource_link", name: "calc.py", uri: "file:///p/calc.py" },
      ]),
    ).toBe("look at [calc.py](file:///p/calc.py)");
  });
});
