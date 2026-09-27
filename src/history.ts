/**
 * Past rooms: every room keeps its transcript and state in `.room/<name>/`
 * in the directory it ran in, and an index line in the config dir so the
 * menu can list rooms from every project.
 *
 * Storage: a transcript is text, a few KB a turn (tool calls are kept as
 * one-line steps, never their output). What grows is the desks, a git
 * worktree per seat. Archiving a room gzips its transcript and removes its
 * worktrees; the desk branches stay, so nothing a seat did is lost, and
 * resuming the room unpacks and recreates both.
 */
import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
import { commitTurn, dirtyFiles, MidMergeError } from "./git.js";
import { configDir } from "./settings.js";
import type { Entry } from "./transcript.js";

const run = promisify(execFile);

export interface RoomSummary {
  cwd: string;
  name: string;
  started?: string;
  seats: string[];
  /** When anything was last said. */
  updated: Date;
  /** Transcript bytes on disk (compressed when archived). */
  bytes: number;
  archived: boolean;
  /** Desk worktrees still on disk. */
  desks: number;
  /** The last thing said, one line. */
  last?: string;
}

function indexPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "rooms.jsonl");
}

/** Note a room in the index, once. */
export function recordRoom(cwd: string, name: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const path = indexPath(env);
    const line = JSON.stringify({ cwd, name });
    if (existsSync(path) && readFileSync(path, "utf8").split("\n").includes(line)) return;
    mkdirSync(configDir(env), { recursive: true });
    appendFileSync(path, line + "\n");
  } catch {
    /* the index is a convenience */
  }
}

/** Rooms in `cwd`, and with `everywhere` every indexed room that still exists; newest first. */
export function listRooms(cwd: string, o: { everywhere?: boolean; env?: NodeJS.ProcessEnv } = {}): RoomSummary[] {
  const places = new Map<string, { cwd: string; name: string }>();
  const add = (c: string, n: string) => places.set(join(c, ".room", n), { cwd: c, name: n });
  const local = join(cwd, ".room");
  if (existsSync(local)) for (const n of readdirSync(local)) if (existsSync(join(local, n, "state.json"))) add(cwd, n);
  if (o.everywhere && existsSync(indexPath(o.env))) {
    for (const l of readFileSync(indexPath(o.env), "utf8").split("\n")) {
      try {
        const r = JSON.parse(l) as { cwd: string; name: string };
        if (existsSync(join(r.cwd, ".room", r.name, "state.json"))) add(r.cwd, r.name);
      } catch {
        /* blank or torn line */
      }
    }
  }
  return [...places.values()].map((p) => summarize(p.cwd, p.name)).sort((a, b) => b.updated.getTime() - a.updated.getTime());
}

function summarize(cwd: string, name: string): RoomSummary {
  const dir = join(cwd, ".room", name);
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { started?: string; seats?: string[]; sessions?: Record<string, string> };
  const plain = join(dir, "transcript.jsonl");
  const gz = plain + ".gz";
  const archived = !existsSync(plain) && existsSync(gz);
  const file = archived ? gz : plain;
  const st = existsSync(file) ? statSync(file) : undefined;
  const desksDir = join(dir, "desks");
  const desks = existsSync(desksDir) ? readdirSync(desksDir).filter((n) => existsSync(join(desksDir, n, ".git"))).length : 0;
  return {
    cwd,
    name,
    started: state.started,
    seats: state.seats ?? Object.keys(state.sessions ?? {}),
    updated: st?.mtime ?? statSync(join(dir, "state.json")).mtime,
    bytes: st?.size ?? 0,
    archived,
    desks,
    last: archived ? undefined : lastMessage(plain),
  };
}

/** The last message in a transcript, from its tail only: rooms can be long. */
function lastMessage(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  const size = statSync(path).size;
  const len = Math.min(size, 16384);
  const buf = Buffer.alloc(len);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n").reverse();
  for (const l of lines) {
    try {
      const e = JSON.parse(l) as Entry;
      if (e.kind === "message") return `${e.from}: ${e.text.replace(/\s+/g, " ").slice(0, 120)}`;
    } catch {
      /* the first line of the window is usually cut */
    }
  }
  return undefined;
}

/** A room's transcript, archived or not, without unpacking it on disk. */
export function readTranscript(cwd: string, name: string): Entry[] {
  const plain = join(cwd, ".room", name, "transcript.jsonl");
  const text = existsSync(plain)
    ? readFileSync(plain, "utf8")
    : existsSync(plain + ".gz")
      ? gunzipSync(readFileSync(plain + ".gz")).toString("utf8")
      : "";
  const out: Entry[] = [];
  for (const l of text.split("\n")) {
    try {
      if (l.trim()) out.push(JSON.parse(l) as Entry);
    } catch {
      /* torn line */
    }
  }
  return out;
}

/**
 * Shrink a finished room: gzip its transcript and remove its worktrees
 * (desks and trunk). A seat's uncommitted work is committed to its branch
 * first, as the seat, so nothing is lost; branches stay. `room resume`
 * brings it all back.
 */
