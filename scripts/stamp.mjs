// After tsc: record the commit this build came from (see src/build-info.ts).
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const git = (...a) => {
  try {
    return execFileSync("git", a, { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
};
const stamp = { sha: git("rev-parse", "HEAD"), branch: git("rev-parse", "--abbrev-ref", "HEAD"), toplevel: git("rev-parse", "--show-toplevel"), at: new Date().toISOString() };
if (stamp.sha) writeFileSync("dist/build.json", JSON.stringify(stamp, null, 2) + "\n");
