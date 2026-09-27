/**
 * Reaching a hosted room from outside: finding it, calling it, and the
 * membership file that lets a harness's hooks find the room its `room mcp`
 * server joined.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { basename, join } from "node:path";
import { alive, hubsDir, readHubFile, type HubInfo } from "./hub.js";

/** Rooms hosted on this machine right now. */
export function openHubs(env: NodeJS.ProcessEnv = process.env): HubInfo[] {
  const dir = hubsDir(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readHubFile(basename(f, ".json"), env))
    .filter((h): h is HubInfo => !!h && alive(h.pid));
}

export class HubError extends Error {}

export function callHub<T = Record<string, unknown>>(hub: Pick<HubInfo, "port" | "key">, op: string, args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: hub.port, path: "/api", method: "POST", headers: { "Content-Type": "application/json" }, timeout: timeoutMs },
      (res) => {
        let t = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (t += c));
        res.on("end", () => {
          try {
            const body = JSON.parse(t) as T & { error?: string };
            if ((res.statusCode ?? 500) >= 400) reject(new HubError(body.error ?? `room answered ${res.statusCode}`));
            else resolve(body);
          } catch {
            reject(new HubError(`room answered ${res.statusCode} with no JSON`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new HubError("the room did not answer in time")));
    req.on("error", (err) => reject(err instanceof HubError ? err : new HubError(`the room is not reachable (${(err as Error).message}); is it still hosted?`)));
    req.end(JSON.stringify({ ...args, op, key: hub.key }));
  });
}

// ---- membership: which harness process is in which room ----

export interface Membership {
  room: string;
  name: string;
  token: string;
  port: number;
  key: string;
  /** The harness process (the `room mcp` server's parent, past any wrapping shell). */
  harnessPid: number;
  /** The `room mcp` server's own pid, to clean up after it. */
  pid: number;
  /** The last message id a hook pinged about, and the last one a Stop hook held the turn for. */
  pinged?: number;
  held?: number;
}

export const membersDir = (env: NodeJS.ProcessEnv = process.env) => join(hubsDir(env), "members");
const memberFile = (pid: number, env: NodeJS.ProcessEnv) => join(membersDir(env), `${pid}.json`);

export function saveMembership(m: Membership, env: NodeJS.ProcessEnv = process.env): void {
  mkdirSync(membersDir(env), { recursive: true });
  writeFileSync(memberFile(m.pid, env), JSON.stringify(m), { mode: 0o600 });
}

export function dropMembership(pid: number, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(memberFile(pid, env), { force: true });
}

export function memberships(env: NodeJS.ProcessEnv = process.env): Membership[] {
  const dir = membersDir(env);
  if (!existsSync(dir)) return [];
  const out: Membership[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const m = JSON.parse(readFileSync(join(dir, f), "utf8")) as Membership;
      if (alive(m.pid)) out.push(m);
      else rmSync(join(dir, f), { force: true });
    } catch {
      /* half written */
    }
  }
  return out;
}

const WRAPPERS = new Set(["sh", "bash", "zsh", "dash", "fish", "env", "npx", "npm", "pnpm", "pnpx", "bunx", "uvx", "cmd", "cmd.exe"]);

/** A process's parent and command name. */
export type ProcInfo = (pid: number) => { ppid: number; comm: string } | undefined;

export const procInfo: ProcInfo = (pid) => {
  try {
    const out = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }).trim();
    const m = /^(\d+)\s+(.*)$/.exec(out);
    return m ? { ppid: Number(m[1]), comm: basename(m[2].trim()) } : undefined;
  } catch {
    return undefined;
  }
};

/** The harness that started this process: its parent, or past a shell or npx wrapping it. */
export function harnessPid(self: number = process.pid, info: ProcInfo = procInfo): number {
  let pid = info(self)?.ppid ?? process.ppid;
  for (let i = 0; i < 4; i++) {
    const p = info(pid);
    if (!p || !WRAPPERS.has(p.comm.replace(/^-/, ""))) break;
    pid = p.ppid;
  }
  return pid;
}

/** This process and its ancestors, nearest first. */
export function ancestors(self: number = process.pid, info: ProcInfo = procInfo, depth = 10): number[] {
  const out: number[] = [];
  let pid = self;
  for (let i = 0; i < depth && pid > 1; i++) {
    out.push(pid);
    const p = info(pid);
    if (!p) break;
    pid = p.ppid;
  }
  return out;
}
