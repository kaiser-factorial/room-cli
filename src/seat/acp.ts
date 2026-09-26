/**
 * AcpSeat: one ACP agent subprocess, kept alive for the room.
 *
 * Spawns `config.command config.args`, speaks JSON-RPC over its stdio with the
 * ACP SDK, and forwards every `session/request_permission` to the decider the
 * UI supplies. Nothing is auto-approved here.
 *
 * Session updates are routed by this class rather than the SDK's session
 * helper, so a saved session can be resumed (`session/resume`, or
 * `session/load` with the replay drained) as well as created.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Transform, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import * as acp from "@agentclientprotocol/sdk";
import type {
  PermissionDecider,
  PermissionRequestView,
  Seat,
  SeatConfig,
  SeatEvent,
  SeatInfo,
  ToolContentView,
} from "./types.js";
import { childEnv, resolveCommand } from "../env.js";
import type { McpEndpoint } from "../server/mcp.js";

const STDERR_TAIL_BYTES = 16384;

/** An unbounded async queue. */
export class Chan<T> {
  private items: T[] = [];
  private waiters: Array<(v: T) => void> = [];
  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w(v);
    else this.items.push(v);
  }
  /**
   * The next item, or undefined once `until` settles first. The waiter is
   * withdrawn then: a waiter left behind would swallow the next item pushed,
   * which is how a seat's next turn lost its first chunk (`[pass]` → `pass]`).
   */
  nextOr(until: Promise<unknown>): Promise<T | undefined> {
    if (this.items.length) return Promise.resolve(this.items.shift()!);
    return new Promise((resolve) => {
      const w = (v: T) => resolve(v);
      this.waiters.push(w);
      const withdraw = () => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          resolve(undefined);
        }
      };
      until.then(withdraw, withdraw);
    });
  }
  tryNext(): T | undefined {
    return this.items.shift();
  }
  clear(): void {
    this.items = [];
  }
}

export class AcpSeat implements Seat {
  readonly name: string;
  private child?: ChildProcess;
  private conn?: acp.ClientConnection;
  private sid?: string;
  private newSessionResponse?: acp.NewSessionResponse;
  private caps?: acp.InitializeResponse["agentCapabilities"];
  private readonly updates = new Chan<acp.SessionNotification>();
  private stderr = "";
  /** Ends the reader of the turn before this one. */
  private supersede?: () => void;
  private exitInfo?: { code: number | null; signal: NodeJS.Signals | null };
  /** The room's MCP server, handed to every session this seat opens. */
  private roomMcp?: McpEndpoint;

  constructor(
    readonly config: SeatConfig,
    private readonly decide: PermissionDecider,
    /** Protocol oddities from this seat, for the room to show as its own lines. */
    private readonly notice: (text: string) => void = () => undefined,
  ) {
    this.name = config.name;
  }

