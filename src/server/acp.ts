/**
 * The room as an ACP agent, so an editor that speaks ACP (Zed, VS Code's
 * ACP client) can host it. The editor is the client; each of its sessions
 * is one room, and the room's seats are ACP agents of their own behind it.
 *
 *   editor ──ACP──▶ room acp ──ACP──▶ claude, grok, ...
 *
 * Seat replies stream back as one agent message with a `**seat>**` prefix
 * per turn, tool calls are forwarded with ids namespaced by seat and turn,
 * and a seat's permission request that the room policy leaves to the human
 * becomes a `session/request_permission` to the editor. The room's own
 * sequential and parallel modes are offered as session modes.
 *
 * The ACP session id is the room name, so `session/load` and
 * `session/resume` reopen `.room/<name>/` and reattach the seats. stdout is
 * the wire: nothing else may write to it.
 */
import type { McpServerEntry, Skill } from "../discover.js";
import * as acp from "@agentclientprotocol/sdk";
import { COMMAND_HELP, runCommand } from "../commands.js";
import type { HumanChoice } from "../permissions.js";
import { Room, type RoomMode, type RoomUI } from "../room.js";
import type { PermissionDecider, PermissionRequestView, Seat, SeatConfig, SeatEvent, ToolContentView } from "../seat/types.js";
import { describeError } from "../seat/acp.js";
import type { Entry } from "../transcript.js";
import { sanitizeForTerminal } from "../ui/repl.js";

export interface AcpServerOptions {
  seats: SeatConfig[];
  human: string;
  /** Skills and MCP servers shared with every seat (see the menu's Skills & MCP). */
  skills?: Skill[];
  shareMcp?: McpServerEntry[];
  /** Commit per turn on a `room/<name>` branch. Default: when the session's cwd is a repo. */
  git?: boolean;
  /** A worktree per seat. Default: with git. */
  desks?: boolean;
  /** New rooms start in auto mode. */
  auto?: boolean;
  wake?: "last" | "all";
  cap?: number | null;
  /** Room mode for new sessions. */
  mode?: RoomMode;
  turnTimeoutMs?: number;
  /** Diagnostics; stderr in the CLI. */
  log?: (line: string) => void;
  /** Seat factory, for tests. */
  makeSeat?: (config: SeatConfig, decide: PermissionDecider) => Seat;
}

export interface AcpServer {
  readonly connection: acp.AgentConnection;
  /** Open rooms by session id. */
  readonly rooms: ReadonlyMap<string, Room>;
  /** Stop every room's seats. Called on its own when the connection closes. */
  stop(): Promise<void>;
}

const ROOM_MODES: acp.SessionModeState["availableModes"] = [
  { id: "sequential", name: "Sequential", description: "Seats answer one at a time, in roster order" },
  { id: "parallel", name: "Parallel", description: "Every seat answers at once; file changes are refused" },
];

const COMMANDS: acp.AvailableCommand[] = [
  { name: "next", description: "Another round with no new message" },
  { name: "seats", description: "Seats, their modes and sessions, and what is queued" },
  { name: "parallel", description: "Every seat answers at once; file changes are refused" },
  { name: "sequential", description: "Seats answer one at a time" },
  { name: "role", description: "Give a seat a role from the presets; alone, list them", input: { hint: "<seat> [id|none]" } },
  { name: "cap", description: "Seat-to-seat wakes per thread; +n lets a paused thread go on", input: { hint: "[n|+n|off]" } },
  { name: "mod", description: "Who decides when a limit trips: an OpenRouter model, you (here: held), or off", input: { hint: "off|you|auto|<model>" } },
  { name: "wake", description: "Who an untagged message wakes: whoever spoke last, or every idle seat", input: { hint: "last|all" } },
  { name: "auto", description: "Tool calls run without asking, except deny and ask rules", input: { hint: "[on|off]" } },
  { name: "mode", description: "Show or set a seat's session mode", input: { hint: "<seat> [mode]" } },
  { name: "perm", description: "Show a seat's room policy, or add a rule", input: { hint: "<seat> [allow|ask|deny <pattern>]" } },
  { name: "unperm", description: "Remove a room policy rule", input: { hint: "<seat> <pattern>" } },
  { name: "unbench", description: "Bring back a seat benched after failing", input: { hint: "<seat>" } },
  { name: "bg", description: "A seat works on a task in its desk while the room goes on", input: { hint: "<seat> <task>" } },
  { name: "stop", description: "Cancel a seat's background work", input: { hint: "<seat>" } },
  { name: "land", description: "Merge a seat's desk into the trunk now", input: { hint: "<seat>" } },
  { name: "help", description: "What you can type here" },
];

