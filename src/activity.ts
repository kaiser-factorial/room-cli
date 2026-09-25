/**
 * What a seat did during a turn, besides talk: the tool calls it made and
 * how each ended. The next seats read this from the room alongside the
 * reply, so they can build on the work and not only on its summary.
 */
import type { SeatEvent, ToolContentView } from "./seat/types.js";

/** Tool lines kept per turn; a long exploration keeps its first and last. */
export const ACTIVITY_MAX = 16;
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
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
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

export class Activity {
  private readonly calls = new Map<string, Call>();

  observe(ev: SeatEvent): void {
    if (ev.type === "tool_call") {
      const counts = diffCounts(ev.content);
      this.calls.set(ev.id, {
        title: ev.title,
        kind: ev.kind,
        status: ev.status,
        locations: ev.locations ?? [],
        ...counts,
        output: firstOutput(ev.content),
      });
    } else if (ev.type === "tool_update") {
      const call = this.calls.get(ev.id) ?? { title: ev.title ?? "tool", locations: [], added: 0, removed: 0 };
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

  get size(): number {
    return this.calls.size;
  }

  /** `Edit hello.py (+3 -1)`, `Execute \`ls\` → hello.py`, `Write x (failed)`, one per call. */
  lines(max = ACTIVITY_MAX): string[] {
    const all = [...this.calls.values()].map((c) => {
      const where = c.locations.length && !c.locations.some((l) => c.title.includes(l.split("/").pop() ?? l))
        ? ` ${c.locations.map((l) => l.split("/").pop()).join(", ")}`
        : "";
      const diff = c.added || c.removed ? ` (+${c.added} -${c.removed})` : "";
      const out = c.output && c.kind === "execute" ? ` → ${c.output}` : "";
      const end = c.status === "failed" ? " (failed)" : c.status === "pending" || c.status === "in_progress" ? " (did not finish)" : "";
      return oneLine(`${c.title}${where}${diff}${out}${end}`);
    });
    if (all.length <= max) return all;
    const head = all.slice(0, max - 4);
    return [...head, `… ${all.length - max + 1} more`, ...all.slice(-3)];
  }
}
