/**
 * AcpSeat: one ACP agent subprocess, kept alive for the room.
 *
 * Spawns `config.command config.args`, speaks JSON-RPC over its stdio with the
 * ACP SDK, and forwards every `session/request_permission` to the decider the
 * UI supplies. Nothing is auto-approved here.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type {
  PermissionDecider,
  PermissionRequestView,
  Seat,
  SeatConfig,
  SeatEvent,
  SeatInfo,
} from "./types.js";
import { childEnv } from "../env.js";

type ActiveSession = Awaited<ReturnType<ReturnType<acp.ClientContext["buildSession"]>["start"]>>;

const STDERR_TAIL_BYTES = 16384;

export class AcpSeat implements Seat {
  readonly name: string;
  private child?: ChildProcess;
  private conn?: acp.ClientConnection;
  private session?: ActiveSession;
  private stderr = "";
  private exitInfo?: { code: number | null; signal: NodeJS.Signals | null };

  constructor(
    readonly config: SeatConfig,
    private readonly decide: PermissionDecider,
  ) {
    this.name = config.name;
  }

  async start(opts: { timeoutMs?: number } = {}): Promise<SeatInfo> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const child = spawn(this.config.command, this.config.args ?? [], {
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

    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (err) => reject(err));
    });
    await spawned;

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    this.conn = acp
      .client({ name: "room" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.onPermission(ctx.params),
      )
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

    return {
      agentName: init.agentInfo?.name,
      agentVersion: init.agentInfo?.version,
      protocolVersion: init.protocolVersion,
      loadSession: Boolean(init.agentCapabilities?.loadSession),
      authMethods: (init.authMethods ?? []).map((m) => ({ id: m.id, name: m.name })),
    };
  }

  async newSession(cwd: string): Promise<string> {
    if (!this.conn) throw new Error(`${this.name}: not started`);
    this.session?.dispose();
    this.session = await this.conn.agent.buildSession(cwd).start();
    return this.session.sessionId;
  }

  get sessionId(): string | undefined {
    return this.session?.sessionId;
  }

  /** Session modes the agent advertised at session/new, if any. */
  get modes(): { current?: string; available: Array<{ id: string; name: string }> } | undefined {
    const m = this.session?.modes;
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
    const opts = this.session?.newSessionResponse.configOptions ?? [];
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
    if (!this.conn || !this.session) throw new Error(`${this.name}: no session`);
    await this.conn.agent.request(acp.methods.agent.session.setConfigOption, {
      sessionId: this.session.sessionId,
      configId,
      value,
    } as acp.SetSessionConfigOptionRequest);
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.conn || !this.session) throw new Error(`${this.name}: no session`);
    await this.conn.agent.request(acp.methods.agent.session.setMode, {
      sessionId: this.session.sessionId,
      modeId,
    });
  }

  async *prompt(text: string): AsyncIterable<SeatEvent> {
    const session = this.session;
    if (!session) throw new Error(`${this.name}: no session`);
    // The returned promise also queues a `stop` message; reading updates is enough.
    session.prompt(text).catch(() => undefined);
    for (;;) {
      const msg = await session.nextUpdate();
      if (msg.kind === "stop") {
        yield { type: "stop", stopReason: msg.stopReason };
        return;
      }
      const u = msg.update;
      switch (u.sessionUpdate) {
        case "agent_message_chunk":
          if (u.content.type === "text") yield { type: "text", text: u.content.text };
          else yield { type: "other", update: `content:${u.content.type}` };
          break;
        case "agent_thought_chunk":
          if (u.content.type === "text") yield { type: "thought", text: u.content.text };
          break;
        case "tool_call":
          yield {
            type: "tool_call",
            id: u.toolCallId,
            title: u.title,
            kind: u.kind ?? undefined,
            status: u.status ?? undefined,
          };
          break;
        case "tool_call_update":
          yield {
            type: "tool_update",
            id: u.toolCallId,
            title: u.title ?? undefined,
            status: u.status ?? undefined,
          };
          break;
        default:
          yield { type: "other", update: u.sessionUpdate };
      }
    }
  }

  async cancel(): Promise<void> {
    if (!this.conn || !this.session) return;
    await this.conn.agent
      .notify(acp.methods.agent.session.cancel, { sessionId: this.session.sessionId })
      .catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.session?.dispose();
    this.session = undefined;
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

  private async onPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const view: PermissionRequestView = {
      seat: this.name,
      sessionId: params.sessionId,
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title ?? "(untitled tool call)",
      kind: params.toolCall.kind ?? undefined,
      options: params.options.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind })),
    };
    const answer = await this.decide(view);
    if (answer === "cancel") return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: answer } };
  }
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