const HELP = `Type to talk to the room; every seat answers in turn. \`@seat text\` talks to one seat.
Commands:
${COMMAND_HELP}
  /next                  another round with no new message`;

const TOOL_KINDS = new Set<string>(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);
const TOOL_STATUSES = new Set<string>(["pending", "in_progress", "completed", "failed"]);

/** A fresh room name, also the ACP session id: sortable, and safe as a branch name. */
export function newRoomName(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").slice(0, 15);
  return `acp-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
}

export function serveAcp(stream: acp.Stream, opts: AcpServerOptions): AcpServer {
  const log = opts.log ?? (() => undefined);
  const rooms = new Map<string, Room>();
  const uis = new Map<string, AcpServerUI>();
  // Handlers only run once connected, so `conn` is set by the time this is called.
  const client = (): acp.AgentContext => conn.client;

  const modeState = (room: Room): acp.SessionModeState => ({ currentModeId: room.mode, availableModes: ROOM_MODES });

  const roomFor = (sessionId: string): { room: Room; ui: AcpServerUI } => {
    const room = rooms.get(sessionId);
    const ui = uis.get(sessionId);
    if (!room || !ui) throw acp.RequestError.invalidParams({ sessionId }, `no open room for session ${sessionId}`);
    return { room, ui };
  };

  /** Open (or reopen) the room named `name` in `cwd` and start its seats. */
  async function openRoom(name: string, cwd: string, isNew: boolean): Promise<{ room: Room; ui: AcpServerUI }> {
    const ui = new AcpServerUI(client, name, log);
    let room: Room | undefined;
    try {
      room = await Room.open({
        name,
        cwd,
        seats: opts.seats,
        human: opts.human,
        ui,
        git: opts.git,
        desks: opts.desks,
        auto: isNew ? opts.auto : undefined,
        wake: isNew ? opts.wake : undefined,
        cap: isNew ? opts.cap : undefined,
        mode: isNew ? opts.mode : undefined,
        turnTimeoutMs: opts.turnTimeoutMs,
        makeSeat: opts.makeSeat,
        skills: opts.skills,
        shareMcp: opts.shareMcp,
      });
      // An editor has no way to ask about a limit: a model decides when OPENROUTER_API_KEY is set, else limits hold.
      room.useModerator(process.env.OPENROUTER_API_KEY ? "auto" : "off");
      await room.start();
    } catch (err) {
      await room?.stop().catch(() => undefined);
      log(`[${name}] could not open: ${describeError(err)}`);
      throw acp.RequestError.internalError({ message: describeError(err) }, describeError(err));
    }
    rooms.set(name, room);
    uis.set(name, ui);
    return { room, ui };
  }

  /** Session updates sent before the client has the session id would be dropped; send them just after. */
  const afterResponse = (fn: () => void) => setImmediate(fn);

  async function reopen(params: { sessionId: string; cwd: string }, replay: boolean): Promise<acp.LoadSessionResponse> {
    const { sessionId, cwd } = params;
    // The id names a directory and a branch; only ever a name this server could have made.
    if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw acp.RequestError.invalidParams({ sessionId }, `not a room name: ${sessionId}`);
    let open = rooms.get(sessionId) && uis.get(sessionId) ? roomFor(sessionId) : undefined;
    if (!open) {
      if (!Room.exists(cwd, sessionId)) {
        throw acp.RequestError.invalidParams({ sessionId, cwd }, `no saved room "${sessionId}" in ${cwd}`);
      }
      open = await openRoom(sessionId, cwd, false);
    }
    const { room, ui } = open;
    // The client knows this session id already, so history can stream before the response.
    if (replay) for (const e of room.transcript.entries) ui.replay(e, opts.human);
    ui.setReady();
    ui.send({ sessionUpdate: "available_commands_update", availableCommands: COMMANDS });
    return { modes: modeState(room) };
  }

  const app = acp
    .agent({ name: "room" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "room", title: "room", version: "0.0.1" },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true },
        sessionCapabilities: { resume: {}, close: {} },
      },
      authMethods: [],
    }))
    .onRequest(acp.methods.agent.session.new, async (ctx) => {
      if (ctx.params.mcpServers?.length) log(`ignoring ${ctx.params.mcpServers.length} MCP server(s): seats bring their own`);
      const name = newRoomName();
      const { room, ui } = await openRoom(name, ctx.params.cwd, true);
      afterResponse(() => {
        ui.setReady();
        ui.send({ sessionUpdate: "available_commands_update", availableCommands: COMMANDS });
      });
      return { sessionId: name, modes: modeState(room) };
    })
    .onRequest(acp.methods.agent.session.load, (ctx) => reopen(ctx.params, true))
    .onRequest(acp.methods.agent.session.resume, (ctx) => reopen(ctx.params, false))
    .onRequest(acp.methods.agent.session.setMode, (ctx) => {
      const { room } = roomFor(ctx.params.sessionId);
      const mode = ctx.params.modeId;
      if (mode !== "sequential" && mode !== "parallel") {
        throw acp.RequestError.invalidParams({ modeId: mode }, `room modes are sequential and parallel`);
      }
      room.setRoomMode(mode);
      return {};
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const { room, ui } = roomFor(ctx.params.sessionId);
      if (room.roundRunning) throw acp.RequestError.invalidRequest(undefined, "a round is already running in this room");
      const text = promptText(ctx.params.prompt).trim();
      ui.beginPrompt();
      try {
        const stop = await handlePrompt(room, ui, text);
        return { stopReason: stop };
      } finally {
        ui.endPrompt();
      }
    })
    .onNotification(acp.methods.agent.session.cancel, async (ctx) => {
      const room = rooms.get(ctx.params.sessionId);
      await room?.cancel();
    })
    .onRequest(acp.methods.agent.session.close, async (ctx) => {
      const room = rooms.get(ctx.params.sessionId);
      rooms.delete(ctx.params.sessionId);
      uis.delete(ctx.params.sessionId);
      await room?.stop();
      return {};
    });

  async function handlePrompt(room: Room, ui: AcpServerUI, text: string): Promise<acp.StopReason> {
    if (text === "" || text === "/next") return (await room.continueRound()).cancelled ? "cancelled" : "end_turn";
    if (text === "/help") {
      ui.block(HELP, true);
      return "end_turn";
    }
    if (text.startsWith("/")) {
      const before = room.mode;
      const lines: string[] = [];
      await runCommand(room, text, (l) => lines.push(l));
      ui.block(lines.join("\n"), true);
      if (room.mode !== before) ui.send({ sessionUpdate: "current_mode_update", currentModeId: room.mode });
      return "end_turn";
    }
    return (await room.say(text)).cancelled ? "cancelled" : "end_turn";
  }

  const conn = app.connect(stream);
  const stop = async () => {
    const all = [...rooms.values()];
    rooms.clear();
    uis.clear();
    await Promise.all(all.map((r) => r.stop().catch(() => undefined)));
  };
  void conn.closed.then(stop, stop);
  return { connection: conn, rooms, stop };
}

/** The prompt as the room's text: text blocks as they are, attached files by name, embedded text fenced. */
export function promptText(blocks: acp.ContentBlock[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "resource_link") parts.push(`[${b.name}](${b.uri})`);
    else if (b.type === "resource" && "text" in b.resource) parts.push(`\n${b.resource.uri}\n\`\`\`\n${b.resource.text}\n\`\`\`\n`);
  }
  return parts.join(" ").replace(/ \n/g, "\n");
}

