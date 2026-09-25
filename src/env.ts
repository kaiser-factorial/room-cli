/**
 * Environment for seat subprocesses: the parent env, the workspace `.bin`
 * directories on PATH so adapters installed as dev dependencies resolve, and
 * per-seat overrides.
 */
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** packages/room and the repo root, whichever holds node_modules/.bin. */
export function binDirs(): string[] {
  const candidates = [
    join(here, "..", "node_modules", ".bin"),
    join(here, "..", "..", "node_modules", ".bin"),
    join(here, "..", "..", "..", "node_modules", ".bin"),
  ];
  return candidates.filter((d) => existsSync(d));
}

export function childEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const path = [...binDirs(), process.env.PATH ?? ""].join(delimiter);
  return { ...process.env, PATH: path, ...overrides };
}