  async start(opts: { timeoutMs?: number } = {}): Promise<SeatInfo> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const cmd = resolveCommand(this.config.command, this.config.args ?? []);
    const child = spawn(cmd.command, cmd.args, {
      env: childEnv(this.config.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stderr!.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (err) => reject(err));
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!.pipe(strayFilter(this.notice))) as ReadableStream<Uint8Array>,
    );
    this.conn = acp
      .client({ name: "room" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => this.onPermission(ctx.params))
      .onNotification(acp.methods.client.session.update, (ctx) => {
        if (!this.sid || ctx.params.sessionId === this.sid) this.updates.push(ctx.params);
      })
      .connect(stream);

    const init = await withTimeout(
      this.conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: "room", version: "0.0.1" },
      }),
      timeoutMs,
      `${this.name}: initialize timed out after ${timeoutMs} ms`,
    ).catch(async (err) => {
      await this.stop();
      throw err;
    });
    this.caps = init.agentCapabilities;
    return {
      agentName: init.agentInfo?.name,
      agentVersion: init.agentInfo?.version,
      protocolVersion: init.protocolVersion,
      loadSession: Boolean(init.agentCapabilities?.loadSession),
      authMethods: (init.authMethods ?? []).map((m) => ({ id: m.id, name: m.name })),
    };
  }

  private agent(): acp.ClientContext {
    if (!this.conn) throw new Error(`${this.name}: not started`);
    return this.conn.agent;
  }

  /** Give this seat's sessions the room's tools. Set before newSession/resumeSession. */
  useMcp(endpoint: McpEndpoint): void {
    this.roomMcp = endpoint;
  }

  /** The room's server as this agent can take it: HTTP when advertised, else the stdio bridge. */
  private mcpServers(): acp.McpServer[] {
    const m = this.roomMcp;
    if (!m) return [];
    const http = (this.caps as { mcpCapabilities?: { http?: boolean } } | undefined)?.mcpCapabilities?.http;
    return http
      ? [{ type: "http", name: m.name, url: m.url, headers: [] }]
      : [{ name: m.name, command: m.bridge.command, args: m.bridge.args, env: [] }];
  }

  async newSession(cwd: string): Promise<string> {
    const res = await this.agent().request(acp.methods.agent.session.new, { cwd, mcpServers: this.mcpServers() });
    this.newSessionResponse = res;
    this.sid = res.sessionId;
    this.updates.clear();
    return res.sessionId;
  }

  /**
   * Reattach to a saved session. Prefers `session/resume` (no replay); falls
   * back to `session/load` and drains the replayed history. Returns false when
   * the agent cannot, so the room can start fresh and replay the transcript.
   */
  async resumeSession(sessionId: string, cwd: string): Promise<boolean> {
    const caps = this.caps as Record<string, unknown> | undefined;
    const sessionCaps = (caps?.sessionCapabilities ?? {}) as Record<string, unknown>;
    try {
      let res: { modes?: acp.SessionModeState | null; configOptions?: acp.NewSessionResponse["configOptions"] } | void;
      if (sessionCaps.resume) {
        res = await this.agent().request(acp.methods.agent.session.resume, { sessionId, cwd, mcpServers: this.mcpServers() });
      } else if (caps?.loadSession) {
        this.sid = sessionId; // route the replay into the queue, then discard it
        res = await this.agent().request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: this.mcpServers() });
      } else {
        return false;
      }
      // Its modes as it resumed, so the room can put it back in the asking one.
      this.newSessionResponse = { sessionId, modes: res?.modes ?? null, configOptions: res?.configOptions ?? null } as acp.NewSessionResponse;
      this.sid = sessionId;
      this.updates.clear();
      return true;
    } catch {
      this.sid = undefined;
      this.updates.clear();
      return false;
    }
  }

  get sessionId(): string | undefined {
    return this.sid;
  }

  /** Session modes the agent advertised at session/new, if any. */
  get modes(): { current?: string; available: Array<{ id: string; name: string }> } | undefined {
    const m = this.newSessionResponse?.modes;
    if (!m) return undefined;
    return {
      current: m.currentModeId ?? undefined,
      available: m.availableModes.map((x) => ({ id: x.id, name: x.name })),
    };
  }

  /** Session config options the agent advertised at session/new, if any. */
  get configOptions(): Array<{
    id: string;
    name: string;
    type: string;
    category?: string;
    current?: unknown;
    values?: Array<{ id: string; name: string }>;
  }> {
    const opts = this.newSessionResponse?.configOptions ?? [];
    return opts.map((o) => {
      const rec = o as unknown as Record<string, unknown>;
      const values = Array.isArray(rec.options)
        ? (rec.options as Array<Record<string, unknown>>).flatMap((v) =>
            Array.isArray(v.options)
              ? (v.options as Array<Record<string, unknown>>).map((w) => ({ id: String(w.value), name: String(w.name) }))
              : [{ id: String(v.value), name: String(v.name) }],
          )
        : undefined;
      return {
        id: o.id,
        name: o.name,
        type: o.type,
        category: o.category ?? undefined,
        current: rec.currentValue,
        values,
      };
    });
  }

  async setConfigOption(configId: string, value: string | boolean): Promise<void> {
    if (!this.sid) throw new Error(`${this.name}: no session`);
    await this.agent().request(acp.methods.agent.session.setConfigOption, {
      sessionId: this.sid,
      configId,
      value,
    } as acp.SetSessionConfigOptionRequest);
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.sid) throw new Error(`${this.name}: no session`);
    await this.agent().request(acp.methods.agent.session.setMode, { sessionId: this.sid, modeId });
  }

  async *prompt(text: string): AsyncIterable<SeatEvent> {
    const sid = this.sid;
    if (!sid) throw new Error(`${this.name}: no session`);
    // A turn the room gave up on (it timed out, its harness never stopped) must not
    // read this turn's updates: end its reader.
    this.supersede?.();
    let superseded = false;
    const replaced = new Promise<void>((r) => (this.supersede = () => ((superseded = true), r())));
    this.updates.clear();
    let finished: { stopReason: string } | { error: Error } | undefined;
    const done = this.agent()
      .request(acp.methods.agent.session.prompt, { sessionId: sid, prompt: [{ type: "text", text }] })
      .then((r) => (finished = { stopReason: r.stopReason }))
      .catch((err: Error) => (finished = { error: err }));

    // Chunks of one message share a messageId; a new id after text is a paragraph
    // break. Some agents send no ids, so a tool call between two runs of text
    // also breaks the paragraph.
    let lastMessageId: string | null | undefined;
    let emittedText = false;
    let breakPending = false;

    const map = function* (this: AcpSeat, u: acp.SessionUpdate): Generator<SeatEvent> {
      switch (u.sessionUpdate) {
        case "agent_message_chunk":
          if (u.content.type === "text") {
            const id = u.messageId ?? null;
            const newMessage = id !== null && id !== lastMessageId;
            if (emittedText && (newMessage || breakPending)) yield { type: "text", text: "\n\n" };
            breakPending = false;
            lastMessageId = id;
            emittedText = true;
            yield { type: "text", text: u.content.text };
          } else yield { type: "other", update: `content:${u.content.type}` };
          break;
        case "agent_thought_chunk":
          if (u.content.type === "text") yield { type: "thought", text: u.content.text };
          break;
        case "tool_call":
          breakPending = emittedText;
          yield {
            type: "tool_call",
            id: u.toolCallId,
            title: u.title,
            kind: u.kind ?? undefined,
            status: u.status ?? undefined,
            content: toolContent(u.content),
            locations: u.locations?.map((l) => l.path),
          };
          break;
        case "tool_call_update":
          yield {
            type: "tool_update",
            id: u.toolCallId,
            title: u.title ?? undefined,
            status: u.status ?? undefined,
            content: toolContent(u.content),
            locations: u.locations?.map((l) => l.path),
          };
          break;
        default:
          yield { type: "other", update: u.sessionUpdate };
      }
    }.bind(this);

    for (;;) {
      const n = await this.updates.nextOr(Promise.race([done, replaced]));
      if (superseded) return;
      if (n) {
        yield* map(n.update);
        continue;
      }
      // The prompt finished; updates that arrived just before are still queued.
      let rest: acp.SessionNotification | undefined;
      while ((rest = this.updates.tryNext())) yield* map(rest.update);
      if (finished && "error" in finished) throw finished.error;
      yield { type: "stop", stopReason: finished?.stopReason ?? "end_turn" };
      return;
    }
  }

  async cancel(): Promise<void> {
    if (!this.conn || !this.sid) return;
    await this.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: this.sid }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.sid = undefined;
    try {
      this.conn?.close();
    } catch {
      /* already closed */
    }
    this.conn = undefined;
    const child = this.child;
    if (!child || this.exitInfo) return;
    child.stdin?.end();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(3000)]);
    if (!this.exitInfo) {
      child.kill("SIGKILL");
      await Promise.race([exited, sleep(1000)]);
    }
  }

  stderrTail(): string {
    return this.stderr;
  }

  private async onPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const view: PermissionRequestView = {
      seat: this.name,
      sessionId: params.sessionId,
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? "(untitled tool call)",
      kind: params.toolCall.kind ?? undefined,
      options: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
      content: toolContent(params.toolCall.content),
    };
    const answer = await this.decide(view);
    if (answer === "cancel") return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: answer } };
  }
}