export async function archiveRoom(cwd: string, name: string): Promise<{ saved: number; kept: string[] }> {
  if (isRunning(cwd, name)) throw new Error(`room ${name} is open; close it before archiving it`);
  const dir = join(cwd, ".room", name);
  const plain = join(dir, "transcript.jsonl");
  let saved = 0;
  const kept: string[] = [];
  if (existsSync(plain)) {
    const raw = readFileSync(plain);
    const packed = gzipSync(raw);
    writeFileSync(plain + ".gz", packed);
    rmSync(plain);
    saved += raw.length - packed.length;
  }
  const desksDir = join(dir, "desks");
  const trees: Array<{ path: string; seat?: string }> = existsSync(desksDir)
    ? readdirSync(desksDir).map((n) => ({ path: join(desksDir, n), seat: n }))
    : [];
  if (existsSync(join(dir, "trunk", ".git"))) trees.push({ path: join(dir, "trunk") });
  for (const t of trees) {
    if (!existsSync(join(t.path, ".git"))) {
      rmSync(t.path, { recursive: true, force: true });
      continue;
    }
    if (t.seat) {
      const conflicted = await commitTurn(t.path, t.seat, `${t.seat}: uncommitted work, kept when the room was archived`).then(
        () => false,
        (err: unknown) => err instanceof MidMergeError,
      );
      if (conflicted) {
        // A merge half done in the desk: committing it would commit the markers.
        kept.push(t.path);
        continue;
      }
    } else if ((await dirtyFiles(t.path)).length) {
      // The trunk mid-merge (you resolving a conflict): leave it for you.
      kept.push(t.path);
      continue;
    }
    saved += du(t.path);
    await run("git", ["worktree", "remove", "--force", t.path], { cwd }).catch(() => rmSync(t.path, { recursive: true, force: true }));
  }
  await run("git", ["worktree", "prune"], { cwd }).catch(() => undefined);
  return { saved, kept };
}

/**
 * Whether a room is open right now: its pid file names a live process that
 * started when the room's did. The start time guards against a reused pid
 * after a reboot, which would otherwise keep a dead room "open" forever.
 */
export function isRunning(cwd: string, name: string): boolean {
  const pidFile = join(cwd, ".room", name, "pid");
  if (!existsSync(pidFile)) return false;
  const [pidText, ...started] = readFileSync(pidFile, "utf8").trim().split(" ");
  const pid = Number(pidText);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const recorded = started.join(" ");
  if (!recorded) return true;
  const now = processStart(pid);
  return now === undefined || now === recorded;
}

/** When a process started, as `ps` tells it (macOS and Linux), or undefined when it cannot say. */
export function processStart(pid: number): string | undefined {
  try {
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().replace(/\s+/g, " ") || undefined;
  } catch {
    return undefined;
  }
}

export interface PruneReport {
  room: string;
  skipped?: string;
  saved: number;
  deleted: string[];
  kept: string[];
}

/**
 * Archive every idle room here (or the named ones), and with `branches`,
 * delete the branches whose work is already elsewhere: a desk branch merged
 * into its trunk, a trunk merged into the branch it started from. Nothing
 * unmerged is ever deleted; it is listed instead.
 */
export async function pruneRooms(cwd: string, o: { names?: string[]; branches?: boolean; dryRun?: boolean } = {}): Promise<PruneReport[]> {
  const rooms = listRooms(cwd).filter((r) => !o.names?.length || o.names.includes(r.name));
  const out: PruneReport[] = [];
  const git = (...a: string[]) => run("git", a, { cwd }).then((r) => r.stdout.trim());
  for (const r of rooms) {
    const report: PruneReport = { room: r.name, saved: 0, deleted: [], kept: [] };
    out.push(report);
    if (isRunning(cwd, r.name)) {
      report.skipped = "open right now";
      continue;
    }
    if (!o.dryRun) {
      const a = await archiveRoom(cwd, r.name);
      report.saved = a.saved;
      report.kept.push(...a.kept.map((p) => `${p} (has changes of yours; left in place)`));
    }
    if (!o.branches) continue;
    const state = JSON.parse(readFileSync(join(cwd, ".room", r.name, "state.json"), "utf8")) as { branch?: string; base?: { branch?: string } };
    const trunk = state.branch ?? `room/${r.name}`;
    const current = await git("rev-parse", "--abbrev-ref", "HEAD").catch(() => "");
    const desks = (await git("for-each-ref", "--format=%(refname:short)", `refs/heads/desk/${r.name}/`).catch(() => "")).split("\n").filter(Boolean);
    const gone = async (branch: string, into: string) => {
      const desk = join(cwd, ".room", r.name, "desks", branch.split("/").pop()!);
      if (branch.startsWith("desk/") && existsSync(join(desk, ".git")) && (await dirtyFiles(desk)).length) {
        report.kept.push(`${branch} (uncommitted work in its desk)`);
        return;
      }
      const ahead = Number(await git("rev-list", "--count", `${into}..${branch}`).catch(() => "-1"));
      if (ahead !== 0) {
        report.kept.push(`${branch} (${ahead < 0 ? "not checked" : `${ahead} commit${ahead === 1 ? "" : "s"} not in ${into}`})`);
        return;
      }
      if (branch === current) {
        report.kept.push(`${branch} (checked out)`);
        return;
      }
      if (!o.dryRun) {
        const err = await git("branch", "-D", branch).then(
          () => undefined,
          (e: unknown) => (e as { stderr?: string }).stderr?.trim().split("\n").pop() || String(e),
        );
        if (err) {
          report.kept.push(`${branch} (${err})`);
          return;
        }
      }
      report.deleted.push(branch);
    };
    for (const d of desks) await gone(d, trunk);
    if (state.base?.branch && (await git("rev-parse", "--verify", "-q", trunk).catch(() => ""))) await gone(trunk, state.base.branch);
  }
  if (!o.dryRun) await run("git", ["worktree", "prune"], { cwd }).catch(() => undefined);
  return out;
}

/** Bytes under a folder, not following links (a desk links node_modules, which is not the desk's). */
function du(p: string): number {
  let total = 0;
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const q = join(d, n);
      const st = lstatSync(q, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) walk(q);
      else total += st.size;
    }
  };
  try {
    walk(p);
  } catch {
    /* gone meanwhile */
  }
  return total;
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
