/**
 * `room mcp`: a stdio MCP server a harness registers once (`room setup
 * claude`). It stays idle until the session joins a hosted room; then the
 * session posts, reads, and waits there, and goes back to its own work
 * whenever it likes. Nothing of the session's own context leaves it except
 * what it posts.
 */
import { createInterface } from "node:readline";
import { callHub, dropMembership, harnessPid, openHubs, procInfo, saveMembership, type Membership } from "./client.js";
import { type HubInfo, type HubMessage, type Peek } from "./hub.js";

const PROTOCOL = "2025-06-18";

export const JOIN_TOOLS = [
  {
    name: "rooms",
    description: "Rooms hosted on this machine right now (started with `room host <name>`), and who is in each.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "join",
    description:
      "Join a hosted room to talk with the human and other agents' sessions working on related things. You keep your own context and work; share what is useful (status, findings, questions, decisions), not everything you know. You get a short note beside a tool result when something new arrives; read it with inbox when you reach a good point.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room name; may be left out when only one room is hosted." },
        as: { type: "string", description: "Your name in the room, e.g. your harness (claude, grok)." },
      },
      required: ["as"],
    },
  },
  {
    name: "post",
    description: "Say something in the room. Tag someone with @name to ask them directly; @all for everyone. Keep it to what others need: outcomes, questions, decisions.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "inbox",
    description: "Read what was posted since you last read. Returns at once.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "wait",
    description:
      "Block until someone posts, or the time is up. Only when you cannot go on without an answer; otherwise keep working and check inbox when pinged.",
    inputSchema: { type: "object", properties: { seconds: { type: "number", description: "At most this long (default 120, max 600)." } } },
  },
  {
    name: "who",
    description: "Who is in the room, and how much each has not read.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "leave",
    description: "Leave the room and go back to your own work.",
    inputSchema: { type: "object", properties: {} },
  },
] as const;

export interface JoinDeps {
  env?: NodeJS.ProcessEnv;
  /** The harness's pid, found once (tests pass their own). */
  harness?: () => number;
}

export class JoinServer {
  private me?: Membership;
  private hub?: HubInfo;

  constructor(private readonly deps: JoinDeps = {}) {}

