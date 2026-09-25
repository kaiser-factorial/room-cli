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
import { renderToolContent } from "./render.js";

const HELP = `commands:
  <text>                 say something; every seat answers in order
  @seat <text>           say something to one seat (several: @a @b)
  <empty line> or /next  another round with no new message
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
  private waiting?: (line: string | null) => void;
  private closed = false;

  constructor(
    private readonly rl: readline.Interface,
    private readonly out: NodeJS.WritableStream = process.stdout,
  ) {
    rl.on("line", (line) => {
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = undefined;
        w(line);
      } else this.queue.push(line);
    });
    rl.on("close", () => {
      this.closed = true;
      this.waiting?.(null);
      this.waiting = undefined;
    });
  }

  ask(prompt: string): Promise<string | null> {
    if (this.queue.length) {
      const line = this.queue.shift()!;
      this.out.write(`${prompt}${line}\n`);
      return Promise.resolve(line);
    }
    if (this.closed) return Promise.resolve(null);
    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /** Whether a prompt is on screen, waiting for the human. */
  get prompting(): boolean {
    return this.waiting !== undefined;
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

  /** A seat's name in its own colour. */
  seatName(seat: string): string {
    let c = this.colours.get(seat);
    if (!c) {
      c = this.style.colour(SEAT_COLOURS[this.colours.size % SEAT_COLOURS.length]);
      this.colours.set(seat, c);
    }
    return c(seat);
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
    const visible = ev.type === "text" || ev.type === "tool_call" || (ev.type === "tool_update" && (ev.content || ev.status === "failed"));
    if (visible && this.lastSeat !== seat) {
      this.gap();
      this.lastSeat = seat;
    }
    switch (ev.type) {
      case "text": {
        const text = sanitizeForTerminal(ev.text);
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
      case "tool_call":
        this.newline();
        this.out.write(dim(`  · ${seat}: ${sanitizeForTerminal(ev.title)}${ev.kind ? ` [${ev.kind}]` : ""}`) + "\n");
        this.writeContent(ev.content);
        this.lineStart = true;
        this.speaker = undefined;
        break;
      case "tool_update":
        // Most harnesses send the diff or the output on the completing update.
        if (ev.content && ev.status !== "pending" && ev.status !== "in_progress") {
          this.newline();
          if (ev.title) this.out.write(dim(`  · ${seat}: ${sanitizeForTerminal(ev.title)}${ev.status === "failed" ? " (failed)" : ""}`) + "\n");
          this.writeContent(ev.content);
          this.lineStart = true;
          this.speaker = undefined;
        } else if (ev.status === "failed") {
          this.newline();
          this.out.write(dim(`  · ${seat}: tool failed${ev.title ? `: ${sanitizeForTerminal(ev.title)}` : ""}`) + "\n");
          this.lineStart = true;
          this.speaker = undefined;
        }
        break;
      case "stop":
        this.newline();
        this.speaker = undefined;
        break;
      default:
        break;
    }
  }

  private writeContent(content: ToolContentView[] | undefined): void {
    for (const line of renderToolContent(content)) this.out.write(this.style.dim(sanitizeForTerminal(line)) + "\n");
  }

  async askHuman(req: PermissionRequestView): Promise<HumanChoice> {
    this.gap();
    this.speaker = undefined;
    this.out.write(`${this.style.bold("?")} ${this.seatName(req.seat)} wants: ${sanitizeForTerminal(req.title)}${req.kind ? ` [${req.kind}]` : ""}\n`);
    this.writeContent(req.content);
    for (;;) {
      const a = (await this.lines.ask("  [a] allow  [A] always (room rule)  [d] deny  [c] cancel turn > "))?.trim();
      this.inputEnded();
      if (a === null || a === undefined) return "deny"; // stdin closed
      if (a === "a" || a === "") return "allow";
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
  out.write(`room "${room.opts.name}" with ${room.seatNames.join(", ")}. /help for commands.\n`);
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
    if (text === "" || text === "/next") {
      await room.continueRound();
      continue;
    }
    if (text.startsWith("/")) {
      await runCommand(room, text, (l) => out.write(l + "\n"));
      continue;
    }
    await room.say(text);
  }
  ui.status("closing seats");
  await room.stop();
}
