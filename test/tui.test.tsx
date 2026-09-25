/** The TUI's store, and the Ink app rendered to a string frame. */
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { shortPath } from "../src/ui/render.js";
import { App } from "../src/ui/tui/app.js";
import { TuiStore } from "../src/ui/tui/store.js";

const tick = () => new Promise((r) => setTimeout(r, 30));
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const strip = (s: string | undefined) => (s ?? "").replace(SGR, "");

describe("TuiStore", () => {
  it("keeps a seat's turn live while it runs, then moves it to scrollback in one piece", () => {
    const s = new TuiStore();
    s.seatEvent("grok", { type: "thought", text: "checking the parser before I answer" });
    s.seatEvent("grok", { type: "tool_call", id: "1", title: "Read parser.ts", kind: "read" });
    s.seatEvent("grok", { type: "tool_update", id: "1", status: "completed", content: [{ type: "text", text: "export {}" }] });
    s.seatEvent("grok", { type: "text", text: "It is fine." });
    expect(s.live.size).toBe(1);
    expect(s.doing.get("grok")).toBe("writing…");
    s.seatEvent("grok", { type: "stop", stopReason: "end_turn" });
    expect(s.live.size).toBe(0);
    expect(s.doing.has("grok")).toBe(false);
    expect(s.finished.at(-1)!.parts).toEqual([
      { type: "thought", text: "checking the parser before I answer" },
      { type: "tool", line: "· Read parser.ts → export {} #1" },
      { type: "text", text: "It is fine." },
    ]);
  });

  it("keeps a background seat's block apart from the same seat's foreground", () => {
    const s = new TuiStore();
    s.seatEvent("grok", { type: "text", text: "bg work" }, true);
    s.seatEvent("claude", { type: "text", text: "fg reply" });
    expect([...s.live.keys()]).toEqual(["grok#bg", "claude"]);
    expect(s.live.get("grok#bg")!.bg).toBe(true);
    expect(s.doing.get("grok")).toBe("writing (bg)");
  });

  it("queues questions and answers them in order", async () => {
    const s = new TuiStore();
    const req = (seat: string) => ({ seat, sessionId: "s", toolCallId: "t", title: "Edit x", kind: "edit", options: [] });
    const first = s.ask(req("a"));
    const second = s.ask(req("b"));
    expect(s.asks.map((a) => a.req.seat)).toEqual(["a", "b"]);
    s.asks[0].resolve("allow");
    expect(await first).toBe("allow");
    s.asks[0].resolve("deny");
    expect(await second).toBe("deny");
    expect(s.asks).toEqual([]);
  });
});

describe("TUI app", () => {
  const chips = () => [
    { name: "claude", colour: 173, benched: false, background: false },
    { name: "grok", colour: 15, benched: false, background: true },
  ];

  it("shows scrollback, live seats, what each seat is doing, and the input", async () => {
    const s = new TuiStore();
    s.human("Corina", "hi both");
    s.seatEvent("claude", { type: "text", text: "Hello!" });
    s.seatEvent("claude", { type: "stop", stopReason: "end_turn" });
    s.seatEvent("grok", { type: "tool_call", id: "1", title: "Execute `pnpm test`", kind: "execute" }, true);
    const ui = render(<App store={s} human="Corina" room="room main" seats={chips} flags={() => ["auto"]} onSubmit={() => {}} />);
    await tick();
    const frame = strip(ui.lastFrame());
    expect(frame).toContain("Corina> hi both");
    expect(frame).toMatch(/claude\s*\nHello!/);
    expect(frame).toContain("grok (background) …");
    expect(frame).toContain("· Execute `pnpm test` #1");
    expect(frame).toContain("○ claude idle");
    expect(frame).toContain("● grok (bg) · Execute `pnpm test`");
    expect(frame).toContain("auto");
    ui.unmount();
  });

  it("swaps the input for a question bar, answered with one key", async () => {
    const s = new TuiStore();
    const answer = s.ask({
      seat: "grok",
      sessionId: "s",
      toolCallId: "t",
      title: "Edit calc.py",
      kind: "edit",
      options: [],
      content: [{ type: "diff", path: "/x/.room/main/desks/grok/calc.py", oldText: "a - b\n", newText: "a + b\n" }],
    });
    const ui = render(<App store={s} human="Corina" room="room main" seats={chips} flags={() => []} onSubmit={() => {}} />);
    await tick();
    const frame = strip(ui.lastFrame());
    expect(frame).toContain("? grok wants: Edit calc.py [edit]");
    expect(frame).toContain("calc.py");
    expect(frame).not.toContain("/x/.room");
    expect(frame).toContain("-a - b");
    expect(frame).not.toContain("Corina>");
    ui.stdin.write("A");
    expect(await answer).toBe("allow_always");
    await tick();
    expect(strip(ui.lastFrame())).toContain("Corina>");
    ui.unmount();
  });

  it("sends typed lines on Enter", async () => {
    const got: string[] = [];
    const ui = render(<App store={new TuiStore()} human="Corina" room="r" seats={chips} flags={() => []} onSubmit={(t) => got.push(t)} />);
    await tick();
    ui.stdin.write("@grok look");
    await tick();
    ui.stdin.write("\r");
    await tick();
    expect(got).toEqual(["@grok look"]);
    ui.unmount();
  });
});

describe("shortPath", () => {
  it("reads a desk path relative to the desk", () => {
    expect(shortPath("/Users/c/p/.room/main/desks/grok/src/calc.py")).toBe("src/calc.py");
    expect(shortPath("/w/repo/a.ts", "/w/repo")).toBe("a.ts");
  });
});
