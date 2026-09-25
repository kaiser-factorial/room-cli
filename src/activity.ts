/**
 * A seat's turn in order: what it said, and the tool calls it made between,
 * each with how it ended. The next seats read the turn in that order, so
 * "that didn't work, trying the other file" still follows what didn't work.
 */
import type { SeatEvent, ToolContentView } from "./seat/types.js";

const LINE_MAX = 160;

interface Call {
  title: string;
  kind?: string;
  status?: string;
  locations: string[];
  added: number;
  removed: number;
  output?: string;
}

/** One line of text: control characters and newlines gone, capped. */
function oneLine(text: string, max = LINE_MAX): string {
  const visible = Array.from(text, (ch) => (ch.charCodeAt(0) < 0x20 || ch === "\u007f" ? " " : ch)).join("");
  const flat = visible.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function diffCounts(content: ToolContentView[] | undefined): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const c of content ?? []) {
    if (c.type !== "diff") continue;
    const before = c.oldText === undefined ? [] : c.oldText.split("\n");
    const after = c.newText.split("\n");
    // Same trim as the terminal's compact diff: only the changed middle counts.
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let b = before.length;
    let a = after.length;
    while (b > start && a > start && before[b - 1] === after[a - 1]) {
      b--;
      a--;
    }
    removed += b - start;
    added += a - start;
  }
  return { added, removed };
}

function firstOutput(content: ToolContentView[] | undefined): string | undefined {
  for (const c of content ?? []) {
    if (c.type === "text") {
      const line = c.text.split("\n").find((l) => l.trim());
      if (line) return oneLine(line, 80);
    }
  }
  return undefined;
}

/** One step of a turn, in order: something the seat said, or a tool call it made. */
export type Step = { text: string } | { tool: string };

/**
 * A tool run longer than this keeps its first and last calls: a long
 * exploration stays readable without dropping how it began and ended.
 */
export const RUN_MAX = 8;

export class Activity {
  private readonly calls = new Map<string, Call>();
  /** The turn in order. A tool step names its call, which later updates keep current. */
  private readonly order: Array<{ text: string } | { call: string }> = [];

  observe(ev: SeatEvent): void {
    if (ev.type === "text") {
      const last = this.order.at(-1);
      if (last && "text" in last) last.text += ev.text;
      else this.order.push({ text: ev.text });
    } else if (ev.type === "tool_call") {
      const counts = diffCounts(ev.content);
      if (!this.calls.has(ev.id)) this.order.push({ call: ev.id });
      this.calls.set(ev.id, {
        title: ev.title,
        kind: ev.kind,
        status: ev.status,
        locations: ev.locations ?? [],
        ...counts,
        output: firstOutput(ev.content),
      });
    } else if (ev.type === "tool_update") {
      let call = this.calls.get(ev.id);
      if (!call) {
        call = { title: ev.title ?? "tool", locations: [], added: 0, removed: 0 };
        this.order.push({ call: ev.id });
      }
      if (ev.title) call.title = ev.title;
      if (ev.status) call.status = ev.status;
      if (ev.locations?.length) call.locations = ev.locations;
      if (ev.content) {
        const counts = diffCounts(ev.content);
        if (counts.added || counts.removed) Object.assign(call, counts);
        call.output = firstOutput(ev.content) ?? call.output;
      }
      this.calls.set(ev.id, call);
    }
  }

  /** Whether the seat made any tool call this turn. */
  get used(): boolean {
    return this.calls.size > 0;
  }

  /**
   * The turn in order: what the seat said between its tool calls, and each
   * call as one line (`Edit hello.py (+3 -1)`, `` Execute `ls` → hello.py ``,
   * `Write x (failed)`). Long runs of calls keep their first and last.
   */
  steps(runMax = RUN_MAX): Step[] {
    const out: Step[] = [];
    let run: string[] = [];
    const flush = () => {
      if (run.length > runMax) run = [...run.slice(0, runMax - 3), `… ${run.length - runMax + 1} more`, ...run.slice(-2)];
      for (const tool of run) out.push({ tool });
      run = [];
    };
    for (const o of this.order) {
      if ("call" in o) {
        run.push(describe(this.calls.get(o.call)!));
        continue;
      }
      const text = o.text.trim();
      if (!text) continue;
      flush();
      out.push({ text });
    }
    flush();
    return out;
  }
}

function describe(c: Call): string {
  const where = c.locations.length && !c.locations.some((l) => c.title.includes(l.split("/").pop() ?? l))
    ? ` ${c.locations.map((l) => l.split("/").pop()).join(", ")}`
    : "";
  const diff = c.added || c.removed ? ` (+${c.added} -${c.removed})` : "";
  const out = c.output && c.kind === "execute" ? ` → ${c.output}` : "";
  const end = c.status === "failed" ? " (failed)" : c.status === "pending" || c.status === "in_progress" ? " (did not finish)" : "";
  return oneLine(`${c.title}${where}${diff}${out}${end}`);
}
