import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_HANDOFFS, Room, type RoomUI } from "../src/room.js";
import { scanMentions } from "../src/scheduler.js";
import type { PermissionDecider, PermissionRequestView, Seat, SeatConfig, SeatEvent } from "../src/seat/types.js";

let dir: string;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

type Reply = string | ((prompt: string) => string | Promise<string>);

class ScriptSeat implements Seat {
  readonly name: string;
  prompts: string[] = [];
  constructor(
    readonly config: SeatConfig,
    private readonly script: Reply[],
    readonly decide?: PermissionDecider,
  ) {
    this.name = config.name;
  }
  async start() {
    return { loadSession: true, authMethods: [] };
  }
  async newSession() {
    return `${this.name}-s`;
  }
  async *prompt(text: string): AsyncIterable<SeatEvent> {
    this.prompts.push(text);
    const next = this.script.shift() ?? "[pass]";
    let reply = typeof next === "function" ? await next(text) : next;
    if (reply.startsWith("ASK:") && this.decide) {
      const answer = await this.decide({
        seat: this.name,
        sessionId: "s",
        toolCallId: "t",
        title: reply.slice(4),
        kind: "edit",
        options: [
          { optionId: "y", name: "Allow", kind: "allow_once" },
          { optionId: "n", name: "Deny", kind: "reject_once" },
        ],
      });
      reply = answer === "y" ? "edited" : "edit refused";
    }
    for (const word of reply.split(" ")) yield { type: "text", text: word + " " };
    yield { type: "stop", stopReason: "end_turn" };
  }
  async cancel() {}
  async stop() {}
  stderrTail() {
    return "";
  }
}

function makeUI(answers: Array<"allow" | "deny"> = []) {
  const ui: RoomUI & { asked: PermissionRequestView[]; lines: string[]; events: Array<[string, string]> } = {
    asked: [],
    lines: [],
    events: [],
    seatEvent(seat, ev) {
      this.events.push([seat, ev.type]);
    },
    async askHuman(req) {
      this.asked.push(req);
      return answers.shift() ?? "deny";
    },
    status(line) {
      this.lines.push(line);
    },
  };
  return ui;
}

const cfg = (name: string): SeatConfig => ({ name, adapter: "acp", command: "x" });

async function openRoom(scripts: Record<string, Reply[]>, ui = makeUI(), mode: "sequential" | "parallel" = "sequential") {
  dir = mkdtempSync(join(tmpdir(), "room-p3-"));
  const seats = Object.keys(scripts).map(cfg);
  const fakes = new Map<string, ScriptSeat>();
  const room = await Room.open({
    name: "p3",
    cwd: dir,
    seats,
    human: "Corina",
    ui,
    git: false,
    mode,
    makeSeat: (c, decide) => {
      const f = new ScriptSeat(c, scripts[c.name], decide);
      fakes.set(c.name, f);
      return f;
    },
  });
  await room.start();
  return { room, fakes, ui };
}

const speakers = (room: Room) => room.transcript.entries.filter((e) => e.kind !== "system").map((e) => `${e.from}:${e.kind}`);

describe("scanMentions", () => {
  it("finds known names anywhere, ignores code and glued @, keeps first-seen order", () => {
    const names = ["grok", "claude", "Corina"];
    expect(scanMentions("I agree. @Grok what do you think? cc @claude", names)).toEqual(["grok", "claude"]);
    expect(scanMentions("email me@grok.com and `@claude` in code\n```\n@grok\n```\n", names)).toEqual([]);
    expect(scanMentions("(@corina) over to you", names)).toEqual(["Corina"]);
    expect(scanMentions("@nobody here", names)).toEqual([]);
  });
});

