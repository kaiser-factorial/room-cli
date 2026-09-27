/**
 * A hosted room: sessions already running elsewhere (a Claude Code session,
 * a Grok session) join it through `room mcp`, talk, and go back to their
 * work. Nothing is spawned and nobody's context is copied: members read
 * what is posted and post what they choose to share.
 *
 * The host is one process on 127.0.0.1 with a key in a 0600 file under
 * `~/.config/room/hubs/`; members find it there. Messages are kept in a
 * transcript beside it, so a host restarted under the same name picks up
 * where it left off.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { configDir } from "../settings.js";

export interface HubMessage {
  id: number;
  from: string;
  text: string;
  at: string;
  /** Members tagged (@name), or ["all"]; empty when untagged. */
  to: string[];
}

export interface HubInfo {
  name: string;
  port: number;
  key: string;
  pid: number;
  human: string;
}

interface Member {
  name: string;
  harness?: string;
  /** Last message id this member has read. */
  cursor: number;
  joined: string;
}

export interface Peek {
  unread: number;
  /** Unread messages that tag this member (or @all). */
  addressed: number;
  from: string[];
  lastId: number;
  /** The newest unread message, short. */
  preview?: string;
}

export const hubsDir = (env: NodeJS.ProcessEnv = process.env) => join(configDir(env), "hubs");
export const hubFile = (name: string, env: NodeJS.ProcessEnv = process.env) => join(hubsDir(env), `${name}.json`);

