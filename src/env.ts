/**
 * How seat subprocesses are launched: the parent env with every enclosing
 * `node_modules/.bin` on PATH, per-seat overrides, and adapters that ship
 * with the room (claude-agent-acp, codex-acp, ...) resolved by package, so
 * they work from a checkout, a `pnpm link`, and a global install alike.
 */
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let d = dir; ; d = dirname(d)) {
    out.push(d);
    if (dirname(d) === d) return out;
  }
}

/** Every `node_modules/.bin` from this file up to the filesystem root, nearest first. */
export function binDirs(): string[] {
  return ancestors(here)
    .map((d) => join(d, "node_modules", ".bin"))
    .filter((d) => existsSync(d));
}

export function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const path = [...binDirs(), process.env.PATH ?? ""].join(delimiter);
  return { ...process.env, PATH: path, ...overrides };
}

interface PackageJson {
  name?: string;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const readJson = (p: string): PackageJson => JSON.parse(readFileSync(p, "utf8")) as PackageJson;

/** A dependency's directory, found the way Node resolves packages: `node_modules/<name>` in each ancestor. */
function packageDir(name: string, from: string): string | undefined {
  for (const d of ancestors(from)) {
    const p = join(d, "node_modules", ...name.split("/"));
    if (existsSync(join(p, "package.json"))) return p;
  }
  return undefined;
}

let bundled: Map<string, string> | undefined;

/** Executables provided by the room's own dependencies: command name → script path. */
export function bundledBins(): Map<string, string> {
  if (bundled) return bundled;
  bundled = new Map();
  const own = ancestors(here)
    .map((d) => join(d, "package.json"))
    .find((p) => existsSync(p) && readJson(p).name === "@local/room");
  if (!own) return bundled;
  const pkg = readJson(own);
  const deps = { ...pkg.devDependencies, ...pkg.optionalDependencies, ...pkg.dependencies };
  for (const name of Object.keys(deps)) {
    const dir = packageDir(name, dirname(own));
    if (!dir) continue; // an optional dependency that did not install
    const bin = readJson(join(dir, "package.json")).bin;
    const entries = typeof bin === "string" ? [[name.split("/").pop()!, bin]] : Object.entries(bin ?? {});
    for (const [cmd, rel] of entries) if (!bundled.has(cmd)) bundled.set(cmd, join(dir, rel));
  }
  return bundled;
}

/**
 * The command line to spawn for a seat. A bare command that one of the
 * room's dependencies provides runs that script under this Node, which
 * needs neither PATH nor an executable bit; anything else is left to PATH.
 */
export function resolveCommand(command: string, args: string[] = []): { command: string; args: string[] } {
  if (!command.includes(sep) && !command.includes("/")) {
    const script = bundledBins().get(command);
    if (script && /\.(c|m)?js$/.test(script)) return { command: process.execPath, args: [script, ...args] };
    if (script) return { command: script, args };
  }
  return { command, args };
}
