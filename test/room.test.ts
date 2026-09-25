import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decide, makeDecider, matches } from "../src/permissions.js";
import { Room, type RoomUI } from "../src/room.js";
import { parseAddress, Scheduler } from "../src/scheduler.js";
import type { PermissionDecider, PermissionRequestView, Seat, SeatConfig, SeatEvent } from "../src/seat/types.js";
import { renderDelta, Transcript } from "../src/transcript.js";

/** A seat that replies with a script and records every prompt it received. */
class FakeSeat implements Seat {
  readonly name: string;
  prompts: string[] = [];
  modes = { current: "auto", available: [{ id: "default", name: "Manual" }, { id: "auto", name: "Auto" }] };
  constructor(
    readonly config: SeatConfig,
    private readonly replies: Array<string | ((prompt: string) => string)>,
    readonly decide?: PermissionDecider,
  ) {
    this.name = config.name;
  }
  async start() {
    return { loadSession: true, authMethods: [] };
  }
  async newSession() {
    return `${this.name}-session`;
  }
  async *prompt(text: string): AsyncIterable<SeatEvent> {
    this.prompts.push(text);
    const next = this.replies.shift() ?? "[pass]";
    const reply = typeof next === "function" ? next(text) : next;
    if (reply.startsWith("ASK:") && this.decide) {
      const title = reply.slice(4);
      const answer = await this.decide({
        seat: this.name,
        sessionId: "s",
        toolCallId: "t1",
        title,
        kind: "edit",
        options: [
          { optionId: "y", name: "Allow", kind: "allow_once" },
          { optionId: "n", name: "Deny", kind: "reject_once" },
        ],
      });
      yield { type: "text", text: answer === "y" ? "edited" : "not allowed" };
    } else {
      for (const word of reply.split(" ")) yield { type: "text", text: word + " " };
    }
    yield { type: "stop", stopReason: "end_turn" };
  }
  async cancel() {}
  async stop() {}
  stderrTail() {
    return "";
  }
  async setMode(id: string) {
    this.modes.current = id;
  }
}

const quietUI = (answers: Array<"allow" | "allow_always" | "deny" | "cancel"> = []): RoomUI & { asked: PermissionRequestView[]; lines: string[] } => ({
  asked: [],
  lines: [],
  seatEvent() {},
  async askHuman(req) {
    this.asked.push(req);
    return answers.shift() ?? "deny";
  },
  status(line) {
    this.lines.push(line);
  },
});

let dir: string;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("Transcript", () => {
  it("appends, persists, and renders deltas without the seat's own messages", () => {
    dir = mkdtempSync(join(tmpdir(), "room-t-"));
    const t = Transcript.open(join(dir, "t.jsonl"));
    t.append("Corina", "message", "hello");
    t.append("grok", "message", "hi back");
    t.append("room", "commit", "grok committed abc: 1 file changed");
    t.append("claude", "pass", "");
    expect(t.last).toBe(4);
    const again = Transcript.open(join(dir, "t.jsonl"));
    expect(again.entries.length).toBe(4);
    expect(renderDelta(again.since(0), "grok")).toBe(
      "[Corina]: hello\n\n[room]: grok committed abc: 1 file changed\n\n[room]: claude passed.",
    );
    expect(again.since(3).map((e) => e.id)).toEqual([4]);
  });
});

describe("Scheduler", () => {
  it("fills in roster order, dedupes, and pushes addressed seats to the front", () => {
    const s = new Scheduler(["a", "b", "c"]);
    s.fill();
    expect(s.pending).toEqual(["a", "b", "c"]);
    s.pushFront("c");
    expect(s.pending).toEqual(["c", "a", "b"]);
    expect(s.shift()).toBe("c");
    s.fill(["a"]);
    expect(s.pending).toEqual(["a", "b"]);
    expect(() => s.fill(["zz"])).toThrow(/unknown seat/);
  });

  it("parses leading addresses case-insensitively", () => {
    expect(parseAddress("@Grok @claude what now?", ["grok", "claude", "pool"])).toEqual({
      targets: ["grok", "claude"],
      text: "what now?",
    });
    expect(parseAddress("email me at @home", ["grok"])).toEqual({ targets: [], text: "email me at @home" });
  });
});

