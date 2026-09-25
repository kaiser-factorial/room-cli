import { describe, expect, it } from "vitest";
import { compactDiff, renderToolContent } from "../src/ui/render.js";

describe("compactDiff", () => {
  it("shows only the changed lines of a small edit in a bigger file", () => {
    const before = "a\nb\nc\nd\ne\n";
    const after = "a\nb\nC\nd\ne\n";
    expect(compactDiff(before, after)).toEqual(["-c", "+C"]);
  });

  it("marks a new file and caps long output", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const out = compactDiff(undefined, lines);
    expect(out[0]).toBe("(new file, 40 lines)");
    expect(out.at(-1)).toMatch(/more lines/);
    expect(out.length).toBe(24 + 2);
  });

  it("handles insertions and deletions without an LCS", () => {
    expect(compactDiff("a\nb\n", "a\nx\ny\nb\n")).toEqual(["+x", "+y"]);
    expect(compactDiff("a\nx\nb\n", "a\nb\n")).toEqual(["-x"]);
  });
});

describe("renderToolContent", () => {
  it("renders a diff with its path and output as a boxed tail", () => {
    const lines = renderToolContent([
      { type: "diff", path: "hello.py", oldText: "x = 1\n", newText: "x = 2\n" },
      { type: "text", text: "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n" },
    ]);
    expect(lines).toEqual([
      "    hello.py",
      "    -x = 1",
      "    +x = 2",
      "    │ one",
      "    │ two",
      "    │ three",
      "    │ four",
      "    │ five",
      "    │ six",
      "    │ seven",
      "    │ eight",
      "    │ … 2 more lines",
    ]);
    expect(renderToolContent(undefined)).toEqual([]);
  });
});
