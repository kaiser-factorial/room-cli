/** Regression tests for the code review's findings, one per fix. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { hit, makeDecider } from "../src/permissions.js";
import { Room, type RoomUI } from "../src/room.js";
import { AcpSeat, strayFilter } from "../src/seat/acp.js";
import type { Seat, SeatConfig, SeatEvent } from "../src/seat/types.js";
import { LineSource } from "../src/ui/repl.js";
import { TuiStore } from "../src/ui/tui/store.js";
import { fakeAcpSeat } from "./fixtures/index.js";

type Reply = string | ((prompt: string) => Promise<string>);

/** Replies from a script; `ignoreCancel` plays a hung harness. */
class ScriptSeat implements Seat {
  readonly name: string;
  prompts: string[] = [];
  constructor(
    readonly config: SeatConfig,
    private readonly replies: Reply[],
    private readonly ignoreCancel = false,
  ) {
    this.name = config.name;
  }
  private cancelNow?: () => void;
  async start() {
    return { loadSession: false, authMethods: [] };
  }
  async newSession() {
    return `${this.name}-s`;
  }
  async *prompt(text: string): AsyncIterable<SeatEvent> {
    this.prompts.push(text);
    const next = this.replies.shift() ?? "[pass]";
    const cancelled = new Promise<string>((r) => (this.cancelNow = () => r("")));
    const reply = typeof next === "function" ? await Promise.race([next(text), cancelled]) : next;
    yield { type: "text", text: reply };
    yield { type: "stop", stopReason: "end_turn" };
  }
  async cancel() {
    if (!this.ignoreCancel) this.cancelNow?.();
  }
  async stop() {}
  stderrTail() {
    return "";
  }
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "room-fix-"));
  dirs.push(cwd);
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd });
  git("init", "-q", "-b", "main");
  writeFileSync(join(cwd, "f.txt"), "seed\n");
  git("add", "f.txt");
  git("commit", "-q", "-m", "seed");
  return cwd;
}
function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { open, wait: () => p };
}
async function openRoom(scripts: Record<string, Reply[]>, extra: { ignoreCancel?: string; onStatus?: (l: string, room: Room) => void } = {}) {
  const cwd = repo();
  const seats: SeatConfig[] = Object.keys(scripts).map((name) => ({ name, adapter: "acp", command: "fake" }));
  const fakes = new Map<string, ScriptSeat>();
  // The status hook needs the room, which exists only once open() returns.
  const ref: { room?: Room } = {};
  const lines: string[] = [];
  const ui: RoomUI = {
    seatEvent() {},
    backgroundEvent() {},
    askHuman: async () => "deny",
    status: (l) => {
      lines.push(l);
      if (ref.room) extra.onStatus?.(l, ref.room);
    },
  };
  const room = await Room.open({
    name: "fix",
    cwd,
    seats,
    human: "Corina",
    ui,
    makeSeat: (config) => {
      const f = new ScriptSeat(config, scripts[config.name], extra.ignoreCancel === config.name);
      fakes.set(config.name, f);
      return f;
    },
  });
  ref.room = room;
  await room.start();
  return { room, fakes, lines, cwd };
}

