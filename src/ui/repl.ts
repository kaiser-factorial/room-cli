/**
 * The v0 interface: a streaming REPL. Seat replies stream with a speaker
 * prefix, permission prompts are answered inline, and slash commands change
 * modes and policy mid-session.
 *
 * Input goes through a line queue rather than readline's `question`, so
 * lines typed (or piped) while a turn is running are kept, not dropped.
 */
import readline from "node:readline";
import type { HumanChoice } from "../permissions.js";
import { COMMAND_HELP, runCommand } from "../commands.js";
import type { Room, RoomUI } from "../room.js";
import type { PermissionRequestView, SeatEvent, ToolContentView } from "../seat/types.js";
import { seatColour } from "./colours.js";
import { renderToolContent } from "./render.js";
import { ToolView } from "./tools.js";

export type ThoughtMode = "brief" | "full" | "off";
const THOUGHT_BRIEF = 110;

export const HELP = `commands:
  <text>                 say something; every seat answers in order
  @seat <text>           say something to one seat (several: @a @b)
  <empty line> or /next  another round with no new message
  /thoughts [brief|full|off]  seats' thinking: a line per stretch (default), all of it, or none
  /show [n|seat]         a tool call in full: #n from its line, a seat's latest, or the latest
  /verbose [on|off]      tool calls in full as they stream, or one line each (default)
${COMMAND_HELP}
  /quit`;

/**
 * Seat text goes to the terminal raw, so a seat could emit escape sequences
 * that retitle the window, move the cursor, or hide text. Strip them, and
 * every control character except newline and tab.
 */
export function sanitizeForTerminal(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "") // OSC ... BEL or ST
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
    .replace(/\u001b[@-Z\\-_]/g, "") // other two-byte escapes
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

/** Queued lines from a readline interface. `ask` resolves null when stdin closes. */
export class LineSource {
  private queue: string[] = [];
  /**
   * Prompts on screen, innermost last. A permission question from a seat
   * working in the background can arrive while the human's own prompt is
   * up: it goes on top, and when answered the prompt beneath comes back
   * with whatever had been typed into it.
   */
  private readonly stack: Array<{ prompt: string; resolve: (line: string | null) => void; typed?: string }> = [];
  private closed = false;

  constructor(
    private readonly rl: readline.Interface,
    private readonly out: NodeJS.WritableStream = process.stdout,
  ) {
    rl.on("line", (line) => {
      const top = this.stack.pop();
      if (!top) {
        this.queue.push(line);
        return;
      }
      top.resolve(line);
      const below = this.stack.at(-1);
      if (below) {
        this.rl.setPrompt(below.prompt);
        this.rl.prompt();
        if (below.typed) this.rl.write(below.typed);
        below.typed = undefined;
      }
    });
    rl.on("close", () => {
      this.closed = true;
      for (const p of this.stack.splice(0)) p.resolve(null);
    });
  }

  /**
   * `typedAhead`: whether a line typed earlier may answer. Yes for the
   * human's own prompt; never for a seat's question, which must be answered
   * by a line typed after it was shown.
   */
  ask(prompt: string, typedAhead = true): Promise<string | null> {
    if (typedAhead && this.queue.length && this.stack.length === 0) {
      const line = this.queue.shift()!;
      this.out.write(`${prompt}${line}\n`);
      return Promise.resolve(line);
    }
    if (this.closed) return Promise.resolve(null);
    const below = this.stack.at(-1);
    if (below) {
      // Keep what was typed below, and clear it from the line for the question on top.
      if (this.rl.terminal) {
        below.typed = this.rl.line;
        this.rl.write(null, { ctrl: true, name: "e" });
        this.rl.write(null, { ctrl: true, name: "u" });
        readline.cursorTo(this.out, 0);
        readline.clearLine(this.out, 0);
      }
    }
    return new Promise((resolve) => {
      this.stack.push({ prompt, resolve });
      this.rl.setPrompt(prompt);
      this.rl.prompt();
    });
  }

  /** Whether a prompt is on screen, waiting for the human. */
  get prompting(): boolean {
    return this.stack.length > 0;
  }

