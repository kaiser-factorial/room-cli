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
import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, closeSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { gunzipSync, gzipSync } from "node:zlib";
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
 * Shrink a finished room: gzip its transcript, remove its desk worktrees
 * (their branches stay). `room resume` brings both back.
 */
export async function archiveRoom(cwd: string, name: string): Promise<{ saved: number }> {
  const dir = join(cwd, ".room", name);
  const plain = join(dir, "transcript.jsonl");
  let saved = 0;
  if (existsSync(plain)) {
    const raw = readFileSync(plain);
    const packed = gzipSync(raw);
    writeFileSync(plain + ".gz", packed);
    rmSync(plain);
    saved += raw.length - packed.length;
  }
  const desksDir = join(dir, "desks");
  if (existsSync(desksDir)) {
    for (const n of readdirSync(desksDir)) {
      const p = join(desksDir, n);
      saved += await du(p);
      await run("git", ["worktree", "remove", "--force", p], { cwd }).catch(() => rmSync(p, { recursive: true, force: true }));
    }
    await run("git", ["worktree", "prune"], { cwd }).catch(() => undefined);
  }
  return { saved };
}

async function du(p: string): Promise<number> {
  let total = 0;
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const q = join(d, n);
      const st = statSync(q, { throwIfNoEntry: false });
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