  get membership(): Membership | undefined {
    return this.me;
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "rooms": {
        const hubs = openHubs(this.deps.env);
        if (!hubs.length) return "No room is hosted on this machine. The human starts one with `room host <name>`.";
        const lines = await Promise.all(
          hubs.map(async (h) => {
            const w = await callHub<{ members: Array<{ name: string }> }>(h, "who").catch(() => ({ members: [] }));
            return `- ${h.name} (hosted by ${h.human}): ${w.members.map((m) => m.name).join(", ") || "nobody else yet"}`;
          }),
        );
        return lines.join("\n");
      }
      case "join": {
        if (this.me) return `You are already in ${this.me.room} as ${this.me.name}; leave first to switch.`;
        const hubs = openHubs(this.deps.env);
        const want = args.room ? String(args.room) : undefined;
        const hub = want ? hubs.find((h) => h.name === want) : hubs.length === 1 ? hubs[0] : undefined;
        if (!hub) {
          if (want) throw new Error(`No room named ${want} is hosted. Hosted: ${hubs.map((h) => h.name).join(", ") || "none"}.`);
          throw new Error(hubs.length ? `Several rooms are hosted (${hubs.map((h) => h.name).join(", ")}); say which.` : "No room is hosted; the human starts one with `room host <name>`.");
        }
        const r = await callHub<{ token: string; name: string; history: HubMessage[] }>(hub, "join", { as: String(args.as ?? ""), harness: String(args.as ?? "") });
        this.hub = hub;
        this.me = { room: hub.name, name: r.name, token: r.token, port: hub.port, key: hub.key, harnessPid: (this.deps.harness ?? (() => harnessPid(process.pid, procInfo)))(), pid: process.pid };
        saveMembership(this.me, this.deps.env);
        const recent = r.history.filter((m) => m.from !== "room");
        return [
          `Joined ${hub.name} as ${r.name}, with ${hub.human}. You keep working as before; when something new is posted you get a short note beside a tool result, and you read it with inbox when you reach a good point.`,
          recent.length ? `\nRecent:\n${render(recent)}` : "",
        ].join("\n");
      }
      case "leave": {
        if (!this.me) return "You are not in a room.";
        await this.leave();
        return "Left the room.";
      }
    }
    const me = this.need();
    switch (name) {
      case "post": {
        const text = String(args.text ?? "");
        const m = await callHub<HubMessage>(this.hub!, "post", { token: me.token, text });
        return `Posted (#${m.id}).${await this.footer()}`;
      }
      case "inbox": {
        const r = await callHub<{ messages: HubMessage[] }>(this.hub!, "read", { token: me.token });
        this.seen(r.messages);
        return r.messages.length ? render(r.messages) : "Nothing new.";
      }
      case "wait": {
        const seconds = Math.min(Math.max(Number(args.seconds ?? 120) || 120, 1), 600);
        const r = await callHub<{ messages: HubMessage[] }>(this.hub!, "wait", { token: me.token, timeoutMs: seconds * 1000 }, (seconds + 10) * 1000);
        this.seen(r.messages);
        return r.messages.length ? render(r.messages) : `Nothing in ${seconds}s. Carry on with your work; you will be pinged when something comes.`;
      }
      case "who": {
        const r = await callHub<{ human: string; members: Array<{ name: string; harness?: string; unread: number }> }>(this.hub!, "who");
        return [`- ${r.human} (human)`, ...r.members.map((m) => `- ${m.name}${m.name === me.name ? " (you)" : ""}: ${m.unread} unread`)].join("\n");
      }
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  async leave(): Promise<void> {
    if (!this.me) return;
    const me = this.me;
    this.me = undefined;
    dropMembership(me.pid, this.deps.env);
    await callHub(this.hub!, "leave", { token: me.token }, 2000).catch(() => undefined);
  }

  private need(): Membership {
    if (!this.me) throw new Error("Join a room first (the join tool; rooms lists them).");
    return this.me;
  }

  /** What was read needs no ping. */
  private seen(messages: HubMessage[]): void {
    const last = messages.at(-1)?.id;
    if (!this.me || !last) return;
    this.me = { ...this.me, pinged: Math.max(this.me.pinged ?? 0, last), held: Math.max(this.me.held ?? 0, last) };
    saveMembership(this.me, this.deps.env);
  }

  private async footer(): Promise<string> {
    const p = await callHub<Peek>(this.hub!, "peek", { token: this.me!.token }, 1500).catch(() => undefined);
    return p?.unread ? `\n(${p.unread} unread in the room from ${p.from.join(", ")}; inbox reads them.)` : "";
  }

  // ---- MCP over stdio ----

  async answer(msg: { id?: unknown; method?: string; params?: Record<string, unknown> }): Promise<object | undefined> {
    if (!msg || typeof msg !== "object" || msg.id === undefined || msg.id === null || !msg.method) return undefined;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        return ok({
          protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "room", version: "0.0.1" },
          instructions: "Rooms on this machine where your session can talk with the human and other agents' sessions, then go back to its own work.",
        });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: JOIN_TOOLS });
      case "tools/call":
        try {
          const text = await this.call(String(msg.params?.name ?? ""), (msg.params?.arguments ?? {}) as Record<string, unknown>);
          return ok({ content: [{ type: "text", text }] });
        } catch (err) {
          return ok({ content: [{ type: "text", text: (err as Error).message }], isError: true });
        }
      default:
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `unknown method ${msg.method}` } };
    }
  }
}

export function render(messages: HubMessage[]): string {
  return messages.map((m) => `#${m.id} [${m.from}]${m.to.length ? ` → ${m.to.join(", ")}` : ""}: ${m.text}`).join("\n\n");
}

export function runJoinServer(): void {
  const server = new JoinServer();
  const rl = createInterface({ input: process.stdin });
  // Replies may come out of order (a wait must not hold up a post); each carries its id.
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
      return;
    }
    void server.answer(msg).then((r) => r && process.stdout.write(JSON.stringify(r) + "\n"));
  });
  const bye = () => void server.leave().finally(() => process.exit(0));
  rl.on("close", bye);
  process.once("SIGTERM", bye);
  process.once("SIGINT", bye);
}

if (process.argv[1] && /hub[/\\]join\.[jt]s$/.test(process.argv[1])) runJoinServer();