  /**
   * Write output. While a prompt is on screen, something arriving late (a
   * seat's notice, a status) would land after it and leave the cursor on an
   * empty line; so clear the prompt, write whole lines, and draw the prompt
   * again with whatever was typed so far. Returns true when it did that.
   */
  write(text: string): boolean {
    if (!this.prompting) {
      this.out.write(text);
      return false;
    }
    readline.cursorTo(this.out, 0);
    readline.clearLine(this.out, 0);
    this.out.write(text.endsWith("\n") ? text : text + "\n");
    this.rl.prompt(true);
    return true;
  }
}

/** Seat name colours, assigned in order of first appearance. */
const SEAT_COLOURS = [36, 35, 33, 32, 34, 91, 96, 95];

/** ANSI styling, on only for a terminal and never with NO_COLOR set. */
export function makeStyle(enabled: boolean) {
  const wrap = (open: string, close: string) => (t: string) => (enabled ? `\u001b[${open}m${t}\u001b[${close}m` : t);
  return {
    enabled,
    bold: wrap("1", "22"),
    dim: wrap("2", "22"),
    colour: (code: number) => wrap(`1;${code}`, "22;39"),
    /** A 256-colour palette entry, bold. */
    palette: (index: number) => wrap(`1;38;5;${index}`, "22;39"),
  };
}

