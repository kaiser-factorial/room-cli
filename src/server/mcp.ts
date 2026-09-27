/**
 * The room's own MCP server: tools a seat can call mid-turn to take part in
 * the room without waiting for its next turn (`inbox`, `post`, `status`,
 * `show`, `diff`).
 *
 * Streamable HTTP on 127.0.0.1, answering each POST with plain JSON (no
 * streams). Each seat gets its own URL with an unguessable token, which is
 * how the server knows who is calling. A harness without HTTP MCP gets the
 * same server through `mcp-bridge.ts` over stdio.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

/** What the tools do; the room implements it. Each returns text for the seat. */
export interface RoomTools {
  inbox(seat: string): string;
  post(seat: string, text: string): string | Promise<string>;
  status(seat: string): string;
  show(seat: string, args: { id?: number; from?: string; last?: number }): string;
  diff(seat: string, args: { seat?: string }): Promise<string>;
  skills(seat: string, args: { query?: string }): string;
  skill(seat: string, name: string): string;
}

/** How a seat reaches the server: over HTTP, or through the stdio bridge. */
export interface McpEndpoint {
  name: string;
  url: string;
  bridge: { command: string; args: string[] };
}

const PROTOCOL = "2025-06-18";

export const TOOLS = [
  {
    name: "inbox",
    description:
      "Messages posted to the room since you last read, while you work. Reading them marks them read: they are not repeated in your next turn.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "post",
    description:
      "Post a message to the room now, mid-turn: a progress note, a question, or a heads-up. Tag a seat with @name on its first or last line to wake it. Your final reply is still posted when your turn ends; do not repeat it here. A few posts a turn at most, spaced out; repeats are refused.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "status",
    description: "Who is working, queued, in the background, or benched, and the room's settings.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "show",
    description:
      "Transcript entries in full, with their tool calls: one by id, or the last few (optionally from one speaker).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "Entry id" },
        from: { type: "string", description: "Only entries from this speaker" },
        last: { type: "number", description: "How many recent entries (default 5, max 50)" },
      },
    },
  },
  {
    name: "diff",
    description:
      "What a seat has changed and not landed yet (default: you, including uncommitted work). Without desks: the working directory's uncommitted changes.",
    inputSchema: { type: "object", properties: { seat: { type: "string" } } },
  },
  {
    name: "skills",
    description:
      "Search the skills set up in any seat's harness on this machine (Claude, Codex, Gemini, Hermes, shared), offered to every seat. Pass a query (words to match in a skill's name or description); without one you get a count and a sample. Then `skill` gives one in full.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Words that must all appear in the name or description, e.g. \"pdf form\"" } } },
  },
  {
    name: "skill",
    description: "One skill in full: its SKILL.md and the files beside it, to follow as its instructions say.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
];

interface Rpc {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export class RoomMcp {
  private server?: Server;
  private port = 0;
  private readonly tokens = new Map<string, string>();

  constructor(private readonly tools: RoomTools) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) =>
      // Whatever a harness sends, the room's process must not go down with it.
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) json(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "internal error" } });
        else res.end();
      }),
    );
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => resolve());
    });
    this.server.unref();
    const addr = this.server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
  }

  /** The endpoint for one seat, minted once. */
  endpoint(seat: string): McpEndpoint {
    let token = [...this.tokens].find(([, s]) => s === seat)?.[0];
    if (!token) {
      token = randomBytes(16).toString("hex");
      this.tokens.set(token, seat);
    }
    const url = `http://127.0.0.1:${this.port}/mcp/${token}`;
    return { name: "room", url, bridge: bridgeCommand(url) };
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const seat = this.tokens.get(req.url?.match(/^\/mcp\/([0-9a-f]+)$/)?.[1] ?? "");
    if (!seat) return void res.writeHead(404).end();
    if (req.method === "DELETE") return void res.writeHead(200).end();
    if (req.method !== "POST") return void res.writeHead(405, { Allow: "POST" }).end();
    let body: unknown;
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return void json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const batch = Array.isArray(body);
    const msgs = (batch ? body : [body]) as Rpc[];
    const replies = (await Promise.all(msgs.map((m) => this.answer(seat, m)))).filter((r) => r !== undefined);
    if (!replies.length) return void res.writeHead(202).end();
    json(res, 200, batch ? replies : replies[0]);
  }

  /** One JSON-RPC message; undefined for a notification or a response. */
  private async answer(seat: string, m: Rpc): Promise<object | undefined> {
    if (!m || typeof m !== "object" || m.id === undefined || m.id === null || !m.method) return undefined;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize":
        return ok({
          protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "room", version: "0.0.1" },
          instructions: "The room you are a seat in: read what others post while you work, post to them, and look at their work.",
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: TOOLS });
      case "tools/call": {
        const name = String(m.params?.name ?? "");
        const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const text = await this.call(seat, name, args);
          return ok({ content: [{ type: "text", text }] });
        } catch (err) {
          return ok({ content: [{ type: "text", text: (err as Error).message }], isError: true });
        }
      }
      default:
        return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no method ${m.method}` } };
    }
  }

  private call(seat: string, name: string, a: Record<string, unknown>): string | Promise<string> {
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    switch (name) {
      case "inbox":
        return this.tools.inbox(seat);
      case "post": {
        const text = str(a.text);
        if (!text) throw new Error("post needs text");
        return this.tools.post(seat, text);
      }
      case "status":
        return this.tools.status(seat);
      case "show":
        return this.tools.show(seat, { id: num(a.id), from: str(a.from), last: num(a.last) });
      case "diff":
        return this.tools.diff(seat, { seat: str(a.seat) });
      case "skills":
        return this.tools.skills(seat, { query: str(a.query) });
      case "skill": {
        const name = str(a.name);
        if (!name) throw new Error("skill needs a name (the skills tool lists them)");
        return this.tools.skill(seat, name);
      }
      default:
        throw new Error(`no tool ${name}`);
    }
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

/**
 * Run the stdio bridge with this Node: the built .js, or in dev the .ts,
 * which Node runs by stripping its types (it imports only Node's own modules).
 */
function bridgeCommand(url: string): { command: string; args: string[] } {
  const js = fileURLToPath(new URL("./mcp-bridge.js", import.meta.url));
  const script = existsSync(js) ? js : fileURLToPath(new URL("./mcp-bridge.ts", import.meta.url));
  return { command: process.execPath, args: [script, url] };
}
