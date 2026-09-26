/**
 * Roster loading. The roster is every seat you have set up; a room is the
 * subset you name when starting a session. Nothing joins by default.
 *
 * Search order: `--roster <file>`, `.room.toml` in the working directory,
 * `~/.config/room/roster.toml`, then the built-in defaults for the six
 * harnesses on this machine.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type { SeatConfig } from "./seat/types.js";

export interface Roster {
  seats: SeatConfig[];
  /** Where it came from, for `room roster` output. */
  source: string;
}

export function defaultRoster(): Roster {
  const seats: SeatConfig[] = [
    { name: "claude", adapter: "acp", command: "claude-agent-acp" },
    { name: "codex", adapter: "acp", command: "codex-acp" },
    { name: "grok", adapter: "acp", command: "grok", args: ["agent", "stdio"] },
    { name: "hermes", adapter: "acp", command: "hermes", args: ["acp"] },
    // Pool's sandbox is Docker-backed and fails when the daemon is down; the
    // Laguna launcher disables it by default too.
    { name: "pool", adapter: "acp", command: "pool", args: ["acp", "--sandbox", "disabled"] },
    {
      name: "agy",
      adapter: "acp",
      command: "antigravity-acp",
      // The community adapter downloads its own agy unless told where ours is.
      env: process.env.AGY_BIN ? {} : { AGY_BIN: findOnPath("agy") ?? "agy" },
    },
    // Laguna: pool wearing its journal identity.
    {
      name: "laguna",
      adapter: "acp",
      command: "pool",
      args: ["acp", "--sandbox", "disabled"],
      promptFile: join(homedir(), "Projects", "AGENT_JOURNAL", "laguna", "SOUL.md"),
    },
  ];
  return { seats, source: "built-in defaults" };
}

export function rosterPaths(cwd = process.cwd()): string[] {
  return [join(cwd, ".room.toml"), join(homedir(), ".config", "room", "roster.toml")];
}

export function loadRoster(explicit?: string, cwd = process.cwd()): Roster {
  const candidates = explicit ? [explicit] : rosterPaths(cwd);
  for (const p of candidates) {
    if (!existsSync(p)) {
      if (explicit) throw new ConfigError(`roster not found: ${p}`);
      continue;
    }
    return { seats: parseRoster(readFileSync(p, "utf8"), p), source: p };
  }
  return defaultRoster();
}

export function parseRoster(text: string, source: string): SeatConfig[] {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (err) {
    throw new ConfigError(`${source}: ${(err as Error).message}`);
  }
  const seats = (doc as { seats?: unknown }).seats;
  if (!Array.isArray(seats) || seats.length === 0) {
    throw new ConfigError(`${source}: expected at least one [[seats]] table`);
  }
  const names = new Set<string>();
  return seats.map((raw, i) => {
    const s = raw as Record<string, unknown>;
    const name = str(s.name, `${source}: seats[${i}].name`);
    validateSeatName(name, source);
    if (names.has(name)) throw new ConfigError(`${source}: duplicate seat name "${name}"`);
    names.add(name);
    const adapter = s.adapter ?? "acp";
    if (adapter !== "acp" && adapter !== "cli") {
      throw new ConfigError(`${source}: seats[${i}].adapter must be "acp" or "cli"`);
    }
    return {
      name,
      adapter,
      command: str(s.command, `${source}: seats[${i}].command`),
      args: optStrArray(s.args, `${source}: seats[${i}].args`),
      env: optStrMap(s.env, `${source}: seats[${i}].env`),
      model: typeof s.model === "string" ? s.model : undefined,
      role: typeof s.role === "string" ? s.role : undefined,
      prompt: typeof s.prompt === "string" ? s.prompt : undefined,
      promptFile: typeof s.promptFile === "string" ? s.promptFile : undefined,
      cli: typeof s.cli === "string" ? s.cli : undefined,
      mode: typeof s.mode === "string" ? s.mode : undefined,
      colour: typeof s.colour === "string" || typeof s.colour === "number" ? String(s.colour) : undefined,
      allow: optStrArray(s.allow, `${source}: seats[${i}].allow`),
      ask: optStrArray(s.ask, `${source}: seats[${i}].ask`),
      deny: optStrArray(s.deny, `${source}: seats[${i}].deny`),
    };
  });
}

