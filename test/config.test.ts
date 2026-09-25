import { describe, expect, it } from "vitest";
import { ConfigError, defaultRoster, parseRoster, pickSeats } from "../src/config.js";
import { EXIT, worst } from "../src/exit-codes.js";

describe("parseRoster", () => {
  it("parses seats with args and env", () => {
    const seats = parseRoster(
      `[[seats]]
name = "grok"
command = "grok"
args = ["agent", "stdio"]

[seats.env]
GROK_HOME = "/tmp/x"

[[seats]]
name = "pool"
adapter = "acp"
command = "pool"
args = ["acp", "--sandbox", "disabled"]
role = "critic"
`,
      "test",
    );
    expect(seats.map((s) => s.name)).toEqual(["grok", "pool"]);
    expect(seats[0].adapter).toBe("acp");
    expect(seats[0].env).toEqual({ GROK_HOME: "/tmp/x" });
    expect(seats[1].args).toEqual(["acp", "--sandbox", "disabled"]);
    expect(seats[1].role).toBe("critic");
  });

  it("rejects duplicate names, bad adapters, and missing commands", () => {
    expect(() => parseRoster(`[[seats]]\nname="a"\ncommand="x"\n[[seats]]\nname="a"\ncommand="y"\n`, "t")).toThrow(
      ConfigError,
    );
    expect(() => parseRoster(`[[seats]]\nname="a"\ncommand="x"\nadapter="ssh"\n`, "t")).toThrow(/adapter/);
    expect(() => parseRoster(`[[seats]]\nname="a"\n`, "t")).toThrow(/command/);
    expect(() => parseRoster(`title = "no seats"\n`, "t")).toThrow(/seats/);
    expect(() => parseRoster(`this is not toml = = =`, "t")).toThrow(ConfigError);
  });
});

describe("pickSeats", () => {
  it("returns the whole roster when no names are given, else the named seats in order", () => {
    const roster = defaultRoster();
    expect(pickSeats(roster, []).length).toBe(roster.seats.length);
    expect(pickSeats(roster, ["pool", "claude"]).map((s) => s.name)).toEqual(["pool", "claude"]);
  });

  it("names unknown seats and lists the roster", () => {
    expect(() => pickSeats(defaultRoster(), ["gemini"])).toThrow(/unknown seat "gemini".*claude/);
  });
});

describe("exit codes", () => {
  it("reports the worst decade", () => {
    expect(worst([])).toBe(EXIT.OK);
    expect(worst([EXIT.OK, EXIT.SEAT_START, EXIT.AUTH])).toBe(EXIT.AUTH);
    expect(worst([EXIT.PERMISSIONS, EXIT.CONFIG])).toBe(EXIT.PERMISSIONS);
  });
});
