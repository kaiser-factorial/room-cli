/**
 * Your defaults, set once in the menu: who joins a room, their roles and
 * personas, your name, the moderator, and which skills and MCP servers are
 * shared. `~/.config/room/config.toml` (or `$ROOM_CONFIG_DIR`).
 *
 * Secrets live apart, in `secrets.toml` beside it, readable only by you:
 * the OpenRouter key for the moderator. An environment variable wins.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { ConfigError } from "./config.js";

export interface Settings {
  /** Your name in the transcript. */
  human?: string;
  /** Who joins a room when you name no seats. */
  seats?: string[];
  /** Role presets by seat (the web app's roles). */
  roles?: Record<string, string>;
  /** Persona text by seat, appended to its preamble. */
  personas?: Record<string, string>;
  /** `auto`, `you`, `off`, or an OpenRouter model id. */
  moderator?: string;
  wake?: "last" | "all";
  cap?: number | "off";
  /** Open rooms in the TUI. */
  tui?: boolean;
  /** Offer every seat the skills found in any harness's config (the room's `skills` tool). Default on. */
  shareSkills?: boolean;
  /** MCP servers (by name, from any harness's config) to hand to every seat. */
  shareMcp?: string[];
  /** Ignored paths a desk borrows from the main checkout by link (names, * allowed). [] turns it off. */
  deskLinks?: string[];
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ROOM_CONFIG_DIR ?? join(homedir(), ".config", "room");
}

export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.toml");
}

export function hasSettings(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(settingsPath(env));
}

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const path = settingsPath(env);
  if (!existsSync(path)) return {};
  let doc: Record<string, unknown>;
  try {
    doc = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    throw new ConfigError(`${path}: ${(err as Error).message}`);
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  const map = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "string")) as Record<string, string>
      : undefined;
  return {
    human: str(doc.human),
    seats: strs(doc.seats),
    roles: map(doc.roles),
    personas: map(doc.personas),
    moderator: str(doc.moderator),
    wake: doc.wake === "all" || doc.wake === "last" ? doc.wake : undefined,
    cap: typeof doc.cap === "number" ? doc.cap : doc.cap === "off" ? "off" : undefined,
    tui: typeof doc.tui === "boolean" ? doc.tui : undefined,
    shareSkills: typeof doc.shareSkills === "boolean" ? doc.shareSkills : undefined,
    shareMcp: strs(doc.shareMcp),
    deskLinks: strs(doc.deskLinks),
  };
}

export function saveSettings(s: Settings, env: NodeJS.ProcessEnv = process.env): string {
  mkdirSync(configDir(env), { recursive: true });
  const clean = Object.fromEntries(
    Object.entries(s).filter(([, v]) => v !== undefined && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)),
  );
  const path = settingsPath(env);
  writeFileSync(path, "# room defaults, written by the menu (room menu). Edit freely.\n" + stringify(clean) + "\n");
  return path;
}

// ---- secrets ----

export function secretsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "secrets.toml");
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): { openrouterApiKey?: string } {
  const path = secretsPath(env);
  if (!existsSync(path)) return {};
  try {
    const doc = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return { openrouterApiKey: typeof doc.openrouter_api_key === "string" ? doc.openrouter_api_key : undefined };
  } catch {
    return {};
  }
}

/** Save (or with undefined, forget) the OpenRouter key, in a file only you can read. */
export function saveOpenRouterKey(key: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
  const path = secretsPath(env);
  const body = key ? stringify({ openrouter_api_key: key }) + "\n" : "";
  writeFileSync(path, body, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** Put saved secrets into the environment, unless it already has them. */
export function applySecrets(env: NodeJS.ProcessEnv = process.env): void {
  const s = loadSecrets(env);
  if (s.openrouterApiKey && !env.OPENROUTER_API_KEY) env.OPENROUTER_API_KEY = s.openrouterApiKey;
}

/** `sk-or-v1-abcd…wxyz`: enough to recognise a key, not enough to use it. */
export function maskKey(key: string | undefined): string {
  if (!key) return "not set";
  return key.length <= 12 ? "set" : `${key.slice(0, 8)}…${key.slice(-4)}`;
}