export class ReplUI implements RoomUI {
  private speaker?: string;
  /** The seat whose output came last, text or tools: a different one starts a new block. */
  private lastSeat?: string;
  private lineStart = true;
  /** The last two characters written, to know whether a blank line is already there. */
  private tail = "\n\n";
  private readonly colours = new Map<string, (t: string) => string>();
  readonly style: ReturnType<typeof makeStyle>;
  /** Seats' thinking: one short line per run (brief), all of it as it streams (full), or none. */
  thoughts: ThoughtMode = "brief";
  /** Tool calls: a line each with a short result (compact), or everything (`/verbose`). */
  readonly tools = new ToolView();
  /** A seat's current run of thinking, for brief mode: what came so far, and whether its line is out. */
  private readonly thoughtRuns = new Map<string, { text: string; printed: boolean }>();
  /** Background seats' unfinished lines (`seat`, and `seat#thought`), printed whole. */
  private readonly bgPartial = new Map<string, string>();
  /** What a seat's gutter says: "(bg)" for background work, nothing for a seat answering alongside. */
  private readonly gutterLabel = new Map<string, string>();
  /** A seat's reply so far on its current line, while the human's prompt is on screen. */
  private readonly fgPartial = new Map<string, string>();
  /** Permission questions one at a time, whichever seat asks. */
  private asking: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly lines: LineSource,
    styled = Boolean((process.stdout as { isTTY?: boolean }).isTTY) && !process.env.NO_COLOR,
  ) {
    this.style = makeStyle(styled);
  }

  /** Every write goes through the line source, so one landing over a prompt redraws it. */
  private readonly out = {
    write: (text: string): void => {
      this.tail = (this.tail + text).slice(-2);
      if (this.lines.write(text)) {
        this.lineStart = true;
        this.speaker = undefined;
        this.tail = "\n";
      }
    },
  };

  /** Colours for seats with their own (by harness, or set in the roster). */
  setSeatColours(colours: Record<string, number | undefined>): void {
    for (const [seat, index] of Object.entries(colours)) {
      if (index !== undefined) this.colours.set(seat, this.style.palette(index));
    }
  }

  private colourOf(seat: string): (t: string) => string {
    let c = this.colours.get(seat);
    if (!c) {
      c = this.style.colour(SEAT_COLOURS[this.colours.size % SEAT_COLOURS.length]);
      this.colours.set(seat, c);
    }
    return c;
  }

  /** A seat's name in its own colour. */
  seatName(seat: string): string {
    return this.colourOf(seat)(seat);
  }

  /**
   * A seat working in the background, live: every line behind a gutter in
   * the seat's colour, whole lines only, so it never splits a reply from the
   * seat whose turn it is.
   */
  /** A seat answering alongside another: whole lines behind its gutter, like background work. */
  sideEvent(seat: string, ev: SeatEvent): void {
    this.gutterLabel.set(seat, "");
    this.backgroundEvent(seat, ev, false);
  }

  backgroundEvent(seat: string, ev: SeatEvent, bg = true): void {
    if (bg) this.gutterLabel.set(seat, "(bg)");
    const { dim } = this.style;
    const brief = (line: string) => this.bgLine(seat, dim(`thinking: ${line}`));
    if (ev.type !== "thought") this.endThought(seat, brief);
    switch (ev.type) {
      case "text":
        this.bgBuffer(seat, seat, sanitizeForTerminal(ev.text), (t) => t);
        break;
      case "thought": {
        const text = sanitizeForTerminal(ev.text);
        if (this.thoughts === "full") this.bgBuffer(seat, `${seat}#thought`, text, dim);
        else if (this.thoughts === "brief") this.briefThought(seat, text, brief);
        break;
      }
      case "tool_call":
      case "tool_update": {
        const lines = this.tools.lines(seat, ev);
        if (lines.length) this.bgFlush(seat);
        for (const l of lines) this.bgLine(seat, dim(sanitizeForTerminal(l)));
        break;
      }
      case "stop":
        this.bgFlush(seat);
        for (const l of this.tools.unfinished(seat)) this.bgLine(seat, dim(sanitizeForTerminal(l)));
        break;
      default:
        break;
    }
  }

  /** Brief thinking: one line per run, out as soon as there is enough of it to read. */
  private briefThought(seat: string, text: string, emit: (line: string) => void): void {
    const run = this.thoughtRuns.get(seat) ?? { text: "", printed: false };
    this.thoughtRuns.set(seat, run);
    if (run.printed) return;
    run.text += text;
    const flat = run.text.replace(/\s+/g, " ").trim();
    if (flat.length >= THOUGHT_BRIEF) {
      emit(flat.slice(0, THOUGHT_BRIEF - 1) + "…");
      run.printed = true;
    }
  }

  private endThought(seat: string, emit: (line: string) => void): void {
    const run = this.thoughtRuns.get(seat);
    this.thoughtRuns.delete(seat);
    const flat = run?.text.replace(/\s+/g, " ").trim();
    if (run && !run.printed && flat) emit(flat);
  }

  /** `/show`: a tool call in full, by number, or a seat's latest, or the latest of all. */
  show(which?: string): void {
    const rec = this.tools.find(which);
    if (!rec) {
      this.status(which ? `no tool call ${which} (numbers are in the compact lines, e.g. #12)` : "no tool calls yet");
      return;
    }
    this.gap();
    this.out.write(`${this.style.bold(`#${rec.n}`)} ${this.seatName(rec.seat)}: ${sanitizeForTerminal(rec.title)}${rec.status ? ` (${rec.status})` : ""}\n`);
    const lines = renderToolContent(rec.content, "  ", Infinity, Infinity);
    for (const l of lines.length ? lines : ["  (no output)"]) this.out.write(sanitizeForTerminal(l) + "\n");
    this.lineStart = true;
    this.speaker = undefined;
  }

  private bgBuffer(seat: string, key: string, text: string, style: (t: string) => string): void {
    if (key === seat) this.bgFlushKey(seat, `${seat}#thought`, this.style.dim);
    else this.bgFlushKey(seat, seat, (t) => t);
    const parts = ((this.bgPartial.get(key) ?? "") + text).split("\n");
    this.bgPartial.set(key, parts.pop()!);
    for (const p of parts) this.bgLine(seat, style(p));
  }

  private bgFlushKey(seat: string, key: string, style: (t: string) => string): void {
    const rest = this.bgPartial.get(key);
    this.bgPartial.delete(key);
    if (rest?.trim()) this.bgLine(seat, style(rest));
  }

  private bgFlush(seat: string): void {
    this.bgFlushKey(seat, `${seat}#thought`, this.style.dim);
    this.bgFlushKey(seat, seat, (t) => t);
  }

  private bgLine(seat: string, line: string): void {
    this.newline();
    const label = this.gutterLabel.get(seat) ?? "(bg)";
    this.out.write(`${this.colourOf(seat)(`▌ ${seat}`)}${label ? ` ${this.style.dim(label)}` : ""} ${line}\n`);
    this.lineStart = true;
    this.speaker = undefined;
  }

  /** The human just ended a line (the terminal echoed it, not us): the next block needs its gap. */
  inputEnded(): void {
    this.tail = "\n";
    this.lineStart = true;
    this.lastSeat = undefined;
    this.speaker = undefined;
  }

  /** A blank line, unless there is one already: between speakers, and before the human's prompt. */
  gap(): void {
    this.newline();
    if (this.tail !== "\n\n") this.out.write("\n");
  }

  seatEvent(seat: string, ev: SeatEvent): void {
    const { dim } = this.style;
    const brief = (line: string) => this.toolish(dim(`  ${seat} thinking: ${line}`));
    if (ev.type !== "thought") this.endThought(seat, brief);
    const toolLines = ev.type === "tool_call" || ev.type === "tool_update" ? this.tools.lines(seat, ev) : [];
    const visible = ev.type === "text" || (ev.type === "thought" && this.thoughts !== "off") || toolLines.length > 0;
    if (visible && this.lastSeat !== seat) {
      this.gap();
      this.lastSeat = seat;
    }
    switch (ev.type) {
      case "text": {
        const text = sanitizeForTerminal(ev.text);
        // The human's prompt is up: write whole lines, so the prompt redraws below each one.
        if (this.lines.prompting) {
          const parts = ((this.fgPartial.get(seat) ?? "") + text).split("\n");
          this.fgPartial.set(seat, parts.pop()!);
          for (const line of parts) this.replyLine(seat, line);
          break;
        }
        if (this.speaker !== seat) {
          this.gap();
          this.out.write(`${this.seatName(seat)}> `);
          this.speaker = seat;
          this.lineStart = false;
        }
        // Set before writing: a write that lands over the prompt resets it.
        this.lineStart = text.endsWith("\n");
        this.out.write(text);
        break;
      }
      case "thought": {
        const text = sanitizeForTerminal(ev.text);
        if (!text || this.thoughts === "off") break;
        if (this.thoughts === "brief") {
          this.briefThought(seat, text, brief);
          break;
        }
        const header = `${seat}#thinking`;
        if (this.speaker !== header) {
          this.newline();
          this.out.write(dim(`  ${seat} thinking: `));
          this.speaker = header;
        }
        // Indented under its header, dimmed a chunk at a time; never ends a line itself.
        this.lineStart = false;
        this.out.write(dim(text.replace(/\n+/g, "\n    ")));
        break;
      }
      case "tool_call":
      case "tool_update":
        if (toolLines.length) this.flushReply(seat);
        for (const l of toolLines) this.toolish(dim(this.toolLine(seat, l)));
        break;
      case "stop":
        this.flushReply(seat);
        for (const l of this.tools.unfinished(seat)) this.toolish(dim(this.toolLine(seat, l)));
        this.newline();
        this.speaker = undefined;
        this.lastSeat = undefined;
        break;
      default:
        break;
    }
  }

  /** One whole line of a seat's reply; the first of a reply carries its name. */
  private replyLine(seat: string, line: string): void {
    const head = this.speaker !== seat;
    if (head) this.gap();
    this.out.write(`${head ? `${this.seatName(seat)}> ` : ""}${line}\n`);
    this.speaker = seat;
    this.lineStart = true;
  }

  private flushReply(seat: string): void {
    const rest = this.fgPartial.get(seat);
    this.fgPartial.delete(seat);
    if (rest?.trim()) this.replyLine(seat, rest);
  }

  /** `· title` heads a call as `  · seat: title`; its other lines indent under it. */
  private toolLine(seat: string, line: string): string {
    const clean = sanitizeForTerminal(line);
    return clean.startsWith("· ") ? `  · ${seat}: ${clean.slice(2)}` : `    ${clean}`;
  }

  /** A whole dim line of its own, between a seat's text. */
  private toolish(line: string): void {
    this.newline();
    this.out.write(line + "\n");
    this.lineStart = true;
    this.speaker = undefined;
  }

  private writeContent(content: ToolContentView[] | undefined): void {
    for (const line of renderToolContent(content)) this.out.write(this.style.dim(sanitizeForTerminal(line)) + "\n");
  }

  askHuman(req: PermissionRequestView): Promise<HumanChoice> {
    const run = this.asking.then(() => this.askOne(req));
    this.asking = run.catch(() => undefined);
    return run;
  }

  private async askOne(req: PermissionRequestView): Promise<HumanChoice> {
    this.gap();
    this.speaker = undefined;
    this.out.write(`${this.style.bold("?")} ${this.seatName(req.seat)} wants: ${sanitizeForTerminal(req.title)}${req.kind ? ` [${req.kind}]` : ""}\n`);
    this.writeContent(req.content);
    for (;;) {
      const a = (await this.lines.ask("  [a] allow  [A] always (room rule)  [d] deny  [c] cancel turn > ", false))?.trim();
      this.inputEnded();
      if (a === null || a === undefined) return "deny"; // stdin closed
      // No default: an Enter meant for something else must never approve.
      if (a === "a") return "allow";
      if (a === "A") return "allow_always";
      if (a === "d") return "deny";
      if (a === "c") return "cancel";
    }
  }

  status(line: string): void {
    this.newline();
    this.out.write(this.style.dim(`  [room] ${sanitizeForTerminal(line)}`) + "\n");
    this.lineStart = true;
    this.speaker = undefined;
  }

  private newline(): void {
    if (!this.lineStart) {
      this.out.write("\n");
      this.lineStart = true;
    }
  }
}

