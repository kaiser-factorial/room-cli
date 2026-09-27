/**
 * Commit-per-turn versioning. The room owns git; seats are told not to touch it.
 */
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, statSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
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

/** A checkout with unresolved merge conflicts: committing would commit the markers. */
export class MidMergeError extends Error {
  constructor(readonly files: string[]) {
    super(`a merge is under way with unresolved conflicts in ${files.join(", ")}; resolve them (or git merge --abort) first`);
  }
}

/** Paths with unresolved conflicts. */
export async function unmerged(cwd: string): Promise<string[]> {
  return (await git(cwd, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")).split("\n").filter(Boolean);
}

/** A symlink to an absolute path outside the checkout: one of the room's desk links. */
function isOutsideLink(cwd: string, rel: string): boolean {
  try {
    if (!lstatSync(join(cwd, rel)).isSymbolicLink()) return false;
    const target = readlinkSync(join(cwd, rel));
    return isAbsolute(target) && !resolve(target).startsWith(resolve(cwd) + sep);
  } catch {
    return false;
  }
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
  const conflicted = await unmerged(cwd);
  if (conflicted.length) throw new MidMergeError(conflicted);
  await git(cwd, ["add", "-A", "--", ".", ...exclude.map((e) => `:!${e}`)]);
  // A desk's links to the main checkout (node_modules, .venv) are never work:
  // a `node_modules/` ignore pattern does not match a symlink, so unstage them.
  const added = (await git(cwd, ["diff", "--cached", "--name-only", "--diff-filter=A"])).split("\n").filter(Boolean);
  const links = added.filter((f) => isOutsideLink(cwd, f));
  if (links.length) await git(cwd, ["rm", "--cached", "-q", "--", ...links]);
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
  | { status: "conflict"; files: string[] }
  /** A merge is already under way there (someone resolving a conflict), or tracked files are changed: not touched. */
  | { status: "busy"; merging: boolean; files: string[] };

/**
 * Merge `ref` into the branch checked out at `cwd`, fast-forwarding when it
 * can, as `author` when it cannot. A conflict is aborted, leaving the tree
 * as it was, and reported with the conflicted files.
 */
export async function mergeRef(cwd: string, ref: string, author: string): Promise<MergeResult> {
  // Never start a merge over one in progress, or over changes: the abort below would throw away someone's resolution.
  const busy = await midMerge(cwd);
  if (busy) return { status: "busy", ...busy };
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
/** What a desk borrows from the main checkout by default: dependency folders and env files, whatever the language. */
export const DEFAULT_DESK_LINKS = ["node_modules", ".venv", "venv", "__pypackages__", ".env*"];

/** `.env*` style patterns: `*` matches anything. */
function matcher(patterns: string[]): (name: string) => boolean {
  const res = patterns.map((p) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
  return (name) => res.some((r) => r.test(name));
}

export async function linkIgnored(cwd: string, desk: string, patterns: string[] = DEFAULT_DESK_LINKS): Promise<string[]> {
  if (!patterns.length) return [];
  const wanted = matcher(patterns);
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
      if (wanted(n)) candidates.push(r);
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
  if (linked.length) await excludeLinks(desk, linked);
  return linked;
}

/**
 * Keep the links out of `git status` and a seat's own `git add -A`: an ignore
 * pattern with a trailing slash (`node_modules/`) matches a folder, not a
 * link to one. The exclude file is shared by the repo's worktrees; the
 * entries name paths the main checkout already ignores, so it changes
 * nothing there.
 */
async function excludeLinks(desk: string, rels: string[]): Promise<void> {
  const file = resolve(desk, await git(desk, ["rev-parse", "--git-path", "info/exclude"]));
  const have = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  const add = rels.map((r) => `/${r.split(sep).join("/")}`).filter((l) => !have.includes(l));
  if (!add.length) return;
  mkdirSync(dirname(file), { recursive: true });
  const lead = have.length && have[have.length - 1] !== "" ? "\n" : "";
  appendFileSync(file, `${lead}# room: desk links to the main checkout\n${add.join("\n")}\n`);
}

function isDirSync(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `author: subject` lines for a range, newest first. */
export async function logRange(cwd: string, range: string, max: number): Promise<string> {
  return git(cwd, ["log", `-${max}`, "--format=- %an: %s", range]);
}

/** The full sha a ref names, or undefined when there is no such ref. */
export async function revParse(cwd: string, ref: string): Promise<string | undefined> {
  return git(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]).catch(() => undefined);
}

/** Whether `a` is an ancestor of (or the same as) `b`. */
export async function isAncestor(cwd: string, a: string, b: string): Promise<boolean> {
  return git(cwd, ["merge-base", "--is-ancestor", a, b]).then(
    () => true,
    () => false,
  );
}

/** Uncommitted paths in a checkout, the room's own state excepted. */
export async function dirtyFiles(cwd: string): Promise<string[]> {
  const out = await git(cwd, ["status", "--porcelain", "--untracked-files=normal"]).catch(() => "");
  return out
    .split("\n")
    .filter(Boolean)
    .map(porcelainPath)
    .filter((f) => !f.split("/").includes(".room"));
}

/** Fast-forward the branch checked out at `cwd` to `ref`; false when it cannot (diverged, or files in the way). */
export async function fastForward(cwd: string, ref: string): Promise<boolean> {
  return git(cwd, ["merge", "-q", "--ff-only", ref]).then(
    () => true,
    () => false,
  );
}

export async function topLevel(cwd: string): Promise<string | undefined> {
  return git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => undefined);
}

/**
 * A checkout someone is working in: a merge under way (MERGE_HEAD), or
 * tracked files changed. The paths involved, or undefined when it is clean.
 */
export async function midMerge(cwd: string): Promise<{ merging: boolean; files: string[] } | undefined> {
  const merging = await git(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(
    () => true,
    () => false,
  );
  const changed = (await git(cwd, ["status", "--porcelain", "--untracked-files=no"]).catch(() => ""))
    .split("\n")
    .filter(Boolean)
    .map(porcelainPath);
  return merging || changed.length ? { merging, files: changed } : undefined;
}

/** Run a shell command in a checkout: whether it passed, how long it took, and the tail of its output. */
export async function runCheck(cwd: string, command: string, timeoutMs = 15 * 60_000): Promise<{ ok: boolean; seconds: number; tail: string; code?: number | string }> {
  const started = Date.now();
  const tail = (s: string) => s.trim().split("\n").slice(-30).join("\n");
  try {
    const r = await run("sh", ["-c", command], { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true, seconds: Math.round((Date.now() - started) / 1000), tail: tail(`${r.stdout}\n${r.stderr}`) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | string; killed?: boolean };
    return {
      ok: false,
      seconds: Math.round((Date.now() - started) / 1000),
      tail: tail(`${e.stdout ?? ""}\n${e.stderr ?? ""}`) || (e.killed ? "timed out" : String(err)),
      code: e.killed ? "timeout" : e.code,
    };
  }
}

/**
 * The path in a `git status --porcelain` line ("XY path", or "XY old -> new").
 * Not by column: output is trimmed, so the first line can lose its leading space.
 */
function porcelainPath(line: string): string {
  const path = line.replace(/^\s*[MADRCU?! ]{1,2}\s+/, "");
  return (path.includes(" -> ") ? path.split(" -> ")[1] : path).replace(/^"|"$/g, "");
}
