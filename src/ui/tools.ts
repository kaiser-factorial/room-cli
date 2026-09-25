/**
 * How the terminal shows seats' tool calls. Compact by default: one line per
 * call when it finishes, with a short result and a number (`#12`); commands
 * also get a line when they start, since they can run long. `/show 12`
 * prints that call in full, and `/verbose` streams everything as it comes.
 */
import type { SeatEvent, ToolContentView } from "../seat/types.js";
import { renderToolContent } from "./render.js";

export type Detail = "compact" | "full";

export interface ToolRecord {
  n: number;
  seat: string;
  title: string;
  kind?: string;
  status?: string;
  content?: ToolContentView[];
  /** A start line was printed (commands, in compact mode). */
  announced: boolean;
  /** Its result line was printed. */
  done: boolean;
}

const TITLE_MAX = 90;
const OUTPUT_MAX = 60;
const KEEP = 500;

function flat(text: string, max: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}

/** `(+3 -1)` for edits, `→ first line (+12 lines)` for output, or nothing. */
export function toolSummary(content: ToolContentView[] | undefined): string {
  if (!content?.length) return "";
  const parts: string[] = [];
  let added = 0;
  let removed = 0;
  let diffs = 0;
  for (const c of content) {
    if (c.type !== "diff") continue;
    diffs++;
    const before = c.oldText === undefined ? [] : c.oldText.split("\n");
    const after = c.newText.split("\n");
    let s = 0;
    while (s < before.length && s < after.length && before[s] === after[s]) s++;
    let b = before.length;
    let a = after.length;
    while (b > s && a > s && before[b - 1] === after[a - 1]) {
      b--;
      a--;
    }
    added += a - s;
    removed += b - s;
  }
  if (diffs) parts.push(`(+${added} -${removed})`);
  const text = content.find((c) => c.type === "text") as { text: string } | undefined;
  if (text) {
    // Skip code fences and lone brackets: some harnesses put the call's JSON input here.
    const lines = text.text
      .replace(/\s+$/, "")
      .split("\n")
      .filter((l) => l.trim() && !/^\s*(```\w*|[{}[\]],?)\s*$/.test(l));
    if (lines.length) parts.push(`→ ${flat(lines[0], OUTPUT_MAX)}${lines.length > 1 ? ` (+${lines.length - 1} lines)` : ""}`);
  }
  return parts.join(" ");
}

export class ToolView {
  private readonly calls = new Map<string, ToolRecord>();
  private readonly byNumber = new Map<number, ToolRecord>();
  private next = 1;

  constructor(public detail: Detail = "compact") {}

  /** Lines to print for a tool event: `· ...` lines head a call, the rest are indented under it. */
  lines(seat: string, ev: Extract<SeatEvent, { type: "tool_call" | "tool_update" }>): string[] {
    const key = `${seat}:${ev.id}`;
    let rec = this.calls.get(key);
    if (!rec) {
      rec = { n: this.next++, seat, title: ev.title ?? "tool", announced: false, done: false };
      this.calls.set(key, rec);
      this.byNumber.set(rec.n, rec);
      this.byNumber.delete(rec.n - KEEP);
    }
    if (ev.title) rec.title = ev.title;
    if (ev.type === "tool_call" && ev.kind) rec.kind = ev.kind;
    if (ev.status) rec.status = ev.status;
    if (ev.content) rec.content = ev.content;
    const title = flat(rec.title, TITLE_MAX);
    const final = ev.status === "completed" || ev.status === "failed" || (ev.type === "tool_update" && ev.content && !ev.status);

    if (this.detail === "full") {
      if (ev.type === "tool_call") {
        return [`· ${title}${rec.kind ? ` [${rec.kind}]` : ""} #${rec.n}`, ...renderToolContent(ev.content, "  ")];
      }
      if (ev.content && ev.status !== "pending" && ev.status !== "in_progress") {
        return [...(ev.title ? [`· ${title}${ev.status === "failed" ? " (failed)" : ""}`] : []), ...renderToolContent(ev.content, "  ")];
      }
      return ev.status === "failed" ? [`· tool failed: ${title}`] : [];
    }

    if (!final) {
      // A command can run a while: say it started. Anything else shows when it is done.
      if (ev.type === "tool_call" && rec.kind === "execute" && !rec.announced) {
        rec.announced = true;
        return [`· ${title} #${rec.n}`];
      }
      return [];
    }
    if (rec.done) return [];
    rec.done = true;
    const result = rec.status === "failed" ? "(failed)" : toolSummary(rec.content);
    if (rec.announced) return [`  ↳ ${result.replace(/^→ /, "") || "done"}`];
    return [`· ${title}${result ? ` ${result}` : ""} #${rec.n}`];
  }

  /** Calls a seat started and never finished, when its turn ends, so none goes unseen. */
  unfinished(seat: string): string[] {
    const out: string[] = [];
    for (const rec of this.calls.values()) {
      if (rec.seat !== seat || rec.done) continue;
      rec.done = true;
      if (!rec.announced && this.detail === "compact") out.push(`· ${flat(rec.title, TITLE_MAX)} (no result) #${rec.n}`);
    }
    for (const [k, rec] of this.calls) if (rec.seat === seat) this.calls.delete(k);
    return out;
  }

  /** A call by number, or a seat's latest, or the latest of all. */
  find(which?: string): ToolRecord | undefined {
    if (which && /^#?\d+$/.test(which)) return this.byNumber.get(Number(which.replace("#", "")));
    const all = [...this.byNumber.values()];
    return (which ? all.filter((r) => r.seat === which) : all).at(-1);
  }
}