/**
 * Drops what the seat writes to the wire that is not for the room: replies
 * to requests the room never made (the room's request ids are numbers;
 * claude-agent-acp answers a "skills-reload" of its own on machines with
 * skills), and lines that are not JSON. The ACP library would print those
 * straight to the terminal, unattributed and over the prompt. Each kind is
 * reported once per seat instead.
 */
export function strayFilter(notice: (text: string) => void): Transform {
  let partial = "";
  // A multi-byte character can straddle two chunks; decode across them.
  const decoder = new StringDecoder("utf8");
  const seen = new Set<string>();
  const once = (key: string, text: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    notice(text);
  };
  const keep = (line: string): boolean => {
    if (!line.trim()) return true;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      once(`text:${line.slice(0, 40)}`, `wrote a line that is not protocol, ignored: ${line.slice(0, 120)}`);
      return false;
    }
    const m = msg as { id?: unknown; method?: unknown; result?: unknown; error?: unknown };
    const isReply = m && typeof m === "object" && m.method === undefined && ("result" in m || "error" in m);
    if (isReply && typeof m.id !== "number") {
      once(`reply:${String(m.id)}`, `sent a reply to a request the room never made (${JSON.stringify(m.id)}), ignored; shown once`);
      return false;
    }
    return true;
  };
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      const lines = (partial + decoder.write(chunk)).split("\n");
      partial = lines.pop()!;
      const out = lines.filter(keep);
      done(null, out.length ? out.join("\n") + "\n" : undefined);
    },
    flush(done) {
      partial += decoder.end();
      done(null, partial && keep(partial) ? partial : undefined);
    },
  });
}