describe("code review fixes", () => {
  it("1: a line typed ahead never answers a seat's question, and Enter alone is not allow", async () => {
    const input = new PassThrough();
    const rl = createInterface({ input, output: new PassThrough() });
    const lines = new LineSource(rl, new PassThrough());
    input.write("\n"); // pressed while a seat was working
    await new Promise((r) => setTimeout(r, 10));
    const question = lines.ask("allow? ", false);
    let answered: string | null | undefined;
    void question.then((a) => (answered = a));
    await new Promise((r) => setTimeout(r, 10));
    expect(answered).toBeUndefined();
    input.write("d\n");
    expect(await question).toBe("d");
    // The typed-ahead line is still there for the human's own prompt.
    expect(await lines.ask("Corina> ")).toBe("");
    rl.close();
  });

  it("2: a seat still sees what a background seat posted during its turn", async () => {
    const g = gate();
    const { room, fakes } = await openRoom({
      a: [async () => (await g.wait(), "background result")],
      b: [
        async () => {
          g.open();
          await room.background.get("a");
          return "b's reply";
        },
        "second",
      ],
    });
    room.startBackground("a", "the job");
    await room.say("@b go");
    await room.say("@b and now?");
    expect(fakes.get("b")!.prompts[1]).toContain("[a]: background result");
    await room.stop();
  });

  it("3: always-allow makes rules from kinds only, and a kind rule never matches a title", async () => {
    const rules: string[] = [];
    const logs: string[] = [];
    const decide = makeDecider({
      policyFor: () => ({ allow: [], ask: [], deny: [] }),
      askHuman: async () => "allow_always",
      onAllowAlways: (_s, p) => rules.push(p),
      log: (l) => logs.push(l),
    });
    const opts = [{ optionId: "y", name: "Allow", kind: "allow_once" as const }];
    await decide({ seat: "g", sessionId: "s", toolCallId: "t", title: "rm -f *.log", options: opts });
    await decide({ seat: "g", sessionId: "s", toolCallId: "t", title: "Edit x", kind: "edit", options: opts });
    expect(rules).toEqual(["edit"]);
    expect(logs[0]).toMatch(/allowed once: "rm -f \*\.log" has no tool kind/);
    expect(hit(["read"], { kind: "execute", title: "read" })).toBe(false);
    expect(hit(["read"], { kind: "read", title: "anything" })).toBe(true);
    expect(hit(["Bash rm *"], { kind: "execute", title: "Bash rm -rf x" })).toBe(true);
  });

  it("4: a second keypress cannot take the next question off the TUI's queue", async () => {
    const s = new TuiStore();
    const req = (seat: string) => ({ seat, sessionId: "s", toolCallId: "t", title: "Edit", options: [] });
    const first = s.ask(req("a"));
    void s.ask(req("b"));
    const stale = s.asks[0];
    stale.resolve("allow");
    stale.resolve("allow");
    expect(await first).toBe("allow");
    expect(s.asks.map((a) => a.req.seat)).toEqual(["b"]);
  });

  it("5: a cancel during the git work before a turn stops that turn from starting", async () => {
    const { room, fakes, cwd } = await openRoom(
      { a: ["should not run"] },
      { onStatus: (l, r) => /Corina committed/.test(l) && void r.cancel() },
    );
    writeFileSync(join(cwd, "f.txt"), "the human's edit\n");
    const r = await room.say("go");
    expect(r.cancelled).toBe(true);
    expect(fakes.get("a")!.prompts).toEqual([]);
    await room.stop();
  });

  it("7: a turn given up on cannot read the next turn's updates", async () => {
    const seat = new AcpSeat(fakeAcpSeat("f"), async () => "cancel");
    await seat.start();
    await seat.newSession(mkdtempSync(join(tmpdir(), "room-fix-")));
    const stale = seat.prompt(">> sleep 3000")[Symbol.asyncIterator]();
    void stale.next();
    await new Promise((r) => setTimeout(r, 200));
    let text = "";
    for await (const ev of seat.prompt(">> say fresh words here")) if (ev.type === "text") text += ev.text;
    expect(text.trim()).toBe("fresh words here");
    await seat.stop();
  }, 20_000);

  it("8: a resumed seat keeps its modes, so the room can put it back in the asking one", async () => {
    const state = mkdtempSync(join(tmpdir(), "room-fix-"));
    dirs.push(state);
    const cwd = mkdtempSync(join(tmpdir(), "room-fix-"));
    dirs.push(cwd);
    const first = new AcpSeat(fakeAcpSeat("f", ["--modes", "--resume"], state), async () => "cancel");
    await first.start();
    const sid = await first.newSession(cwd);
    await first.stop();
    const second = new AcpSeat(fakeAcpSeat("f", ["--modes", "--resume"], state), async () => "cancel");
    await second.start();
    expect(await second.resumeSession(sid, cwd)).toBe(true);
    expect(second.modes?.available.map((m) => m.id)).toEqual(["default", "auto", "acceptEdits"]);
    await second.stop();
  }, 20_000);

  it("9: a character split across two chunks arrives whole", async () => {
    const f = strayFilter(() => {});
    const out: string[] = [];
    f.on("data", (c: Buffer) => out.push(c.toString()));
    const line = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "x", params: { t: "a…b" } }) + "\n");
    const cut = line.indexOf(Buffer.from("…")) + 1;
    f.write(line.subarray(0, cut));
    f.write(line.subarray(cut));
    f.end();
    await new Promise((r) => f.on("end", r));
    expect(out.join("")).toContain("a…b");
  });

  it("10: /quit does not wait on a background seat that ignores cancel", async () => {
    const { room } = await openRoom({ a: [() => new Promise<string>(() => {})], b: [] }, { ignoreCancel: "a" });
    expect(room.startBackground("a", "hang forever")).toBe(true);
    // Let the turn reach the seat before quitting.
    await new Promise((r) => setTimeout(r, 300));
    expect(room.background.has("a")).toBe(true);
    const started = Date.now();
    await room.stop();
    expect(Date.now() - started).toBeLessThan(8000);
  }, 20_000);
});
