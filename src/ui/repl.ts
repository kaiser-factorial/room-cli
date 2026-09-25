/**
 * The v0 interface: a streaming REPL. Seat replies stream with a speaker
 * prefix, permission prompts are answered inline, and slash commands change
 * modes and policy mid-session.
 *
 * Input goes through a line queue rather than readline's `question`, so
 * lines typed (or piped) while a turn is running are kept, not dropped.
 */
import type readline from "node:readline";
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

  constructor(private readonly rl: readline.Interface) {
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
      process.stdout.write(`${prompt}${line}\n`);
      return Promise.resolve(line);
    }
    if (this.closed) return Promise.resolve(null);
    this.rl.setPrompt(prompt);
    this.rl.prompt();
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

export class ReplUI implements RoomUI {
  private speaker?: string;
  private lineStart = true;

  constructor(
    private readonly lines: LineSource,
    private readonly out: NodeJS.WritableStream = process.stdout,
  ) {}

  seatEvent(seat: string, ev: SeatEvent): void {
    switch (ev.type) {
      case "text": {
        const text = sanitizeForTerminal(ev.text);
        if (this.speaker !== seat) {
          this.newline();
          this.out.write(`${seat}> `);
          this.speaker = seat;
          this.lineStart = false;
        }
        this.out.write(text);
        this.lineStart = text.endsWith("\n");
        break;
      }
      case "tool_call":
        this.newline();
        this.out.write(`  · ${seat}: ${sanitizeForTerminal(ev.title)}${ev.kind ? ` [${ev.kind}]` : ""}\n`);
        this.writeContent(ev.content);
        this.lineStart = true;
        this.speaker = undefined;
        break;
      case "tool_update":
        // Most harnesses send the diff or the output on the completing update.
        if (ev.content && ev.status !== "pending" && ev.status !== "in_progress") {
          this.newline();
          if (ev.title) this.out.write(`  · ${seat}: ${sanitizeForTerminal(ev.title)}${ev.status === "failed" ? " (failed)" : ""}\n`);
          this.writeContent(ev.content);
          this.lineStart = true;
          this.speaker = undefined;
        } else if (ev.status === "failed") {
          this.newline();
          this.out.write(`  · ${seat}: tool failed${ev.title ? `: ${sanitizeForTerminal(ev.title)}` : ""}\n`);
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
    for (const line of renderToolContent(content)) this.out.write(`${sanitizeForTerminal(line)}\n`);
  }

  async askHuman(req: PermissionRequestView): Promise<HumanChoice> {
    this.newline();
    this.speaker = undefined;
    this.out.write(`? ${req.seat} wants: ${sanitizeForTerminal(req.title)}${req.kind ? ` [${req.kind}]` : ""}\n`);
    this.writeContent(req.content);
    for (;;) {
      const a = (await this.lines.ask("  [a] allow  [A] always (room rule)  [d] deny  [c] cancel turn > "))?.trim();
      if (a === null || a === undefined) return "deny"; // stdin closed
      if (a === "a" || a === "") return "allow";
      if (a === "A") return "allow_always";
      if (a === "d") return "deny";
      if (a === "c") return "cancel";
    }
  }

  status(line: string): void {
    this.newline();
    this.out.write(`  [room] ${sanitizeForTerminal(line)}\n`);
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
    const line = await lines.ask(`${room.opts.human}> `);
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
