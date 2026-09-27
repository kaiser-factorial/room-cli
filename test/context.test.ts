/** Seats' context: what it holds, compacting it, and bringing in a session made outside the room. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contextLine, runCommand } from "../src/commands.js";
import { Room, type RoomUI } from "../src/room.js";
import type { Seat, SeatConfig, SeatEvent } from "../src/seat/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

class StubSeat implements Seat {
  readonly name: string;
  prompts: string[] = [];
  usage? = { used: 150_000, size: 200_000 };
  commands = [
    { name: "compact", description: "Compact the conversation" },
    { name: "context", description: "Show context use" },
  ];
  sid?: string;
  calls: string[] = [];
  constructor(
    readonly config: SeatConfig,
    private readonly canFork = true,
  ) {
    this.name = config.name;
  }
  get sessionId() {
    return this.sid;
  }
  async start() {
    return { loadSession: true, authMethods: [] };
  }
  async newSession() {
    this.calls.push("new");
    return (this.sid = `${this.name}-fresh`);
  }
  async resumeSession(id: string) {
    this.calls.push(`resume ${id}`);
    this.sid = id;
    return true;
  }
  async forkSession(id: string) {
    this.calls.push(`fork ${id}`);
    return this.canFork ? (this.sid = `${id}-copy`) : undefined;
  }
  async *prompt(text: string): AsyncIterable<SeatEvent> {
    this.prompts.push(text);
    if (text.startsWith("/compact")) {
      this.usage = { used: 30_000, size: 200_000 };
      yield { type: "text", text: "Compacted." };
    } else yield { type: "text", text: "hi" };
    yield { type: "stop", stopReason: "end_turn" };
  }
  async cancel() {}
  async stop() {}
  stderrTail() {
    return "";
  }
}

async function open(seats: SeatConfig[], canFork = true) {
  const cwd = mkdtempSync(join(tmpdir(), "room-ctx-"));
  dirs.push(cwd);
  const lines: string[] = [];
  const stubs = new Map<string, StubSeat>();
  const ui: RoomUI = { seatEvent() {}, askHuman: async () => "deny", status: (l) => lines.push(l) };
  const room = await Room.open({
    name: "ctx",
    cwd,
    seats,
    human: "Corina",
    ui,
    git: false,
    tools: false,
    makeSeat: (c) => {
      const s = new StubSeat(c, canFork);
      stubs.set(c.name, s);
      return s;
    },
  });
  await room.start();
  return { room, stubs, lines };
}

const seat = (name: string, extra: Partial<SeatConfig> = {}): SeatConfig => ({ name, adapter: "acp", command: name, ...extra });

describe("context", () => {
  it("/context shows each seat's use; /compact sends the seat's own command, not a room message", async () => {
    const { room, stubs } = await open([seat("claude"), seat("grok")]);
    stubs.get("grok")!.usage = undefined;
    const out: string[] = [];
    await runCommand(room, "/context", (l) => out.push(l));
    expect(out).toEqual(["  claude   75% (150k of 200k)", "  grok     not reported by its harness"]);
    out.length = 0;
    await runCommand(room, "/compact claude keep the adapter findings", (l) => out.push(l));
    expect(stubs.get("claude")!.prompts).toEqual(["/compact keep the adapter findings"]);
    expect(out).toContain("  claude: 75% (150k of 200k) → 15% (30k of 200k)");
    const said = room.transcript.entries.map((e) => `${e.from}: ${e.text}`);
    expect(said.at(-1)).toBe("room: Corina ran /compact keep the adapter findings on claude.");
    // The seat's next real turn still gets the room's preamble.
    await room.say("@claude hello");
    expect(stubs.get("claude")!.prompts[1]).toContain("hello");
    await room.stop();
  });

  it("/cmd refuses a command the seat does not offer, and lists what it does", async () => {
    const { room } = await open([seat("claude")]);
    const out: string[] = [];
    await runCommand(room, "/cmd claude /model opus", (l) => out.push(l));
    expect(out.at(-1)).toBe("  claude has no /model; it offers /compact, /context");
    out.length = 0;
    await runCommand(room, "/cmd claude", (l) => out.push(l));
    expect(out[0]).toContain("/compact");
    await room.stop();
  });

  it("contextLine", () => {
    expect(contextLine({ used: 500, size: 1000 })).toBe("50% (500 of 1k)");
    expect(contextLine(undefined)).toBe("not reported by its harness");
  });
});

describe("bringing in a session", () => {
  it("forks by default, so the original is untouched", async () => {
    const { room, stubs, lines } = await open([seat("claude", { session: "abc", fork: true })]);
    expect(stubs.get("claude")!.calls).toEqual(["fork abc"]);
    expect(room.state.sessions.claude).toBe("abc-copy");
    expect(lines.some((l) => l.includes("brought in session abc as a copy"))).toBe(true);
    await room.stop();
  });

  it("opens it in place when asked, or when the harness cannot copy", async () => {
    const a = await open([seat("claude", { session: "abc", fork: false })]);
    expect(a.stubs.get("claude")!.calls).toEqual(["resume abc"]);
    await a.room.stop();
    const b = await open([seat("grok", { session: "g1", fork: true })], false);
    expect(b.stubs.get("grok")!.calls).toEqual(["fork g1", "resume g1"]);
    expect(b.lines.some((l) => l.includes("cannot copy a session"))).toBe(true);
    await b.room.stop();
  });
});
