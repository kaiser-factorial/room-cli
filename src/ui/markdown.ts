/**
 * Seats write markdown; the terminal shows it styled, a line at a time, the
 * way Claude Code does: bold, italics, headings, quotes, rules, `code`,
 * file paths and function names in a colour of their own, and fenced code
 * blocks as code. No dependency: seats' markdown is simple, and a line
 * renderer can keep up with a streamed reply.
 */

export interface MdStyle {
  enabled: boolean;
}

const esc = (open: string, close: string) => (t: string) => `\u001b[${open}m${t}\u001b[${close}m`;
const bold = esc("1", "22");
const dim = esc("2", "22");
const italic = esc("3", "23");
const underline = esc("4", "24");
/** Inline code, paths, and function names: a light blue. */
const code = esc("38;5;117", "39");
/** Fenced code: a softer tone, so a block reads as one piece. */
const block = esc("38;5;152", "39");

const PATH = /(?<![\w/.@-])((?:~|\.{1,2})?(?:\/?[\w.@-]+\/)+[\w.@-]*[\w@-]|[\w@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|md|json|toml|ya?ml|sh|rs|go|rb|java|kt|swift|c|h|cpp|css|scss|html|sql|txt|lock|env))(?![\w/])/g;
const CALL = /(?<![\w.])([A-Za-z_][\w.]*\(\))/g;

/** A path, not a version (1.2.3), a fraction (10/19), or a pair of words (and/or). */
function looksLikePath(p: string): boolean {
  if (/^[\d./]+$/.test(p)) return false;
  return /^[~./]/.test(p) || /\.[A-Za-z]\w*$/.test(p) || (p.match(/\//g) ?? []).length >= 2;
}

/** Inline markdown in prose: code spans, links, paths and calls, bold, italics. */
export function inline(text: string): string {
  return text
    .split(/(`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\))/)
    .map((part, i) => {
      if (i % 2 === 1) {
        if (part.startsWith("`")) return code(part.slice(1, -1));
        const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part)!;
        return m[1] === m[2] ? underline(m[1]) : `${underline(m[1])} ${dim(`(${m[2]})`)}`;
      }
      return part
        .replace(PATH, (p) => (looksLikePath(p) ? code(p) : p))
        .replace(CALL, (c) => code(c))
        .replace(/\*\*([^*\n]+?)\*\*/g, (_, t: string) => bold(t))
        .replace(/__([^_\n]+?)__/g, (_, t: string) => bold(t))
        .replace(/(^|[^\w*])\*([^*\s][^*\n]*?)\*(?![\w*])/g, (_, pre: string, t: string) => pre + italic(t))
        .replace(/(^|[^\w])_([^_\s][^_\n]*?)_(?!\w)/g, (_, pre: string, t: string) => pre + italic(t));
    })
    .join("");
}

/** A renderer for one stream of lines: it remembers whether it is inside a fenced block. */
export class MarkdownLines {
  private fence?: string;

  constructor(private readonly style: MdStyle = { enabled: true }) {}

  line(raw: string): string {
    if (!this.style.enabled) return raw;
    const fence = /^(\s*)(```+|~~~+)\s*([\w+-]*)\s*$/.exec(raw);
    if (fence && (!this.fence || fence[2].startsWith(this.fence))) {
      const opening = !this.fence;
      this.fence = opening ? fence[2] : undefined;
      return dim(`${fence[1]}${opening ? `┌─${fence[3] ? ` ${fence[3]} ` : ""}` : "└─"}`);
    }
    if (this.fence) return `${dim("│")} ${block(raw)}`;
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) return heading[1].length === 1 ? bold(underline(inline(heading[2]))) : bold(inline(heading[2]));
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) return dim("─".repeat(40));
    const quote = /^(\s*)>\s?(.*)$/.exec(raw);
    if (quote) return `${quote[1]}${dim("│")} ${italic(inline(quote[2]))}`;
    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(raw);
    if (bullet) return `${bullet[1]}${dim("-")} ${inline(bullet[3])}`;
    return inline(raw);
  }

  /** A reply ended: an unclosed fence does not leak into the next one. */
  reset(): void {
    this.fence = undefined;
  }
}

/** A whole text at once (the TUI renders finished blocks this way). */
export function renderMarkdown(text: string, style: MdStyle = { enabled: true }): string {
  const r = new MarkdownLines(style);
  return text
    .split("\n")
    .map((l) => r.line(l))
    .join("\n");
}
