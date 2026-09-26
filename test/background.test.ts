/**
 * Background turns: a seat works in its desk while the room goes on.
 * In-process seats whose replies wait on gates, in a real repo with desks.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { Room, type RoomUI } from "../src/room.js";
import type { Seat, SeatConfig, SeatEvent } from "../src/seat/types.js";
import { LineSource } from "../src/ui/repl.js";

type Reply = string | ((prompt: string, cancelled: Promise<void>) => Promise<string>);

class GateSeat implements Seat {
  readonly name: string;
  prompts: string[] = [];
  private cancelNow?: () => void;
  constructor(
    readonly config: SeatConfig,
    private readonly replies: Reply[],
  ) {
    this.name = config.name;
  }
  async start() {
    return { loadSession: false, authMethods: [] };
  }
  async newSession() {
    return `${this.name}-s`;
  }
  async *prompt(text: string): AsyncIterable<SeatEvent> {
    this.prompts.push(text);
    const next = this.replies.shift() ?? "[pass]";
    let stopped = false;
    const cancelled = new Promise<void>((r) => (this.cancelNow = () => ((stopped = true), r())));
    const reply = typeof next === "function" ? await Promise.race([next(text, cancelled), cancelled.then(() => "")]) : next;
    if (stopped) {
      yield { type: "stop", stopReason: "cancelled" };
      return;
    }
    yield { type: "tool_call", id: "t1", title: "Read File", kind: "read", status: "completed" };
    yield { type: "text", text: reply };
    yield { type: "stop", stopReason: "end_turn" };
  }
  async cancel() {
    this.cancelNow?.();
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
  const cwd = mkdtempSync(join(tmpdir(), "room-bg-"));
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

async function openRoom(scripts: Record<string, Reply[]>, git = true) {
  const cwd = git ? repo() : mkdtempSync(join(tmpdir(), "room-bg-"));
  if (!git) dirs.push(cwd);
  const lines: string[] = [];
  const fg: string[] = [];
  const bg: string[] = [];
  const ui: RoomUI = {
    seatEvent: (seat, ev) => ev.type === "text" && fg.push(`${seat}:${ev.text}`),
    backgroundEvent: (seat, ev) => ev.type !== "stop" && bg.push(`${seat}:${ev.type}`),
    askHuman: async () => "deny",
    status: (l) => lines.push(l),
  };
  const fakes = new Map<string, GateSeat>();
  const seats: SeatConfig[] = Object.keys(scripts).map((name) => ({ name, adapter: "acp", command: "fake" }));
  const room = await Room.open({
    wake: "all",
    name: "bg",
    cwd,
    seats,
    human: "Corina",
    ui,
    git: git ? undefined : false,
    makeSeat: (config) => {
      const f = new GateSeat(config, scripts[config.name]);
      fakes.set(config.name, f);
      return f;
    },
  });
  await room.start();
  return { room, fakes, lines, fg, bg };
}

describe("background turns", () => {
  it("/bg: the seat leaves the rotation, the room goes on, and its reply lands when it finishes", async () => {
    const g = gate();
    const { room, fakes, lines, fg, bg } = await openRoom({
      a: [async () => (await g.wait(), "built the parser")],
      b: ["b one"],
    });
    expect(room.startBackground("a", "build the parser")).toBe(true);
    const run = room.background.get("a")!;
    await room.say("meanwhile");
    expect(fakes.get("a")!.prompts.length).toBe(1);
    expect(fakes.get("a")!.prompts[0]).toContain("[room]: You are working in the background on: build the parser");
    expect(fg).toEqual(["b:b one"]);
    expect(room.activeSeats()).toEqual(["b"]);
    g.open();
    await run;
    // Shown live through the background channel, never as the active reply.
    expect(bg).toEqual(["a:tool_call", "a:text"]);
    expect(lines).toContain("a finished its background work");
    const said = room.transcript.entries.filter((e) => e.kind === "message").map((e) => `${e.from}: ${e.text}`);
    expect(said).toEqual(["Corina: @a (in the background) build the parser", "Corina: meanwhile", "b: b one", "a: built the parser"]);
    expect(room.activeSeats()).toEqual(["a", "b"]);
    await room.stop();
  });

  it("a seat sends itself to the background by ending its reply with [background] <task>", async () => {
    const g = gate();
    const { room, fakes, lines } = await openRoom({
      a: ["on it\n[background] run the full test suite", async () => (await g.wait(), "suite green")],
      b: ["noted"],
    });
    await room.say("go");
    const run = room.background.get("a");
    expect(run).toBeDefined();
    expect(lines).toContain("a is working in the background: run the full test suite (/stop a to cancel)");
    g.open();
    await run;
    expect(fakes.get("a")!.prompts[1]).toContain("You are working in the background on: run the full test suite");
    const said = room.transcript.entries.filter((e) => e.kind === "message" || e.kind === "system").map((e) => `${e.from}: ${e.text}`);
    expect(said.slice(-4)).toEqual([
      "a: on it\n[background] run the full test suite",
      "room: a went on working in the background: run the full test suite",
      "b: noted",
      "a: suite green",
    ]);
    await room.stop();
  });

  it("skips hand-offs to a background seat, and says so when the human addresses it", async () => {
    const g = gate();
    const { room, lines } = await openRoom({ a: [async () => (await g.wait(), "done")], b: ["@a what do you think?"] });
    room.startBackground("a", "long job");
    await room.say("hello");
    expect(lines).toContain("b → a, but a is working in the background; it reads this when it finishes");
    await room.say("@a are you there?");
    expect(lines).toContain("a is working in the background; it reads this when it finishes (@a! to interrupt)");
    g.open();
    await room.background.get("a");
    await room.stop();
  });

  it("/stop cancels it and keeps the half-done work on the desk, unlanded", async () => {
    const { room, lines } = await openRoom({ a: [async (_p, cancelled) => (await cancelled, "")], b: [] });
    room.startBackground("a", "endless");
    expect(await room.stopBackground("a")).toBe(true);
    expect(lines.some((l) => /^a's background work was stopped; what it did is on its desk \(\/land a/.test(l))).toBe(true);
    expect(room.background.size).toBe(0);
    await room.stop();
  });

  it("refuses without desks: the seat would be editing the directory everyone shares", async () => {
    const { room, lines } = await openRoom({ a: [], b: [] }, false);
    expect(room.startBackground("a", "x")).toBe(false);
    expect(lines.at(-1)).toMatch(/^background work needs desks/);
    await room.stop();
  });
});

describe("interrupts", () => {
  it("@seat! cuts a turn short: the seat is told, answers first, and its cut reply wakes nobody", async () => {
    const { room, fakes, lines } = await openRoom(
      { a: [async (_p, cancelled) => (await cancelled, ""), "a answering the interrupt"], b: ["b after"], c: ["c never"] },
      false,
    );
    const first = room.say("@a @b go");
    await new Promise((r) => setTimeout(r, 20));
    await room.say("@a! stop, wrong file");
    await first;
    expect(lines).toContain("a is interrupted to read this now");
    const said = room.transcript.entries.filter((e) => e.kind !== "commit").map((e) => `${e.from}: ${e.text}`);
    expect(said.slice(-5)).toEqual([
      "Corina: go",
      "Corina: stop, wrong file",
      "room: a was interrupted by Corina.",
      "a: a answering the interrupt",
      "b: b after",
    ]);
    expect(fakes.get("a")!.prompts[1]).toContain("[room]: Corina interrupted your last turn");
    expect(fakes.get("c")!.prompts.length).toBe(0);
    await room.stop();
  });
});

describe("LineSource", () => {
  it("puts a question on top of the prompt already waiting, and answers each in turn", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rl = createInterface({ input, output });
    const lines = new LineSource(rl, output);
    const human = lines.ask("Corina> ");
    const question = lines.ask("allow? ");
    input.write("a\n");
    expect(await question).toBe("a");
    input.write("hello room\n");
    expect(await human).toBe("hello room");
    rl.close();
  });
});