export function toAcpContent(content: ToolContentView[] | undefined): acp.ToolCallContent[] | undefined {
  if (!content) return undefined;
  return content.map((c) =>
    c.type === "diff"
      ? { type: "diff" as const, path: c.path, oldText: c.oldText ?? null, newText: c.newText }
      : { type: "content" as const, content: { type: "text" as const, text: c.text } },
  );
}

/**
 * Room events as session updates for one editor session. Text from every
 * seat goes into the one agent message, a paragraph per speaker; room
 * status lines are their own paragraphs.
 */
export class AcpServerUI implements RoomUI {
  private ready = false;
  private backlog: acp.SessionUpdate[] = [];
  private speaker?: string;
  private thinker?: string;
  /** The last two characters sent, to know whether a paragraph break is due. */
  private tail = "";
  /** Turns finished per seat, so tool call ids stay unique when a harness reuses them. */
  private readonly turns = new Map<string, number>();

  constructor(
    private readonly client: () => acp.AgentContext,
    readonly sessionId: string,
    private readonly log: (line: string) => void,
  ) {}

  setReady(): void {
    if (this.ready) return;
    this.ready = true;
    for (const u of this.backlog.splice(0)) this.send(u);
  }

  send(update: acp.SessionUpdate): void {
    if (!this.ready) {
      this.backlog.push(update);
      return;
    }
    this.client()
      .notify(acp.methods.client.session.update, { sessionId: this.sessionId, update })
      .catch((err) => this.log(`[${this.sessionId}] update failed: ${describeError(err)}`));
  }

