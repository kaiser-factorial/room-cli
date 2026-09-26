/**
 * The moderator: a limit trips, and a model (or the human) decides whether
 * the move goes through.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HumanModerator, moderatorFor, OpenRouterModerator, parseVerdict, type LimitCase, type Moderator, type Verdict } from "../src/moderator.js";
import { Room, type RoomUI } from "../src/room.js";
import type { Seat, SeatConfig, SeatEvent } from "../src/seat/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

class ScriptSeat implements Seat {
  readonly name: string;
  prompts: string[] = [];
  constructor(
    readonly config: SeatConfig,
    private readonly script: string[],
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
    yield { type: "text", text: this.script.shift() ?? "[pass]" };
    yield { type: "stop", stopReason: "end_turn" };
  }
  async cancel() {}
  async stop() {}
  stderrTail() {
    return "";
  }
}

class FakeModerator implements Moderator {
  readonly label = "fake";
  cases: LimitCase[] = [];
  constructor(private readonly answer: (c: LimitCase) => Omit<Verdict, "by">) {}
  async decide(c: LimitCase): Promise<Verdict> {
    this.cases.push(c);
    return { ...this.answer(c), by: "fake" };
  }
}

async function openRoom(scripts: Record<string, string[]>, moderator?: Moderator) {
  const cwd = mkdtempSync(join(tmpdir(), "room-mod-"));
  dirs.push(cwd);
  const lines: string[] = [];
  const ui: RoomUI = { seatEvent() {}, askHuman: async () => "deny", status: (l) => lines.push(l) };
  const fakes = new Map<string, ScriptSeat>();
  const room = await Room.open({
    name: "mod",
    cwd,
    seats: Object.keys(scripts).map((name) => ({ name, adapter: "acp" as const, command: "x" })),
    human: "Corina",
    ui,
    git: false,
    moderator,
    makeSeat: (c) => {
      const f = new ScriptSeat(c, scripts[c.name]);
      fakes.set(c.name, f);
      return f;
    },
  });
  await room.start();
  return { room, fakes, lines };
}

const long = (who: string, n = 30) => Array.from({ length: n }, (_, i) => `${"real analysis ".repeat(30)}${i}\n@${who} your turn`);
const seatTurns = (room: Room) => room.transcript.entries.filter((e) => e.kind === "message" && e.from !== "Corina").length;

describe("parseVerdict", () => {
  it("takes the first JSON object, and refuses anything else", () => {
    expect(parseVerdict('Sure: {"verdict":"nudge","reason":"drifting","note":"say something new"}', "m")).toEqual({
      verdict: "nudge",
      reason: "drifting",
      note: "say something new",
      by: "m",
    });
    expect(parseVerdict('{"verdict":"allow","reason":"fine","note":"ignored"}', "m").note).toBeUndefined();
    expect(() => parseVerdict("allow", "m")).toThrow(/no JSON/);
    expect(() => parseVerdict('{"verdict":"maybe"}', "m")).toThrow(/bad verdict/);
  });
});

describe("OpenRouterModerator", () => {
  const c: LimitCase = { kind: "cap", from: "a", to: "b", detail: "6 wakes (cap 6)", recent: "[a]: hi" };

  it("asks the model on OpenRouter and reads its verdict", async () => {
    let sent: { url: string; init: RequestInit } | undefined;
    const fetch = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"allow","reason":"converging on the fix"}' } }] }));
    }) as unknown as typeof globalThis.fetch;
    const m = new OpenRouterModerator({ apiKey: "k", model: "some/model", fallback: new HumanModerator(), fetch });
    expect(await m.decide(c)).toEqual({ verdict: "allow", reason: "converging on the fix", note: undefined, by: "some/model" });
    expect(sent!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((sent!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    const body = JSON.parse(String(sent!.init.body));
    expect(body.model).toBe("some/model");
    expect(body.messages[1].content).toContain("a is waking b");
  });

  it("falls back to the human when the model cannot answer, and says so", async () => {
    const errors: string[] = [];
    const fetch = (async () => new Response("down", { status: 502 })) as unknown as typeof globalThis.fetch;
    const human = new HumanModerator(async () => true);
    const m = new OpenRouterModerator({ apiKey: "k", model: "some/model", fallback: human, fetch, onError: (l) => errors.push(l) });
    expect(await m.decide(c)).toMatchObject({ verdict: "allow", by: "human" });
    expect(errors[0]).toMatch(/some\/model could not answer \(HTTP 502\); asking you/);
  });
});

describe("moderatorFor", () => {
  it("auto uses OpenRouter with a key, else you; a model needs a key; off is none", () => {
    expect(moderatorFor("auto", { env: {} })?.label).toBe("you");
    expect(moderatorFor("auto", { env: { OPENROUTER_API_KEY: "k" } })?.label).toBe("anthropic/claude-haiku-4.5");
    expect(moderatorFor("auto", { env: { OPENROUTER_API_KEY: "k", ROOM_MODERATOR_MODEL: "x/y" } })?.label).toBe("x/y");
    expect(moderatorFor("off", { env: {} })).toBeUndefined();
    expect(() => moderatorFor("x/y", { env: {} })).toThrow(/needs OPENROUTER_API_KEY/);
  });

  it("you, with no way to ask, holds", async () => {
    expect(await new HumanModerator().decide({ kind: "cap", from: "a", to: "b", detail: "", recent: "" })).toMatchObject({ verdict: "hold" });
  });
});

describe("the room with a moderator", () => {
  it("a limit the moderator allows goes through, with headroom, up to the hard ceiling", async () => {
    const mod = new FakeModerator(() => ({ verdict: "allow", reason: "real work" }));
    const { room, lines } = await openRoom({ a: long("b"), b: long("a") }, mod);
    room.setCap(2);
    await room.say("@a go");
    // Cap 2, three times over at most: 6 seat-to-seat wakes, plus a's first turn.
    expect(seatTurns(room)).toBe(7);
    expect(mod.cases.length).toBe(2);
    expect(mod.cases[0]).toMatchObject({ kind: "cap", from: "a", to: "b" });
    expect(mod.cases[0].recent).toContain("[Corina]: go");
    expect(lines).toContain("moderator (fake): allow a → b: real work");
    expect(lines.some((l) => /the most even a moderator can allow/.test(l))).toBe(true);
    expect(room.transcript.entries.some((e) => e.from === "room" && e.text === "moderator (fake): allow a → b: real work")).toBe(true);
  });

  it("a hold stops the thread as before, and says how to go on", async () => {
    const mod = new FakeModerator(() => ({ verdict: "hold", reason: "going in circles" }));
    const { room, lines } = await openRoom({ a: long("b"), b: long("a") }, mod);
    room.setCap(2);
    await room.say("@a go");
    expect(seatTurns(room)).toBe(3);
    expect(lines).toContain("moderator (fake): hold a → b: going in circles (/cap +10 or @b to go on)");
  });

  it("an echo the moderator nudges goes on, and both seats are told", async () => {
    const mod = new FakeModerator((c) => (c.kind === "echo" ? { verdict: "nudge", reason: "drifting", note: "bring a concrete proposal" } : { verdict: "hold", reason: "enough" }));
    const ping = Array.from({ length: 12 }, () => "@b your turn");
    const pong = Array.from({ length: 12 }, () => "@a no, yours");
    const { room, fakes } = await openRoom({ a: ping, b: pong }, mod);
    await room.say("@a go");
    expect(mod.cases[0]).toMatchObject({ kind: "echo", from: "b", to: "a" });
    expect(seatTurns(room)).toBeGreaterThan(4);
    expect(fakes.get("a")!.prompts.some((p) => p.includes("[room]: The moderator says: bring a concrete proposal"))).toBe(true);
  });
});