export async function runRepl(room: Room, lines: LineSource, ui: ReplUI): Promise<void> {
  const out = process.stdout;
  ui.setSeatColours(Object.fromEntries(room.opts.seats.map((s) => [s.name, seatColour(s)])));
  out.write(`room "${room.opts.name}" with ${room.opts.seats.map((s) => ui.seatName(s.name)).join(", ")}. /help for commands.\n`);
  for (;;) {
    ui.gap();
    const line = await lines.ask(`${ui.style.bold(room.opts.human)}> `);
    ui.inputEnded();
    if (line === null) break; // stdin closed
    const text = line.trim();
    if (text === "/quit" || text === "/q") break;
    if (text === "/help") {
      out.write(HELP + "\n");
      continue;
    }
    const [cmd, arg] = text.split(/\s+/);
    if (cmd === "/thoughts") {
      const modes: Record<string, ThoughtMode> = { on: "full", full: "full", brief: "brief", off: "off" };
      ui.thoughts = modes[arg ?? ""] ?? (ui.thoughts === "brief" ? "full" : "brief");
      const say = { brief: "one short line per stretch of thinking", full: "streamed in full", off: "hidden" };
      out.write(`  thinking: ${say[ui.thoughts]}\n`);
      continue;
    }
    if (cmd === "/verbose") {
      ui.tools.detail = arg === "off" ? "compact" : arg === "on" ? "full" : ui.tools.detail === "full" ? "compact" : "full";
      out.write(`  tool calls: ${ui.tools.detail === "full" ? "shown in full as they stream" : "one line each; /show <n> for one in full"}\n`);
      continue;
    }
    if (cmd === "/show") {
      ui.show(arg);
      continue;
    }
    // Seats answer while the prompt stays open: nothing here waits for them.
    const report = (err: unknown) => ui.status(`error: ${(err as Error).message}`);
    if (text === "" || text === "/next") {
      void room.continueRound().catch(report);
      continue;
    }
    if (text.startsWith("/")) {
      await runCommand(room, text, (l) => out.write(l + "\n"));
      continue;
    }
    void room.say(text).catch(report);
  }
  ui.status("closing seats");
  await room.stop();
}
