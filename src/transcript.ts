/**
 * The canonical room transcript: one JSON object per line, append-only.
 * Seats never read this file; the room reads it to build each seat's delta.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Step } from "./activity.js";

export type EntryKind = "message" | "pass" | "commit" | "system";

export interface Entry {
  /** Monotonic, 1-based. Cursors are entry ids. */
  id: number;
  ts: string;
  /** Seat name, the human's name, or "room" for system and commit entries. */
  from: string;
  kind: EntryKind;
  text: string;
  /** The turn this entry closes, in order, when the seat made tool calls in it. */
  steps?: { seat: string; items: Step[] };
  /** Older rooms: the turn's tool calls, unordered. Read, no longer written. */
  activity?: { seat: string; lines: string[] };
}

export class Transcript {
  readonly entries: Entry[] = [];
  /** Lines that did not parse on open, e.g. a torn last line after a crash. */
  skipped = 0;

  private constructor(readonly path: string) {}

  static open(path: string): Transcript {
    const t = new Transcript(path);
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as Entry;
          if (typeof e.id !== "number" || typeof e.from !== "string" || typeof e.text !== "string") throw new Error("shape");
          t.entries.push(e);
        } catch {
          t.skipped += 1;
        }
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
    return t;
  }

  get last(): number {
    return this.entries.length ? this.entries[this.entries.length - 1].id : 0;
  }

  append(from: string, kind: EntryKind, text: string, steps?: Entry["steps"]): Entry {
    const entry: Entry = { id: this.last + 1, ts: new Date().toISOString(), from, kind, text };
    if (steps?.items.some((i) => "tool" in i)) entry.steps = steps;
    this.entries.push(entry);
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
    return entry;
  }

  /** Entries after `cursor`, oldest first. */
  since(cursor: number): Entry[] {
    return this.entries.filter((e) => e.id > cursor);
  }
}

/** A line that looks like a speaker label, e.g. `[Corina]: ...` or `  [room]: ...`. */
const LABEL_LINE = /^(\s*)(\[[^\]\n]+\]:)/;

/**
 * Seats are untrusted participants. A line inside a seat's message that
 * looks like a label is quoted so the next seat reads it as that seat's
 * text, not as the human or the room speaking.
 */
export function neutralizeLabels(text: string): string {
  return text
    .split("\n")
    .map((line) => (LABEL_LINE.test(line) ? `> ${line}` : line))
    .join("\n");
}

/**
 * Render a delta for one seat as the `[Name]: text` block the web app uses.
 * The seat's own entries are skipped: its harness already holds them.
 * `trusted` names whose text is rendered verbatim (the human, the room).
 */
export function renderDelta(entries: Entry[], forSeat: string, trusted: string[] = []): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.activity && e.activity.seat !== forSeat) {
      lines.push(`[room]: ${e.activity.seat}'s tool calls this turn:\n${e.activity.lines.map((l) => `  - ${l}`).join("\n")}`);
    }
    if (e.from === forSeat && (e.kind === "message" || e.kind === "pass")) continue;
    // Another seat's turn with tool calls reads in the order it happened: each call is
    // the room's line, what the seat said between them is the seat's.
    if (e.steps && e.steps.seat !== forSeat) {
      const seat = e.steps.seat;
      const own = e.kind === "message" && e.from === seat;
      const turn = e.steps.items
        .filter((i) => own || "tool" in i)
        .map((i) => ("tool" in i ? `[room]: ${seat} tool: ${i.tool}` : `[${seat}]: ${neutralizeLabels(i.text)}`));
      if (e.kind === "pass") turn.push(`[room]: ${seat} passed.`);
      if (e.kind === "system" || e.kind === "commit") turn.push(`[room]: ${e.text}`);
      lines.push(turn.join("\n"));
      continue;
    }
    switch (e.kind) {
      case "message":
        lines.push(`[${e.from}]: ${trusted.includes(e.from) ? e.text : neutralizeLabels(e.text)}`);
        break;
      case "pass":
        lines.push(`[room]: ${e.from} passed.`);
        break;
      case "commit":
      case "system":
        lines.push(`[room]: ${e.text}`);
        break;
    }
  }
  return lines.join("\n\n");
}
