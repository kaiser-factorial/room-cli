/**
 * The canonical room transcript: one JSON object per line, append-only.
 * Seats never read this file; the room reads it to build each seat's delta.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type EntryKind = "message" | "pass" | "commit" | "system";

export interface Entry {
  /** Monotonic, 1-based. Cursors are entry ids. */
  id: number;
  ts: string;
  /** Seat name, the human's name, or "room" for system and commit entries. */
  from: string;
  kind: EntryKind;
  text: string;
}

export class Transcript {
  readonly entries: Entry[] = [];

  private constructor(readonly path: string) {}

  static open(path: string): Transcript {
    const t = new Transcript(path);
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        t.entries.push(JSON.parse(line) as Entry);
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
    }
    return t;
  }

  get last(): number {
    return this.entries.length ? this.entries[this.entries.length - 1].id : 0;
  }

  append(from: string, kind: EntryKind, text: string): Entry {
    const entry: Entry = { id: this.last + 1, ts: new Date().toISOString(), from, kind, text };
    this.entries.push(entry);
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
    return entry;
  }

  /** Entries after `cursor`, oldest first. */
  since(cursor: number): Entry[] {
    return this.entries.filter((e) => e.id > cursor);
  }
}

/**
 * Render a delta for one seat as the `[Name]: text` block the web app uses.
 * The seat's own entries are skipped: its harness already holds them.
 */
export function renderDelta(entries: Entry[], forSeat: string): string {
  const lines: string[] = [];
  for (const e of entries) {
    if (e.from === forSeat && e.kind === "message") continue;
    switch (e.kind) {
      case "message":
        lines.push(`[${e.from}]: ${e.text}`);
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