/** Who a message tags: `@name` anywhere outside code, among the names given. */
export function tagsIn(text: string, names: string[]): string[] {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  if (/(?:^|[^\w@])@all\b/i.test(plain)) return ["all"];
  return names.filter((n) => new RegExp(`(?:^|[^\\w@])@${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(plain));
}

export class Hub {
  readonly messages: HubMessage[] = [];
  private readonly members = new Map<string, Member>();
  private readonly waiters = new Set<() => void>();
  private readonly listeners = new Set<(m: HubMessage) => void>();
  private server?: Server;
  private readonly dir: string;
  info?: HubInfo;

  constructor(
    readonly name: string,
    readonly human: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    if (!/^[\w.-]+$/.test(name)) throw new Error(`a room name is letters, digits, . _ - (got "${name}")`);
    this.dir = join(hubsDir(env), name);
    const log = join(this.dir, "transcript.jsonl");
    if (existsSync(log)) {
      for (const line of readFileSync(log, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          this.messages.push(JSON.parse(line) as HubMessage);
        } catch {
          /* a torn last line */
        }
      }
    }
  }

  get lastId(): number {
    return this.messages.at(-1)?.id ?? 0;
  }

  onMessage(f: (m: HubMessage) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  who(): Array<{ name: string; harness?: string; unread: number }> {
    return [...this.members.values()].map((m) => ({ name: m.name, harness: m.harness, unread: this.after(m).filter((x) => x.from !== "room").length }));
  }

  /** A new member, named as asked (a taken name gets a suffix). Joining sees only what is posted from now on, unless `history`. */
  join(as: string, o: { harness?: string; history?: number } = {}): { token: string; name: string; history: HubMessage[] } {
    const base = as.trim().replace(/[^\w.-]/g, "") || "guest";
    const taken = new Set([...this.members.values()].map((m) => m.name.toLowerCase()).concat(this.human.toLowerCase()));
    let name = base;
    for (let i = 2; taken.has(name.toLowerCase()); i++) name = `${base}${i}`;
    const token = randomBytes(12).toString("hex");
    this.system(`${name} joined${o.harness ? ` (${o.harness})` : ""}.`);
    this.members.set(token, { name, harness: o.harness, cursor: this.lastId, joined: new Date().toISOString() });
    return { token, name, history: this.messages.slice(-(o.history ?? 10)) };
  }

  leave(token: string): void {
    const m = this.member(token);
    this.members.delete(token);
    this.system(`${m.name} left.`);
  }

  post(from: string, text: string): HubMessage {
    const names = [...this.members.values()].map((m) => m.name).concat(this.human);
    const msg: HubMessage = { id: this.lastId + 1, from, text: text.trim(), at: new Date().toISOString(), to: tagsIn(text, names.filter((n) => n !== from)) };
    this.messages.push(msg);
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(join(this.dir, "transcript.jsonl"), JSON.stringify(msg) + "\n");
    for (const f of this.listeners) f(msg);
    for (const w of [...this.waiters]) w();
    return msg;
  }

  postAs(token: string, text: string): HubMessage {
    const m = this.member(token);
    if (!text.trim()) throw new Error("nothing to post");
    return this.post(m.name, text);
  }

  /** Unread messages for a member, and they count as read. */
  read(token: string, max = 50): HubMessage[] {
    const m = this.member(token);
    const unread = this.after(m);
    const out = unread.slice(0, max);
    if (out.length) m.cursor = out.at(-1)!.id;
    return out;
  }

  /** What is waiting for a member, without reading it. */
  peek(token: string): Peek {
    const m = this.member(token);
    // "x joined" is not worth a ping.
    const unread = this.after(m).filter((x) => x.from !== "room");
    const last = unread.at(-1);
    return {
      unread: unread.length,
      addressed: unread.filter((x) => addressedTo(x, m.name)).length,
      from: [...new Set(unread.map((x) => x.from))],
      lastId: last?.id ?? m.cursor,
      preview: last ? `${last.from}: ${short(last.text, 140)}` : undefined,
    };
  }

  /** Until something arrives for a member (from someone else), or the time is up. */
  async wait(token: string, timeoutMs: number): Promise<HubMessage[]> {
    const m = this.member(token);
    if (!this.after(m).some((x) => x.from !== "room")) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(check);
          resolve();
        };
        const check = () => {
          if (!this.members.has(token) || this.after(m).some((x) => x.from !== "room")) done();
        };
        const timer = setTimeout(done, timeoutMs);
        this.waiters.add(check);
      });
    }
    return this.members.has(token) ? this.read(token) : [];
  }

  private after(m: Member): HubMessage[] {
    return this.messages.filter((x) => x.id > m.cursor && x.from !== m.name);
  }

  private member(token: string): Member {
    const m = this.members.get(token);
    if (!m) throw new Error("not in this room (it may have restarted): join again");
    return m;
  }

  private system(text: string): void {
    this.post("room", text);
  }

  // ---- over HTTP ----

  async start(): Promise<HubInfo> {
    const existing = readHubFile(this.name, this.env);
    if (existing && alive(existing.pid) && existing.pid !== process.pid) throw new Error(`room ${this.name} is already hosted (pid ${existing.pid})`);
    const key = randomBytes(16).toString("hex");
    this.server = createServer((req, res) => void this.handle(req, res, key).catch(() => res.headersSent ? res.end() : send(res, 500, { error: "internal error" })));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    this.info = { name: this.name, port, key, pid: process.pid, human: this.human };
    mkdirSync(hubsDir(this.env), { recursive: true });
    writeFileSync(hubFile(this.name, this.env), JSON.stringify(this.info), { mode: 0o600 });
    return this.info;
  }

  async stop(): Promise<void> {
    for (const w of [...this.waiters]) w();
    if (readHubFile(this.name, this.env)?.pid === process.pid) rmSync(hubFile(this.name, this.env), { force: true });
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse, key: string): Promise<void> {
    if (req.method !== "POST" || req.url !== "/api") return send(res, 404, { error: "not found" });
    let body: Record<string, unknown>;
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      if (!body || typeof body !== "object") throw new Error();
    } catch {
      return send(res, 400, { error: "bad request" });
    }
    if (body.key !== key) return send(res, 403, { error: "wrong key" });
    const token = String(body.token ?? "");
    try {
      switch (body.op) {
        case "join":
          return send(res, 200, this.join(String(body.as ?? ""), { harness: body.harness ? String(body.harness) : undefined, history: Number(body.history ?? 10) }));
        case "post":
          return send(res, 200, this.postAs(token, String(body.text ?? "")));
        case "read":
          return send(res, 200, { messages: this.read(token) });
        case "peek":
          return send(res, 200, this.peek(token));
        case "wait":
          return send(res, 200, { messages: await this.wait(token, Math.min(Math.max(Number(body.timeoutMs) || 0, 0), 600_000)) });
        case "who":
          return send(res, 200, { human: this.human, members: this.who() });
        case "leave":
          this.leave(token);
          return send(res, 200, {});
        default:
          return send(res, 400, { error: `unknown op ${String(body.op)}` });
      }
    } catch (err) {
      return send(res, 409, { error: (err as Error).message });
    }
  }
}

export function addressedTo(m: HubMessage, name: string): boolean {
  return m.to.includes("all") || m.to.some((t) => t.toLowerCase() === name.toLowerCase());
}

export function short(text: string, n: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

export function readHubFile(name: string, env: NodeJS.ProcessEnv = process.env): HubInfo | undefined {
  try {
    return JSON.parse(readFileSync(hubFile(name, env), "utf8")) as HubInfo;
  } catch {
    return undefined;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}
