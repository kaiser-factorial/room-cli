/**
 * The TUI's state, kept apart from Ink so it can be tested without a
 * terminal. Room events become blocks: finished ones are printed once into
 * the terminal's own scrollback, live ones (a seat mid-turn, in the
 * foreground or the background) are redrawn above the input as they grow.
 * Each seat also has a one-line "what it is doing" for the status bar.
 */
import { EventEmitter } from "node:events";
import type { HumanChoice } from "../../permissions.js";
import type { PermissionRequestView, SeatEvent } from "../../seat/types.js";
import { renderToolContent } from "../render.js";
import { sanitizeForTerminal } from "../repl.js";
import { ToolView } from "../tools.js";

export type Part = { type: "text"; text: string } | { type: "tool"; line: string } | { type: "thought"; text: string };

export interface Block {
  id: number;
  kind: "seat" | "human" | "status" | "info";
  seat?: string;
  /** A background seat's block, drawn behind its gutter. */
  bg?: boolean;
  parts: Part[];
}

export type ThoughtMode = "brief" | "full" | "off";
const THOUGHT_BRIEF = 110;

export interface Ask {
  req: PermissionRequestView;
  /** The proposed change, rendered, for the question bar. */
  preview: string[];
  resolve: (choice: HumanChoice) => void;
}

function flat(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

export class TuiStore extends EventEmitter {
  /** Printed once, in order, into scrollback. */
  readonly finished: Block[] = [];
  /** Seats mid-turn, by `seat` or `seat#bg`. */
  readonly live = new Map<string, Block>();
  /** What each seat is doing now, for the status bar. */
  readonly doing = new Map<string, string>();
  readonly asks: Ask[] = [];
  readonly tools = new ToolView();
  thoughts: ThoughtMode = "brief";
  private nextId = 1;
  /** Brief thinking already shown for a seat's current run. */
  private readonly thoughtShown = new Set<string>();

  private changed(): void {
    this.emit("change");
  }

  private block(kind: Block["kind"], parts: Part[], seat?: string, bg?: boolean): Block {
    return { id: this.nextId++, kind, seat, bg, parts };
  }

  human(name: string, text: string): void {
    this.finished.push(this.block("human", [{ type: "text", text }], name));
    this.changed();
  }

  /** A seat's mid-turn `post`: its own block, finished at once. */
  posted(seat: string, text: string): void {
    this.finished.push(this.block("seat", [{ type: "text", text: sanitizeForTerminal(text) }], seat));
    this.changed();
  }

  status(line: string): void {
    this.finished.push(this.block("status", [{ type: "text", text: sanitizeForTerminal(line) }]));
    this.changed();
  }

  /** Lines of plain output: command results, help, a tool call shown in full. */
  info(lines: string[]): void {
    this.finished.push(this.block("info", lines.map((l) => ({ type: "text" as const, text: sanitizeForTerminal(l) }))));
    this.changed();
  }

  /** `/show`: a tool call in full. */
  show(which?: string): void {
    const rec = this.tools.find(which);
    if (!rec) return this.status(which ? `no tool call ${which} (numbers are in the tool lines, e.g. #12)` : "no tool calls yet");
    const body = renderToolContent(rec.content, "  ", Infinity, Infinity);
    this.info([`#${rec.n} ${rec.seat}: ${rec.title}${rec.status ? ` (${rec.status})` : ""}`, ...(body.length ? body : ["  (no output)"])]);
  }

  seatEvent(seat: string, ev: SeatEvent, bg = false): void {
    const key = bg ? `${seat}#bg` : seat;
    let b = this.live.get(key);
    if (!b && ev.type !== "stop") {
      b = this.block("seat", [], seat, bg);
      this.live.set(key, b);
    }
    if (ev.type !== "thought") this.thoughtShown.delete(key);
    switch (ev.type) {
      case "text": {
        const last = b!.parts.at(-1);
        const text = sanitizeForTerminal(ev.text);
        if (last?.type === "text") last.text += text;
        else b!.parts.push({ type: "text", text: text.replace(/^\n+/, "") });
        this.doing.set(seat, bg ? "writing (bg)" : "writing…");
        break;
      }
      case "thought": {
        this.doing.set(seat, bg ? "thinking (bg)" : "thinking…");
        if (this.thoughts === "off") break;
        const text = sanitizeForTerminal(ev.text);
        const last = b!.parts.at(-1);
        if (last?.type === "thought") {
          if (this.thoughts === "full" || !this.thoughtShown.has(key)) last.text += text;
        } else b!.parts.push({ type: "thought", text });
        const cur = b!.parts.at(-1) as { type: "thought"; text: string };
        if (this.thoughts === "brief" && cur.text.length >= THOUGHT_BRIEF) {
          cur.text = flat(cur.text, THOUGHT_BRIEF);
          this.thoughtShown.add(key);
        }
        break;
      }
      case "tool_call":
      case "tool_update": {
        for (const line of this.tools.lines(seat, ev)) b!.parts.push({ type: "tool", line: sanitizeForTerminal(line) });
        if (ev.type === "tool_call") this.doing.set(seat, `${bg ? "(bg) " : ""}· ${flat(ev.title, 40)}`);
        break;
      }
      case "stop": {
        if (b) {
          for (const line of this.tools.unfinished(seat)) b.parts.push({ type: "tool", line });
          for (const p of b.parts) if (p.type === "thought" && this.thoughts === "brief") p.text = flat(p.text, THOUGHT_BRIEF);
          this.live.delete(key);
          if (b.parts.some((p) => p.type !== "text" || p.text.trim())) this.finished.push(b);
        }
        this.doing.delete(seat);
        break;
      }
      default:
        return;
    }
    this.changed();
  }

  /** A seat's permission question: queued, answered one at a time from the question bar. */
  ask(req: PermissionRequestView): Promise<HumanChoice> {
    return new Promise((resolve) => {
      let answered = false;
      const ask: Ask = {
        req,
        preview: renderToolContent(req.content, "  ").map((l) => sanitizeForTerminal(l)),
        // Once only, and only this question: a second keypress before the redraw must not
        // take the next seat's question off the queue unanswered.
        resolve: (choice) => {
          if (answered) return;
          answered = true;
          const i = this.asks.indexOf(ask);
          if (i >= 0) this.asks.splice(i, 1);
          resolve(choice);
          this.changed();
        },
      };
      this.asks.push(ask);
      this.changed();
    });
  }
}
