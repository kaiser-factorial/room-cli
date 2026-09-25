/**
 * Seat colours in the terminal, by harness, so a seat reads the same in
 * every room: laguna is pool wearing a persona, and is pool's colour.
 * Values are 256-colour palette indexes.
 */
import { basename } from "node:path";
import type { SeatConfig } from "../seat/types.js";

export const NAMED_COLOURS: Record<string, number> = {
  white: 15,
  orange: 173,
  purple: 141,
  green: 77,
  "light-blue": 117,
  amber: 214,
  yellow: 220,
  red: 167,
  pink: 211,
  teal: 80,
  grey: 250,
};

export const HARNESS_COLOURS: Record<string, number> = {
  grok: NAMED_COLOURS.white,
  claude: NAMED_COLOURS.orange,
  codex: NAMED_COLOURS.purple,
  agy: NAMED_COLOURS.green,
  pool: NAMED_COLOURS["light-blue"],
  hermes: NAMED_COLOURS.amber,
};

/** Which harness a seat runs, from its command: `claude-agent-acp` and `claude` are both claude. */
export function harnessOf(config: SeatConfig): string | undefined {
  const cmd = basename(config.command).replace(/-acp$/, "").replace(/-agent$/, "");
  const known: Record<string, string> = { antigravity: "agy" };
  const h = known[cmd] ?? cmd;
  if (h in HARNESS_COLOURS) return h;
  return config.name in HARNESS_COLOURS ? config.name : undefined;
}

/** A colour name or a 0-255 index, else undefined. */
export function parseColour(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 && value <= 255 ? value : undefined;
  if (value in NAMED_COLOURS) return NAMED_COLOURS[value];
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 255 ? n : undefined;
}

/** A seat's colour: its own `colour` setting, else its harness's, else none (the UI picks). */
export function seatColour(config: SeatConfig): number | undefined {
  return parseColour(config.colour) ?? (harnessOf(config) ? HARNESS_COLOURS[harnessOf(config)!] : undefined);
}
