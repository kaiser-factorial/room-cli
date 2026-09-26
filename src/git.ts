/**
 * Commit-per-turn versioning. The room owns git; seats are told not to touch it.
 */
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
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

export async function headSha(cwd: string): Promise<string> {
  return git(cwd, ["rev-parse", "--short", "HEAD"]);
}

export async function headSubject(cwd: string): Promise<string> {
  return git(cwd, ["log", "-1", "--format=%s"]);
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

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * A seat's desk: a worktree at `path` on `branch`, branched from `from` the
 * first time. Reopening a room reuses it.
 */
export async function ensureWorktree(cwd: string, path: string, branch: string, from: string): Promise<void> {
  if (existsSync(join(path, ".git"))) return;
  await git(cwd, ["worktree", "prune"]);
  if (await refExists(cwd, `refs/heads/${branch}`)) await git(cwd, ["worktree", "add", "-q", path, branch]);
  else await git(cwd, ["worktree", "add", "-q", "-b", branch, path, from]);
}

/** Commits on `to` that `from` does not have. */
export async function commitsAhead(cwd: string, from: string, to: string): Promise<number> {
  return Number(await git(cwd, ["rev-list", "--count", `${from}..${to}`]));
}

export type MergeResult =
  | { status: "up-to-date" }
  | { status: "merged"; sha: string; commits: number; stat: string; files: string[] }
  | { status: "conflict"; files: string[] };

/**
 * Merge `ref` into the branch checked out at `cwd`, fast-forwarding when it
 * can, as `author` when it cannot. A conflict is aborted, leaving the tree
 * as it was, and reported with the conflicted files.
 */
export async function mergeRef(cwd: string, ref: string, author: string): Promise<MergeResult> {
  const before = await git(cwd, ["rev-parse", "HEAD"]);
  const commits = await commitsAhead(cwd, before, ref);
  if (commits === 0) return { status: "up-to-date" };
  try {
    await git(cwd, ["-c", `user.name=${author}`, "-c", `user.email=${author}@room`, "merge", "-q", "--no-edit", ref]);
  } catch {
    const files = (await git(cwd, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
    await git(cwd, ["merge", "--abort"]).catch(() => undefined);
    return { status: "conflict", files };
  }
  const sha = await git(cwd, ["rev-parse", "--short", "HEAD"]);
  const stat = (await git(cwd, ["diff", "--shortstat", before, "HEAD"])).trim();
  const files = (await git(cwd, ["diff", "--name-only", before, "HEAD"])).split("\n").filter(Boolean);
  return { status: "merged", sha, commits, stat, files };
}

/** `git diff <args>`, for showing a seat's work. */
export async function diffText(cwd: string, args: string[]): Promise<string> {
  return git(cwd, ["diff", ...args]);
}

/**
 * A desk is a fresh checkout: no node_modules, no .env. Link the main
 * checkout's into it (top level and one or two levels down, e.g.
 * packages/room/node_modules), but only paths git ignores, so a link is
 * never committed. Returns what was linked, relative to the repo.
 */
export async function linkIgnored(cwd: string, desk: string): Promise<string[]> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const candidates: string[] = [];
  const scan = (rel: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(join(top, rel));
    } catch {
      return;
    }
    for (const n of names) {
      const r = rel ? join(rel, n) : n;
      if (n === "node_modules" || /^\.env(\..+)?$/.test(n)) candidates.push(r);
      else if (depth > 0 && !n.startsWith(".") && isDirSync(join(top, r))) scan(r, depth - 1);
    }
  };
  scan("", 2);
  const linked: string[] = [];
  for (const rel of candidates) {
    const at = join(desk, rel);
    if (existsSync(at) || !existsSync(dirname(at))) continue;
    const ignored = await git(top, ["check-ignore", "-q", rel]).then(() => true, () => false);
    if (!ignored) continue;
    symlinkSync(join(top, rel), at);
    linked.push(rel);
  }
  return linked;
}

function isDirSync(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