describe("permissions", () => {
  it("matches kinds and title globs, deny beats ask beats allow", () => {
    expect(matches("Write *", "Write /tmp/x.txt")).toBe(true);
    expect(matches("edit", "EDIT")).toBe(true);
    expect(matches("Write *", "Read /tmp/x.txt")).toBe(false);
    const p = { allow: ["*"], ask: ["execute"], deny: ["Bash rm *"] };
    expect(decide(p, { kind: "edit", title: "Write a.ts" })).toBe("allow");
    expect(decide(p, { kind: "execute", title: "Bash ls" })).toBe("ask");
    expect(decide(p, { kind: "execute", title: "Bash rm -rf /" })).toBe("deny");
    expect(decide(undefined, { title: "anything" })).toBe("ask");
  });

  it("answers by policy, asks otherwise, and records allow-always", async () => {
    const always: string[] = [];
    let asks = 0;
    const decide = makeDecider({
      policyFor: () => ({ allow: ["read"], ask: [], deny: [] }),
      askHuman: async () => {
        asks += 1;
        return "allow_always";
      },
      onAllowAlways: (_seat, pattern) => always.push(pattern),
    });
    const req = (kind: string): PermissionRequestView => ({
      seat: "s",
      sessionId: "x",
      toolCallId: "t",
      title: "T",
      kind,
      options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }],
    });
    expect(await decide(req("read"))).toBe("ok");
    expect(asks).toBe(0);
    expect(await decide(req("edit"))).toBe("ok");
    expect(asks).toBe(1);
    expect(always).toEqual(["edit"]);
  });
});

describe("Room", () => {
  const seats: SeatConfig[] = [
    { name: "a", adapter: "acp", command: "fake" },
    { name: "b", adapter: "acp", command: "fake", role: "critic" },
  ];

  async function open(scripts: Record<string, string[]>, ui = quietUI()) {
    dir = mkdtempSync(join(tmpdir(), "room-r-"));
    const fakes = new Map<string, FakeSeat>();
    const room = await Room.open({
      name: "t",
      cwd: dir,
      seats,
      human: "Corina",
      ui,
      git: false,
      makeSeat: (config, decide) => {
        const f = new FakeSeat(config, scripts[config.name] ?? [], decide);
        fakes.set(config.name, f);
        return f;
      },
    });
    await room.start();
    return { room, fakes, ui };
  }

  it("runs a round in order, sends the preamble once, and keeps per-seat cursors", async () => {
    const { room, fakes } = await open({ a: ["first from a", "again"], b: ["b replies"] });
    await room.say("hello everyone");
    const kinds = room.transcript.entries.map((e) => `${e.from}:${e.kind}`);
    expect(kinds).toEqual(["room:system", "Corina:message", "a:message", "b:message"]);
    expect(fakes.get("a")!.prompts[0]).toMatch(/^You are a, one seat/);
    expect(fakes.get("a")!.prompts[0]).toContain("[Corina]: hello everyone");
    expect(fakes.get("b")!.prompts[0]).toContain("You are b, the critic");
    expect(fakes.get("b")!.prompts[0]).toContain("[a]: first from a");
    // Second round: a sees only what came after its own reply.
    await room.continueRound();
    expect(fakes.get("a")!.prompts[1]).not.toMatch(/^You are/);
    expect(fakes.get("a")!.prompts[1]).toBe("[b]: b replies");
    expect(room.state.modes).toEqual({ a: "default", b: "default" });
    expect(room.state.cursors.a).toBe(room.transcript.entries.findIndex((e) => e.from === "a" && e.text === "again") + 1);
  });

  it("routes @seat to one seat and records passes", async () => {
    const { room, fakes } = await open({ a: ["only me"], b: ["[pass]"] });
    await room.say("@b your take");
    expect(fakes.get("a")!.prompts.length).toBe(0);
    expect(room.transcript.entries.at(-1)).toMatchObject({ from: "b", kind: "pass" });
    expect(room.transcript.entries[1].text).toBe("your take");
  });

  it("forwards permission requests to the UI and persists allow-always as a rule", async () => {
    const ui = quietUI(["allow_always"]);
    const { room } = await open({ a: ["ASK:Write x.ts", "ASK:Write y.ts"] }, ui);
    await room.say("@a edit something");
    expect(ui.asked.length).toBe(1);
    expect(room.policyOf("a").allow).toEqual(["edit"]);
    await room.say("@a edit again");
    expect(ui.asked.length).toBe(1); // answered by policy this time
    expect(room.transcript.entries.at(-1)?.text).toBe("edited");
  });
});
