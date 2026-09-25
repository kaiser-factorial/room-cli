/**
 * Compact rendering of tool activity for a terminal: a few lines of diff per
 * edit, a few lines of output per command. Shared by the REPL and the ACP
 * server's text stream.
 */
import type { ToolContentView } from "../seat/types.js";

export const DIFF_MAX_LINES = 24;
export const OUTPUT_MAX_LINES = 8;

/** Lines removed and added between two texts, in order, without an LCS: good enough to read. */
export function compactDiff(oldText: string | undefined, newText: string, max = DIFF_MAX_LINES): string[] {
  const before = oldText === undefined ? [] : oldText.split("\n");
  const after = newText.split("\n");
  // Trim the common prefix and suffix so a small edit in a big file shows only the edit.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endB = before.length;
  let endA = after.length;
  while (endB > start && endA > start && before[endB - 1] === after[endA - 1]) {
    endB--;
    endA--;
  }
  const removed = before.slice(start, endB).map((l) => `-${l}`);
  const added = after.slice(start, endA).map((l) => `+${l}`);
  const lines = [...removed, ...added];
  const capped = lines.length > max ? [...lines.slice(0, max), `… ${lines.length - max} more lines`] : lines;
  if (oldText === undefined && removed.length === 0) capped.unshift(`(new file, ${after.length} lines)`);
  return capped;
}

/**
 * A path as a person reads it: inside a seat's desk, relative to the desk
 * (`src/calc.py`, not `/Users/.../.room/main/desks/grok/src/calc.py`);
 * inside the working directory, relative to it.
 */
export function shortPath(path: string, cwd = process.cwd()): string {
  const desk = /\/\.room\/[^/]+\/desks\/[^/]+\/(.+)$/.exec(path);
  if (desk) return desk[1];
  return path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
}

export function renderToolContent(
  content: ToolContentView[] | undefined,
  indent = "    ",
  outputMax = OUTPUT_MAX_LINES,
  diffMax = DIFF_MAX_LINES,
): string[] {
  if (!content) return [];
  const out: string[] = [];
  for (const c of content) {
    if (c.type === "diff") {
      out.push(`${indent}${shortPath(c.path)}`);
      for (const l of compactDiff(c.oldText, c.newText, diffMax)) out.push(`${indent}${l}`);
    } else {
      const lines = c.text.replace(/\s+$/, "").split("\n");
      const shown = lines.slice(0, outputMax);
      for (const l of shown) out.push(`${indent}│ ${l}`);
      if (lines.length > shown.length) out.push(`${indent}│ … ${lines.length - shown.length} more lines`);
    }
  }
  return out;
}