/** Diffs and text out of a tool call's content, dropping what the terminal cannot show. */
function toolContent(content: acp.ToolCallContent[] | null | undefined): ToolContentView[] | undefined {
  if (!content || content.length === 0) return undefined;
  const out: ToolContentView[] = [];
  for (const c of content) {
    if (c.type === "diff") out.push({ type: "diff", path: c.path, oldText: c.oldText ?? undefined, newText: c.newText });
    else if (c.type === "content" && c.content.type === "text") out.push({ type: "text", text: c.content.text });
    else if (c.type === "terminal") out.push({ type: "text", text: `(terminal ${c.terminalId})` });
  }
  return out.length ? out : undefined;
}

/**
 * A JSON-RPC error's message is often just "Internal error"; the detail, when
 * a harness sends any, is in `data`. Fold it in, and name the auth code.
 */
export function describeError(err: unknown): string {
  const e = err as { message?: string; code?: number; data?: unknown };
  let msg = e?.message ?? String(err);
  if (e?.code === -32000 && !/auth/i.test(msg)) msg = `auth required: ${msg}`;
  if (e?.data !== undefined && e.data !== null) {
    const d = e.data as { message?: unknown; details?: unknown };
    const detail = typeof d === "object" && (d.message ?? d.details) !== undefined ? String(d.message ?? d.details) : JSON.stringify(d);
    if (detail && !msg.includes(detail)) msg = `${msg}: ${detail}`;
  }
  return msg;
}

export function isAuthError(err: unknown): boolean {
  const e = err as { message?: string; code?: number };
  return e?.code === -32000 || /auth/i.test(e?.message ?? "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}
