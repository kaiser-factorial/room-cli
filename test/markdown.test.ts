import { describe, expect, it } from "vitest";
import { inline, MarkdownLines, renderMarkdown } from "../src/ui/markdown.js";

// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\u001b\[[\d;]*m/g, "");
const CODE = "\u001b[38;5;117m";

describe("markdown in the terminal", () => {
  it("styles inline markdown and drops its markers", () => {
    const out = inline("the **eval metrics** use `metrics.py`, see [docs](https://x.dev/a) and *this*");
    expect(plain(out)).toBe("the eval metrics use metrics.py, see docs (https://x.dev/a) and this");
    expect(out).toContain("\u001b[1meval metrics");
    expect(out).toContain(`${CODE}metrics.py`);
    expect(out).toContain("\u001b[3mthis");
  });

  it("colours paths and calls, not versions, fractions, word pairs, or snake_case", () => {
    const out = inline("edit src/room.ts and ~/Projects/x, call run_eval(), v1.2.3, 10/19, and/or snake_case_name.");
    expect(out).toContain(`${CODE}src/room.ts`);
    expect(out).toContain(`${CODE}~/Projects/x\u001b[39m,`);
    expect(out).toContain(`${CODE}run_eval()`);
    for (const raw of ["1.2.3", "10/19", "and/or", "snake_case_name"]) expect(out).toContain(raw);
    expect(out).not.toContain(`${CODE}10/19`);
    expect(out).not.toContain(`${CODE}and/or`);
  });

  it("renders a fenced block as code, untouched inside, and knows when it ends", () => {
    const r = new MarkdownLines();
    const lines = ["```sh", "cd **not bold** && run", "```", "after **bold**"].map((l) => r.line(l));
    expect(plain(lines[0])).toBe("┌─ sh ");
    expect(plain(lines[1])).toBe("│ cd **not bold** && run");
    expect(plain(lines[2])).toBe("└─");
    expect(plain(lines[3])).toBe("after bold");
  });

  it("headings, bullets, quotes, and rules", () => {
    expect(plain(renderMarkdown("## Found\n- **a**: b\n> quoted\n---"))).toBe(`Found\n- a: b\n│ quoted\n${"─".repeat(40)}`);
  });

  it("is plain text when styling is off", () => {
    expect(new MarkdownLines({ enabled: false }).line("**raw** `x`")).toBe("**raw** `x`");
  });
});