  /** A prompt starts a new agent message. */
  beginPrompt(): void {
    this.tail = "";
    this.speaker = undefined;
    this.thinker = undefined;
  }

  endPrompt(): void {
    this.speaker = undefined;
    this.thinker = undefined;
  }

  private text(t: string): void {
    if (!t) return;
    this.send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } });
    this.tail = (this.tail + t).slice(-2);
  }

  private paragraph(): void {
    if (this.tail === "" || this.tail.endsWith("\n\n")) return;
    this.text(this.tail.endsWith("\n") ? "\n" : "\n\n");
  }

  private toolId(seat: string, id: string): string {
    return `${seat}:${this.turns.get(seat) ?? 0}:${id}`;
  }

  seatEvent(seat: string, ev: SeatEvent): void {
    switch (ev.type) {
      case "text": {
        const t = sanitizeForTerminal(ev.text);
        if (this.speaker !== seat) {
          this.paragraph();
          this.text(`**${seat}>** `);
          this.speaker = seat;
        }
        this.text(t);
        break;
      }
      case "thought": {
        const t = sanitizeForTerminal(ev.text);
        const prefix = this.thinker !== seat ? `${seat}: ` : "";
        this.thinker = seat;
        this.send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: prefix + t } });
        break;
      }
      case "tool_call":
        this.speaker = undefined;
        this.send({
          sessionUpdate: "tool_call",
          toolCallId: this.toolId(seat, ev.id),
          title: `${seat}: ${sanitizeForTerminal(ev.title)}`,
          kind: toolKind(ev.kind),
          status: toolStatus(ev.status),
          content: toAcpContent(ev.content),
          locations: ev.locations?.map((path) => ({ path })),
        });
        break;
      case "tool_update":
        if (ev.content) this.speaker = undefined;
        this.send({
          sessionUpdate: "tool_call_update",
          toolCallId: this.toolId(seat, ev.id),
          title: ev.title ? `${seat}: ${sanitizeForTerminal(ev.title)}` : undefined,
          status: toolStatus(ev.status),
          content: toAcpContent(ev.content),
          locations: ev.locations?.map((path) => ({ path })),
        });
        break;
      case "stop":
        this.turns.set(seat, (this.turns.get(seat) ?? 0) + 1);
        this.speaker = undefined;
        this.thinker = undefined;
        break;
      default:
        break;
    }
  }

  /** Replies from seats answering alongside another, held until each turn ends so they never interleave. */
  private readonly sideText = new Map<string, string>();

  sideEvent(seat: string, ev: SeatEvent): void {
    if (ev.type === "text") {
      this.sideText.set(seat, (this.sideText.get(seat) ?? "") + ev.text);
      return;
    }
    if (ev.type === "stop") {
      const held = this.sideText.get(seat);
      this.sideText.delete(seat);
      if (held) this.seatEvent(seat, { type: "text", text: held });
      this.speaker = undefined;
    }
    this.seatEvent(seat, ev);
  }

  /** A seat's mid-turn `post`: its own paragraph. */
  posted(seat: string, text: string): void {
    this.paragraph();
    this.text(`**${seat}>** ${sanitizeForTerminal(text)}`);
    this.speaker = undefined;
  }

  status(line: string): void {
    this.log(`[${this.sessionId}] ${line}`);
    this.paragraph();
    this.text(`[room] ${sanitizeForTerminal(line)}`);
    this.speaker = undefined;
  }

  /** Command output: its own paragraph, fenced when it is a table of lines. */
  block(text: string, fenced = false): void {
    if (!text) return;
    this.paragraph();
    this.text(fenced ? "```\n" + text + "\n```\n" : text);
    this.speaker = undefined;
  }

  /** One transcript entry, for `session/load`. */
  replay(e: Entry, human: string): void {
    if (e.from === human && e.kind === "message") {
      this.send({ sessionUpdate: "user_message_chunk", content: { type: "text", text: e.text } });
      this.tail = "";
      this.speaker = undefined;
      return;
    }
    if (e.kind === "message") {
      this.paragraph();
      this.text(`**${e.from}>** ${e.text}`);
    } else if (e.kind === "pass") {
      this.paragraph();
      this.text(`[room] ${e.from} passed`);
    } else {
      this.paragraph();
      this.text(`[room] ${e.text}`);
    }
    this.speaker = undefined;
  }

  async askHuman(req: PermissionRequestView): Promise<HumanChoice> {
    this.speaker = undefined;
    const what = req.kind ?? "this";
    try {
      const res = await this.client().request(acp.methods.client.session.requestPermission, {
        sessionId: this.sessionId,
        toolCall: {
          toolCallId: this.toolId(req.seat, req.toolCallId),
          title: `${req.seat}: ${sanitizeForTerminal(req.title)}`,
          kind: toolKind(req.kind),
          status: "pending",
          content: toAcpContent(req.content),
        },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: `Always allow ${what} for ${req.seat} (room rule)`, kind: "allow_always" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      });
      if (res.outcome.outcome === "cancelled") return "cancel";
      if (res.outcome.optionId === "allow") return "allow";
      if (res.outcome.optionId === "always") return "allow_always";
      return "deny";
    } catch (err) {
      this.log(`[${this.sessionId}] permission request failed, denying: ${describeError(err)}`);
      return "deny";
    }
  }
}

function toolKind(kind: string | undefined): acp.ToolKind | undefined {
  if (!kind) return undefined;
  return (TOOL_KINDS.has(kind) ? kind : "other") as acp.ToolKind;
}

function toolStatus(status: string | undefined): acp.ToolCallStatus | undefined {
  return status && TOOL_STATUSES.has(status) ? (status as acp.ToolCallStatus) : undefined;
}
