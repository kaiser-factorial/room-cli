/**
 * Commit-per-turn versioning. The room owns git; seats are told not to touch it.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

export async function isRepo(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ["rev-parse", "--is-inside-work-tree"])) === "true";
  } catch {
    return false;
  }
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/** Create and check out `room/<name>` from the current HEAD, or reuse it. */
export async function ensureRoomBranch(cwd: string, name: string): Promise<string> {
  const branch = `room/${name}`;
  const existing = await git(cwd, ["branch", "--list", branch]);
  if (existing) await git(cwd, ["checkout", "-q", branch]);
  else await git(cwd, ["checkout", "-q", "-b", branch]);
  return branch;
}

export interface TurnCommit {
  sha: string;
  /** e.g. "2 files changed, 14 insertions(+), 3 deletions(-)" */
  stat: string;
  files: string[];
}

/**
 * Stage everything except the room's own state directory and commit as the
 * seat. Returns null when the turn changed nothing.
 */
export async function commitTurn(
  cwd: string,
  seat: string,
  message: string,
  exclude: string[] = [".room"],
): Promise<TurnCommit | null> {
  await git(cwd, ["add", "-A", "--", ".", ...exclude.map((e) => `:!${e}`)]);
  const staged = await git(cwd, ["diff", "--cached", "--name-only"]);
  if (!staged) return null;
  await git(cwd, [
    "-c",
    `user.name=${seat}`,
    "-c",
    `user.email=${seat}@room`,
    "commit",
    "-q",
    "--no-verify",
    "--author",
    `${seat} <${seat}@room>`,
    "-m",
    message,
  ]);
  const sha = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  const stat = (await git(cwd, ["show", "--stat", "--format=", "HEAD"])).split("\n").pop()?.trim() ?? "";
  return { sha, stat, files: staged.split("\n") };
}
