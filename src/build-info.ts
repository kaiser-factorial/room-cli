/**
 * What `pnpm build` stamps into dist/build.json: the commit the running
 * room was built from, so a room over this very repo can say when its
 * trunk lacks that commit.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface BuildStamp {
  sha: string;
  branch?: string;
  toplevel: string;
  at: string;
}

export function buildStamp(): BuildStamp | undefined {
  // dist/src/build-info.js → dist/build.json. From source (tsx, tests) there is none.
  const path = fileURLToPath(new URL("../build.json", import.meta.url));
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BuildStamp;
  } catch {
    return undefined;
  }
}
