import { describe, expect, it } from "vitest";
import { defaultRoster } from "../src/config.js";
import { harnessOf, seatColour } from "../src/ui/colours.js";

describe("seat colours", () => {
  it("follow the harness: grok white, claude orange, codex purple, agy green, pool light blue, hermes amber", () => {
    const byName = Object.fromEntries(defaultRoster().seats.map((s) => [s.name, seatColour(s)]));
    expect(byName).toEqual({ claude: 173, codex: 141, grok: 15, hermes: 214, pool: 117, agy: 77, laguna: 117 });
  });

  it("know a harness by its CLI too, and let the roster override", () => {
    expect(harnessOf({ name: "c", adapter: "cli", command: "/opt/homebrew/bin/claude" })).toBe("claude");
    expect(seatColour({ name: "c", adapter: "acp", command: "claude-agent-acp", colour: "teal" })).toBe(80);
    expect(seatColour({ name: "c", adapter: "acp", command: "claude-agent-acp", colour: "33" })).toBe(33);
    expect(seatColour({ name: "x", adapter: "acp", command: "mystery" })).toBeUndefined();
  });
});
