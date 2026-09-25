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
import type { Room, RoomUI } from "../room.js";
import type { PermissionRequestView, SeatEvent } from "../seat/types.js";

const HELP = `commands:
  <text>                 say something; every seat answers in order
  @seat <text>           say something to one seat (several: @a @b)
  <empty line> or /next  another round with no new message
  /seats                 seats, modes, and what is queued
  /mode <seat> [id]      show or set a seat's session mode
  /perm <seat>           show a seat's policy
  /perm <seat> allow|ask|deny <pattern>   add a rule (kind like edit, or title glob like "Write *")
  /unperm <seat> <pattern>                remove a rule
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
        this.lineStart = true;
        this.speaker = undefined;
        break;
      case "stop":
        this.newline();
        this.speaker = undefined;
        break;
      default:
        break;
    }
  }

  async askHuman(req: PermissionRequestView): Promise<HumanChoice> {
    this.newline();
    this.speaker = undefined;
    this.out.write(`? ${req.seat} wants: ${sanitizeForTerminal(req.title)}${req.kind ? ` [${req.kind}]` : ""}\n`);
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
      await command(room, text);
      continue;
    }
    await room.say(text);
  }
  ui.status("closing seats");
  await room.stop();
}

async function command(room: Room, text: string): Promise<void> {
  const [cmd, ...args] = text.split(/\s+/);
  const out = (s: string): void => {
    process.stdout.write(s + "\n");
  };
  switch (cmd) {
    case "/seats": {
      for (const name of room.seatNames) {
        const modes = room.modesOf(name);
        const mode = room.state.modes[name] ?? modes?.current ?? "-";
        out(`  ${name.padEnd(8)} mode ${mode.padEnd(12)} session ${room.state.sessions[name] ?? "-"}`);
      }
      if (room.scheduler.pending.length) out(`  queued: ${room.scheduler.pending.join(", ")}`);
      return;
    }
    case "/mode": {
      const [seat, id] = args;
      if (!seat || !room.seatNames.includes(seat)) return out(`  usage: /mode <seat> [id]; seats: ${room.seatNames.join(", ")}`);
      const modes = room.modesOf(seat);
      if (!id) {
        if (!modes) return out(`  ${seat} advertises no modes (its config file is the lever)`);
        for (const m of modes.available) out(`  ${m.id === (room.state.modes[seat] ?? modes.current) ? "*" : " "} ${m.id.padEnd(20)} ${m.name}`);
        return;
      }
      try {
        await room.setMode(seat, id);
        out(`  ${seat}: mode ${id}`);
      } catch (err) {
        out(`  ${(err as Error).message}`);
      }
      return;
    }
    case "/perm": {
      const [seat, action, ...rest] = args;
      if (!seat || !room.seatNames.includes(seat)) return out(`  usage: /perm <seat> [allow|ask|deny <pattern>]`);
      if (action) {
        if ((action !== "allow" && action !== "ask" && action !== "deny") || rest.length === 0) {
          return out(`  usage: /perm <seat> allow|ask|deny <pattern>`);
        }
        room.addRule(seat, action, rest.join(" "));
      }
      const p = room.policyOf(seat);
      out(`  ${seat}: allow ${JSON.stringify(p.allow)}  ask ${JSON.stringify(p.ask)}  deny ${JSON.stringify(p.deny)}`);
      out(`  (deny beats ask beats allow; unmatched calls ask you)`);
      return;
    }
    case "/unperm": {
      const [seat, ...rest] = args;
      if (!seat || rest.length === 0) return out(`  usage: /unperm <seat> <pattern>`);
      out(room.removeRule(seat, rest.join(" ")) ? `  removed` : `  no such rule`);
      return;
    }
    default:
      out(`  unknown command ${cmd}; /help`);
  }
}