/**
 * A room file pins a lineup and per-seat overrides:
 *
 *   seats = ["claude", "grok"]
 *   [modes]
 *   claude = "default"
 *   [policy.claude]
 *   allow = ["read"]
 *   [roles]
 *   grok = "critic"
 */
export interface RoomFile {
  seats?: string[];
  modes?: Record<string, string>;
  roles?: Record<string, string>;
  /** A command that must pass in a seat's desk before its work lands. */
  landCheck?: string;
  policy?: Record<string, { allow?: string[]; ask?: string[]; deny?: string[] }>;
}

export function loadRoomFile(path: string): RoomFile {
  if (!existsSync(path)) throw new ConfigError(`room file not found: ${path}`);
  let doc: Record<string, unknown>;
  try {
    doc = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(`${path}: ${(err as Error).message}`);
  }
  const out: RoomFile = {};
  out.seats = optStrArray(doc.seats, `${path}: seats`);
  out.modes = optStrMap(doc.modes, `${path}: modes`);
  out.roles = optStrMap(doc.roles, `${path}: roles`);
  if (typeof doc.landCheck === "string") out.landCheck = doc.landCheck;
  if (doc.policy !== undefined) {
    if (typeof doc.policy !== "object" || doc.policy === null) throw new ConfigError(`${path}: policy must be a table`);
    out.policy = {};
    for (const [seat, v] of Object.entries(doc.policy as Record<string, Record<string, unknown>>)) {
      out.policy[seat] = {
        allow: optStrArray(v.allow, `${path}: policy.${seat}.allow`),
        ask: optStrArray(v.ask, `${path}: policy.${seat}.ask`),
        deny: optStrArray(v.deny, `${path}: policy.${seat}.deny`),
      };
    }
  }
  return out;
}

/** Apply a room file's overrides to the picked seats. */
export function applyRoomFile(seats: SeatConfig[], room: RoomFile): SeatConfig[] {
  return seats.map((s) => ({
    ...s,
    mode: room.modes?.[s.name] ?? s.mode,
    role: room.roles?.[s.name] ?? s.role,
    allow: [...(s.allow ?? []), ...(room.policy?.[s.name]?.allow ?? [])],
    ask: [...(s.ask ?? []), ...(room.policy?.[s.name]?.ask ?? [])],
    deny: [...(s.deny ?? []), ...(room.policy?.[s.name]?.deny ?? [])],
  }));
}

/** Pick seats by name, preserving the order given. Unknown names are an error. */
export function pickSeats(roster: Roster, names: string[]): SeatConfig[] {
  if (names.length === 0) return roster.seats;
  return names.map((n) => {
    const seat = roster.seats.find((s) => s.name === n);
    if (!seat) {
      const known = roster.seats.map((s) => s.name).join(", ");
      throw new ConfigError(`unknown seat "${n}" (roster has: ${known})`);
    }
    return seat;
  });
}

export class ConfigError extends Error {}

/** Seat names are addresses (`@name`) and transcript labels, so they are restricted. */
export function validateSeatName(name: string, source = "roster"): void {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    throw new ConfigError(`${source}: seat name "${name}" must be letters, digits, - or _ (it is used as @name)`);
  }
  if (name.toLowerCase() === "room") throw new ConfigError(`${source}: seat name "${name}" is reserved for the orchestrator`);
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) throw new ConfigError(`${what} must be a non-empty string`);
  return v;
}

function optStrArray(v: unknown, what: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new ConfigError(`${what} must be an array of strings`);
  }
  return v as string[];
}

function optStrMap(v: unknown, what: string): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ConfigError(`${what} must be a table of strings`);
  }
  for (const [k, val] of Object.entries(v)) {
    if (typeof val !== "string") throw new ConfigError(`${what}.${k} must be a string`);
  }
  return v as Record<string, string>;
}

function findOnPath(cmd: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, cmd);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}