describe("hand-offs", () => {
  it("a seat addressing another puts it next, ahead of the rest of the round", async () => {
    const { room } = await openRoom({ a: ["@c what do you think?"], b: ["b here"], c: ["c answering a"] });
    await room.say("go");
    expect(speakers(room)).toEqual(["Corina:message", "a:message", "c:message", "b:message"]);
  });

  it("addressing the human ends the round", async () => {
    const { room, ui } = await openRoom({ a: ["@Corina your call"], b: ["should not run"] });
    await room.say("go");
    expect(speakers(room)).toEqual(["Corina:message", "a:message"]);
    expect(ui.lines).toContain("a handed back to Corina; round ends");
  });

  it("two seats volleying stop at the hand-off limit", async () => {
    const forever = Array.from({ length: 20 }, () => "@b your turn");
    const back = Array.from({ length: 20 }, () => "@a no, yours");
    const { room, ui } = await openRoom({ a: forever, b: back });
    await room.say("go");
    const turns = room.transcript.entries.filter((e) => e.kind === "message" && e.from !== "Corina").length;
    // Both seats take their round turn, then at most MAX_HANDOFFS extra turns.
    expect(turns).toBe(2 + MAX_HANDOFFS);
    expect(ui.lines.some((l) => l.startsWith("hand-off limit"))).toBe(true);
  });

  it("the limit resets when the human speaks again", async () => {
    const forever = Array.from({ length: 40 }, () => "@b your turn");
    const back = Array.from({ length: 40 }, () => "@a no, yours");
    const { room, ui } = await openRoom({ a: forever, b: back });
    await room.say("first");
    await room.say("second");
    // Each human message got its own full allowance before the limit hit.
    expect(ui.lines.filter((l) => l.startsWith("hand-off limit")).length).toBe(2);
    const turns = room.transcript.entries.filter((e) => e.kind === "message" && e.from !== "Corina").length;
    expect(turns).toBe(2 * (2 + MAX_HANDOFFS));
  });
});

describe("passing", () => {
  it("a seat that passed is skipped on an empty continue until something new is said", async () => {
    const { room, fakes, ui } = await openRoom({ a: ["[pass]", "a now has something"], b: ["b speaks", "[pass]", "[pass]"] });
    await room.say("go"); // a passes, b speaks
    expect(speakers(room)).toEqual(["Corina:message", "a:pass", "b:message"]);
    await room.continueRound(); // b said something after a's pass, so a runs; b runs too
    expect(fakes.get("a")!.prompts.length).toBe(2);
    expect(speakers(room).slice(-2)).toEqual(["a:message", "b:pass"]);
    await room.continueRound(); // a spoke after b's pass, so b runs and passes again; a has nothing new? a spoke last, so a runs
    await room.continueRound(); // now both passed with nothing new
    expect(ui.lines.at(-1)).toMatch(/everyone passed/);
  });
});

describe("parallel mode", () => {
  it("every seat answers the same snapshot, then sees the others next round", async () => {
    const ui = makeUI();
    const { room, fakes } = await openRoom({ a: ["a first", "a second"], b: ["b first", "b second"] }, ui, "parallel");
    await room.say("hello");
    expect(fakes.get("a")!.prompts[0]).not.toContain("[b]:");
    expect(fakes.get("b")!.prompts[0]).not.toContain("[a]:");
    expect(fakes.get("b")!.prompts[0]).toContain("Parallel discussion round");
    expect(speakers(room)).toEqual(["Corina:message", "a:message", "b:message"]);
    await room.continueRound();
    expect(fakes.get("a")!.prompts[1]).toContain("[b]: b first");
    expect(fakes.get("b")!.prompts[1]).toContain("[a]: a first");
    // UI events are replayed per seat, never interleaved.
    const order = ui.events.map(([s]) => s).join("");
    expect(order).toMatch(/^a+b+a+b+$/);
  });

  it("refuses edits without asking the human, and allows them again in sequential mode", async () => {
    const ui = makeUI(["allow"]);
    const { room } = await openRoom({ a: ["ASK:Write x.ts", "ASK:Write y.ts"] }, ui, "parallel");
    await room.say("edit something");
    expect(ui.asked.length).toBe(0);
    expect(room.transcript.entries.at(-1)?.text).toBe("edit refused");
    expect(ui.lines).toContain("[a] deny by room: Write x.ts");
    room.setRoomMode("sequential");
    await room.say("try again");
    expect(ui.asked.length).toBe(1);
    expect(room.transcript.entries.at(-1)?.text).toBe("edited");
  });

  it("hand-offs from a parallel batch run afterwards", async () => {
    const { room, fakes } = await openRoom({ a: ["@c please", "a done"], b: ["b", "b done"], c: ["c replying"] }, makeUI(), "parallel");
    await room.say("@a @b go");
    expect(speakers(room)).toEqual(["Corina:message", "a:message", "b:message", "c:message"]);
    // c was handed the batch's replies, a's included.
    expect(fakes.get("c")!.prompts[0]).toContain("[a]: @c please");
  });
});
