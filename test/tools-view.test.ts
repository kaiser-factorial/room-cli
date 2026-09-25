import { describe, expect, it } from "vitest";
import { ToolView, toolSummary } from "../src/ui/tools.js";

describe("ToolView, compact", () => {
  it("prints one line per call when it finishes, numbered, and a start line only for commands", () => {
    const v = new ToolView();
    expect(v.lines("g", { type: "tool_call", id: "1", title: "read_file", kind: "read" })).toEqual([]);
    expect(v.lines("g", { type: "tool_update", id: "1", status: "completed", title: "Read a.ts", content: [{ type: "text", text: "one\ntwo\nthree" }] })).toEqual([
      "· Read a.ts → one (+2 lines) #1",
    ]);
    expect(v.lines("g", { type: "tool_call", id: "2", title: "Execute `pnpm test`", kind: "execute" })).toEqual(["· Execute `pnpm test` #2"]);
    expect(v.lines("g", { type: "tool_update", id: "2", status: "completed", content: [{ type: "text", text: "88 passed\n" }] })).toEqual(["  ↳ 88 passed"]);
    // A late duplicate update prints nothing more.
    expect(v.lines("g", { type: "tool_update", id: "2", status: "completed" })).toEqual([]);
  });

  it("summarises edits, failures, and a harness's JSON input without its fences", () => {
    expect(toolSummary([{ type: "diff", path: "x", oldText: "a\nb\n", newText: "a\nc\nd\n" }])).toBe("(+2 -1)");
    expect(toolSummary([{ type: "text", text: '```\n{\n  "CommandLine": "ls -la",\n}\n```' }])).toBe('→ "CommandLine": "ls -la", (+0 lines)'.replace(" (+0 lines)", ""));
    const v = new ToolView();
    v.lines("g", { type: "tool_call", id: "w", title: "Write x", kind: "edit" });
    expect(v.lines("g", { type: "tool_update", id: "w", status: "failed" })).toEqual(["· Write x (failed) #1"]);
  });

  it("owns up to calls that never finished when the turn ends, and finds any call for /show", () => {
    const v = new ToolView();
    v.lines("g", { type: "tool_call", id: "1", title: "Search", kind: "search" });
    v.lines("h", { type: "tool_call", id: "1", title: "Fetch", kind: "fetch", status: "completed", content: [{ type: "text", text: "ok" }] });
    expect(v.unfinished("g")).toEqual(["· Search (no result) #1"]);
    expect(v.find("2")?.title).toBe("Fetch");
    expect(v.find("#1")?.seat).toBe("g");
    expect(v.find("h")?.n).toBe(2);
    expect(v.find()?.n).toBe(2);
  });
});
