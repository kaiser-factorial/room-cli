/**
 * The Room: seats, transcript, scheduler, policy, and git, wired together.
 * The UI is injected so the REPL, tests, and a later TUI share this code.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ConfigError, validateSeatName } from "./config.js";
import { commitsAhead, commitTurn, diffText, ensureRoomBranch, ensureWorktree, headSha, headSubject, isRepo, mergeRef } from "./git.js";
import { emptyPolicy, makeDecider, type Action, type HumanChoice, type Policy, type SeatPolicy } from "./permissions.js";
import { BACKGROUND, buildPreamble, LAND, PASS, roleList, rolePrompt } from "./preamble.js";
import { humanTags, parseAddress, scanMentions } from "./scheduler.js";
import { describeError, withTimeout } from "./seat/acp.js";
import { createSeat } from "./seat/index.js";
import { pickAskMode } from "./seat/modes.js";
import type { PermissionDecider, PermissionRequestView, Seat, SeatConfig, SeatEvent } from "./seat/types.js";
import { neutralizeLabels, renderDelta, Transcript, type Entry } from "./transcript.js";
import { Activity } from "./activity.js";
import { RoomMcp, type RoomTools } from "./server/mcp.js";
import { moderatorFor, type LimitCase, type Moderator, type Verdict } from "./moderator.js";

export interface RoomUI {
  seatEvent(seat: string, ev: SeatEvent): void;
  /** A background turn's events, live. Without it they go to `seatEvent`. */
  backgroundEvent?(seat: string, ev: SeatEvent): void;
  /** A turn answering alongside another one, so the two do not split each other. Without it: `seatEvent`. */
  sideEvent?(seat: string, ev: SeatEvent): void;
  askHuman(req: PermissionRequestView): Promise<HumanChoice>;
  status(line: string): void;
  /** A seat posted mid-turn with the room's `post` tool. Without it: `status`. */
  posted?(seat: string, text: string): void;
  /** A limit tripped and the moderator is the human: let it through? Without it, it holds. */
  askLimit?(question: string): Promise<boolean>;
}

export type RoomMode = "sequential" | "parallel";

export interface RoomOptions {
  name: string;
  cwd: string;
  seats: SeatConfig[];
  human: string;
  ui: RoomUI;
  /** Where the transcript and state live. Default: `<cwd>/.room/<name>`. */
  stateDir?: string;
  turnTimeoutMs?: number;
  /** Background turns are long by design. Default: an hour. */
  backgroundTimeoutMs?: number;
  /** Commit after edit turns on a `room/<name>` branch. Default: true when cwd is a repo. */
  git?: boolean;
  /**
   * Give each seat its own desk: a git worktree on `desk/<room>/<seat>`,
   * merged into the room's branch after each turn. Default: on with git.
   */
  desks?: boolean;
  /** Initial mode for a new room. A resumed room keeps its saved mode. */
  mode?: RoomMode;
  /** Start in auto mode: tool calls no rule matches run without asking. A resumed room keeps its setting. */
  auto?: boolean;
  /** Who an untagged human message wakes, for a new room: "last" (default) or "all". */
  wake?: "last" | "all";
  /** Seat-to-seat wakes per thread for a new room; null for no limit. */
  cap?: number | null;
  /** Posts a seat may make with the `post` tool in one turn. Default 3. */
  postLimit?: number;
  /** Least time between two posts from one seat, in ms. Default 5000. */
  postGapMs?: number;
  /** Decides when a limit trips (cap, echo, post limit). Without one, limits just hold. */
  moderator?: Moderator;
  /** Serve the room's MCP tools (inbox, post, status, show, diff) to seats that take them. Default: true. */
  tools?: boolean;
  /** Seat factory, for tests. */
  makeSeat?: (config: SeatConfig, decide: PermissionDecider, notice: (text: string) => void) => Seat;
}

export interface RoomState {
  name: string;
  started: string;
  branch?: string;
  mode: RoomMode;
  /** Auto mode: tool calls no rule matches run without asking the human. */
  auto?: boolean;
  /** Who an untagged human message wakes: whoever spoke last (default), or every idle seat. */
  wake?: "last" | "all";
  /** Seat-to-seat wakes per thread; null for no limit. Default MAX_HANDOFFS. */
  cap?: number | null;
  /** Roles set with `/role`, over the roster's. `null`: no role. */
  roles?: Record<string, string | null>;
  /** The lineup, in roster order, as last opened. `room resume` reopens it. */
  seats?: string[];
  cursors: Record<string, number>;
  sessions: Record<string, string>;
  /** Each seat's desk, when the room has them. */
  desks?: Record<string, { path: string; branch: string }>;
  modes: Record<string, string>;
  policy: Policy;
}

/** Errors that retrying cannot fix before something outside the room changes. */
const BENCH_NOW = /rate.?limit|session limit|usage limit|quota|auth(entication)? required|log ?in/i;

/** The task in a reply whose first or last line is `[background] <task>`, else undefined. */
export function backgroundTask(text: string): string | undefined {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const l of [lines.at(-1), lines[0]]) {
    if (l?.startsWith(BACKGROUND)) return l.slice(BACKGROUND.length).trim();
  }
  return undefined;
}

/** A reply whose first or last line is `[land]`. */
export function wantsLand(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && (lines[0] === LAND || lines[lines.length - 1] === LAND);
}

/** `a.py, b.py` for a commit note; the first few files, then a count. */
function fileList(files: string[], max = 5): string {
  return files.length <= max ? files.join(", ") : `${files.slice(0, max).join(", ")} and ${files.length - max} more`;
}

/** One conversation: the seats queued to answer, in order, and who is answering now. */
interface Thread {
  id: number;
  queue: string[];
  answering: Set<string>;
  /** Seat-to-seat wakes so far, against the cap. */
  wakes: number;
  /** Seats tagged past the cap or paused as a volley; `/cap +n` lets them go on. */
  held: string[];
  hops: Array<{ from: string; to: string; length: number }>;
  /** Extra wakes the moderator granted past the cap. */
  bonus: number;
  /** Moderator decisions still out: the thread is not over until they are in. */
  pending: number;
  cancelled: boolean;
  resolve: (r: RoundResult) => void;
}

/** A reply shorter than this, bouncing between two seats, counts toward a volley. */
const VOLLEY_SHORT = 300;

/** Seat-to-seat wakes allowed per thread before the room pauses it (`/cap` changes it). */
export const MAX_HANDOFFS = 6;

/** A moderator can let a thread run to this many times the cap, and no further. */
const CEILING = 3;

/** Tool kinds refused during a parallel round: every seat is writing at once. */
const MUTATING_KINDS = new Set(["edit", "delete", "move", "execute"]);

/** How a round ended. `cancelled` when `cancel()` stopped it. */
export interface RoundResult {
  cancelled: boolean;
}

interface TurnResult {
  text: string;
  stopReason: string;
  failure?: string;
  activity: Activity;
}

export class Room {
  readonly transcript: Transcript;
  readonly seats = new Map<string, Seat>();
  readonly state: RoomState;
  private readonly statePath: string;
  private readonly stateDir: string;
  private useGit = false;
  private useDesks = false;
  /** Trunk merges run one at a time, whichever seat finishes first. */
  private trunkLock: Promise<unknown> = Promise.resolve();
  /** Seats working in the background, out of the rotation, and their running turn. */
  readonly background = new Map<string, Promise<void>>();
  /** Background work asked to stop, possibly before its turn has started. */
  private readonly stopRequests = new Set<string>();
  /** What happened to a seat's desk since its last turn, told to it on its next. */
  private readonly deskNotes = new Map<string, string>();
  private stopped = false;
  private busy = false;
  private handoffs = 0;
  /**
   * Seats sitting out after failing in a way retrying will not fix: a rate
   * limit or a login at once, anything else after the same error twice.
   * Addressing one with `@name`, or `unbench`, brings it back.
   */
  readonly benched = new Set<string>();
  private readonly lastFailure = new Map<string, { error: string; count: number }>();
  /** Seats whose turn is running now: one in sequential mode, several in a parallel batch. */
  private readonly active = new Set<string>();
  /** Conversations in flight: each human message starts one, and seats' tags extend it. */
  private readonly threads: Thread[] = [];
  private threadCount = 0;
  /** Seats whose turn is being set up (git work before the prompt), so nothing else starts them. */
  private readonly starting = new Set<string>();
  /** The room's MCP server, when seats get its tools. */
  private mcp?: RoomMcp;
  /** Seats given the room's tools, told about them in their preamble. */
  private readonly withTools = new Set<string>();
  /** How far a seat mid-turn has read, its prompt plus what `inbox` showed it. */
  private readonly reading = new Map<string, number>();
  /** A seat's posts this turn: how many, when the last was, and what it said. */
  private readonly posts = new Map<string, { count: number; at: number; text: string }>();
  /** Seats whose turn the human cut short with `@seat!`, and who did. */
  private readonly interrupted = new Map<string, string>();
  /** Told to an interrupted seat at the top of its next turn. */
  private readonly cutNotes = new Map<string, string>();
  /** A moderator's nudge, told to the seat at the top of its next turn. */
  private readonly modNotes = new Map<string, string>();
  private mod?: Moderator;

  private constructor(readonly opts: RoomOptions) {
    for (const s of opts.seats) {
      validateSeatName(s.name, "room");
      if (s.name.toLowerCase() === opts.human.toLowerCase()) {
        throw new ConfigError(`seat "${s.name}" has the same name as the human; pick another --human or seat name`);
      }
    }
    this.stateDir = opts.stateDir ?? join(opts.cwd, ".room", opts.name);
    mkdirSync(this.stateDir, { recursive: true });
    // The default state dir lives inside the shared working directory; keep it out of git.
    const ignore = join(opts.cwd, ".room", ".gitignore");
    if (!opts.stateDir && !existsSync(ignore)) writeFileSync(ignore, "*\n");
    this.statePath = join(this.stateDir, "state.json");
    this.transcript = Transcript.open(join(this.stateDir, "transcript.jsonl"));
    this.state = existsSync(this.statePath)
      ? (JSON.parse(readFileSync(this.statePath, "utf8")) as RoomState)
      : {
          name: opts.name,
          started: new Date().toISOString(),
          mode: opts.mode ?? "sequential",
          cursors: {},
          sessions: {},
          modes: {},
          policy: {},
        };
    this.state.mode ??= "sequential";
    if (opts.auto) this.state.auto = true;
    this.mod = opts.moderator;
    if (opts.wake) this.state.wake ??= opts.wake;
    if (opts.cap !== undefined) this.state.cap ??= opts.cap;
    for (const s of opts.seats) {
      const p = (this.state.policy[s.name] ??= emptyPolicy());
      for (const r of s.allow ?? []) if (!p.allow.includes(r)) p.allow.push(r);
      for (const r of s.ask ?? []) if (!p.ask.includes(r)) p.ask.push(r);
      for (const r of s.deny ?? []) if (!p.deny.includes(r)) p.deny.push(r);
    }
  }

  /** Whether a room with this name has saved state, i.e. can be resumed. */
  static exists(cwd: string, name: string, stateDir?: string): boolean {
    return existsSync(join(stateDir ?? join(cwd, ".room", name), "state.json"));
  }

  /** `base` if no room has that name in `cwd`, else `base-2`, `base-3`, ...: `start` always opens a new room. */
  static freshName(cwd: string, base = "main"): string {
    if (!Room.exists(cwd, base)) return base;
    for (let i = 2; ; i++) if (!Room.exists(cwd, `${base}-${i}`)) return `${base}-${i}`;
  }

  /** The seats a saved room last had, in order; older state files only know their sessions. */
  static savedSeats(cwd: string, name: string, stateDir?: string): string[] {
    const path = join(stateDir ?? join(cwd, ".room", name), "state.json");
    if (!existsSync(path)) return [];
    const state = JSON.parse(readFileSync(path, "utf8")) as RoomState;
    return state.seats ?? Object.keys(state.sessions ?? {});
  }

  static async open(opts: RoomOptions): Promise<Room> {
    const room = new Room(opts);
    room.useGit = opts.git ?? (await isRepo(opts.cwd));
    room.useDesks = room.useGit && opts.desks !== false;
    return room;
  }

  /** A seat as system lines name it: with its harness when that differs, e.g. `claude (claude-agent-acp)`. */
  label(seat: string): string {
    const config = this.opts.seats.find((s) => s.name === seat);
    const harness = config ? basename(config.command) : undefined;
    return harness && harness !== seat ? `${seat} (${harness})` : seat;
  }

  /** Where a seat works: its desk, or the shared directory. */
  seatCwd(seat: string): string {
    return this.state.desks?.[seat]?.path ?? this.opts.cwd;
  }

  get seatNames(): string[] {
    return this.opts.seats.map((s) => s.name);
  }

  get mode(): RoomMode {
    return this.state.mode;
  }

  setRoomMode(mode: RoomMode): void {
    this.state.mode = mode;
    this.saveState();
  }

  get auto(): boolean {
    return Boolean(this.state.auto);
  }

  /** A seat's config with any role set in the room over the roster's. */
  configOf(name: string): SeatConfig {
    const config = this.opts.seats.find((s) => s.name === name)!;
    const set = this.state.roles?.[name];
    return set === undefined ? config : { ...config, role: set ?? undefined };
  }

  roleOf(name: string): string | undefined {
    return this.configOf(name).role;
  }

  /**
   * Give a seat a role mid-session (`/role`), or none. The seat's first-turn
   * instructions are long sent, so the room tells it in the transcript; a
   * fresh session later gets the role in its instructions.
   */
  setRole(seat: string, role: string | null): void {
    if (!this.seatNames.includes(seat)) throw new Error(`no such seat: ${seat}`);
    const prompt = role ? rolePrompt(role, seat) : undefined; // throws on an unknown role
    (this.state.roles ??= {})[seat] = role;
    this.saveState();
    const label = role ? roleList().find((r) => r.id === role)!.label : undefined;
    this.transcript.append(
      "room",
      "system",
      role ? `${seat}'s role is now ${label}. ${seat}, from here on: ${prompt}` : `${seat} no longer has a role; it answers as itself.`,
    );
    this.opts.ui.status(role ? `${seat} is now the ${label}` : `${seat} has no role`);
  }

  setWake(wake: "last" | "all"): void {
    this.state.wake = wake;
    this.saveState();
  }

  setAuto(on: boolean): void {
    this.state.auto = on;
    this.saveState();
  }

  /** Spawn every seat, open sessions, apply modes, and note it in the transcript. */
  async start(): Promise<void> {
    const { ui } = this.opts;
    /** Seats whose saved session was opened outside a desk: they start fresh in one. */
    const movedIn = new Set<string>();
    if (this.useGit) {
      this.state.branch = await ensureRoomBranch(this.opts.cwd, this.opts.name);
      await this.commitHumanChanges("changes before the room opened");
      if (this.useDesks) {
        const desks = (this.state.desks ??= {});
        for (const s of this.opts.seats) {
          if (!desks[s.name] && this.state.sessions[s.name]) movedIn.add(s.name);
          const desk = { path: join(this.stateDir, "desks", s.name), branch: `desk/${this.opts.name}/${s.name}` };
          await ensureWorktree(this.opts.cwd, desk.path, desk.branch, this.state.branch);
          desks[s.name] = desk;
        }
        ui.status(`git: trunk ${this.state.branch}; each seat works and commits in its own desk, and lands its work with [land]`);
      } else {
        ui.status(`git: on branch ${this.state.branch}, committing after every edit turn`);
      }
    }
    const decide = makeDecider({
      policyFor: (seat) => this.state.policy[seat],
      // With desks every seat edits its own copy, so a parallel round can change files too.
      override: (req) =>
        !this.useDesks && this.state.mode === "parallel" && req.kind && MUTATING_KINDS.has(req.kind) ? "deny" : undefined,
      askHuman: (req) => ui.askHuman(req),
      auto: () => Boolean(this.state.auto),
      onAllowAlways: (seat, pattern) => this.addRule(seat, "allow", pattern),
      log: (line) => ui.status(line),
    });
    if (this.opts.tools !== false) {
      this.mcp = new RoomMcp(this.toolsFor());
      await this.mcp.start();
    }
    try {
      await this.startSeats(decide, movedIn);
    } catch (err) {
      // One seat failing must not leave the others running.
      await Promise.all([...this.seats.values()].map((s) => s.stop().catch(() => undefined)));
      this.seats.clear();
      await this.mcp?.stop();
      throw err;
    }
    // A reopened room with a different lineup: say so, or seats keep addressing whoever left.
    const before = this.state.seats;
    const left = before?.filter((s) => !this.seatNames.includes(s)) ?? [];
    const joined = before ? this.seatNames.filter((s) => !before.includes(s)) : [];
    if (left.length || joined.length) {
      const parts = [
        joined.length ? `${joined.join(", ")} joined` : "",
        left.length ? `${left.join(", ")} left and cannot be addressed` : "",
      ].filter(Boolean);
      this.transcript.append(
        "room",
        "system",
        `Room reopened. ${parts.join("; ")}. Seats now: ${this.seatNames.join(", ")}, and ${this.opts.human}.`,
      );
    }
    this.state.seats = this.seatNames;
    this.saveState();
    if (this.state.auto) ui.status("auto: tool calls run without asking, except your deny and ask rules (/auto off)");
    if (this.transcript.entries.length === 0) {
      this.transcript.append(
        "room",
        "system",
        `Room "${this.opts.name}" opened with seats ${this.seatNames.join(", ")} and ${this.opts.human}.`,
      );
    }
  }

  private async startSeats(decide: PermissionDecider, movedIn: Set<string>): Promise<void> {
    const { ui } = this.opts;
    await Promise.all(
      this.opts.seats.map(async (seatConfig) => {
        // In a desk the seat commits for itself: under its own name, not the human's git identity.
        const config: SeatConfig = this.useDesks
          ? {
              ...seatConfig,
              env: {
                GIT_AUTHOR_NAME: seatConfig.name,
                GIT_AUTHOR_EMAIL: `${seatConfig.name}@room`,
                GIT_COMMITTER_NAME: seatConfig.name,
                GIT_COMMITTER_EMAIL: `${seatConfig.name}@room`,
                ...seatConfig.env,
              },
            }
          : seatConfig;
        const cwd = this.seatCwd(config.name);
        const notice = (text: string) => ui.status(`${this.label(config.name)} ${text}`);
        const seat = this.opts.makeSeat ? this.opts.makeSeat(config, decide, notice) : createSeat(config, decide, notice);
        this.seats.set(config.name, seat);
        const info = await seat.start();
        if (this.mcp && seat.useMcp) {
          seat.useMcp(this.mcp.endpoint(config.name));
          this.withTools.add(config.name);
        }
        // A reopened room: reattach to the seat's saved session, or start fresh and replay.
        const saved = this.state.sessions[config.name];
        const seen = this.state.cursors[config.name];
        let resumed = false;
        if (movedIn.has(config.name)) ui.status(`${config.name}: moving into its desk; starting a fresh session`);
        else if (saved && seen !== undefined && !saved.startsWith("pending:") && seat.resumeSession) {
          resumed = await seat.resumeSession(saved, cwd);
          ui.status(resumed ? `${config.name}: resumed session ${saved}` : `${config.name}: could not resume; replaying the transcript`);
        }
        if (!resumed) {
          const sid = await seat.newSession(cwd);
          this.state.sessions[config.name] = sid;
          if (seen !== undefined) delete this.state.cursors[config.name];
        }
        const wanted = config.mode ?? pickAskMode(seat.modes);
        if (wanted && seat.setMode && seat.modes?.current !== wanted) {
          await seat.setMode(wanted);
          this.state.modes[config.name] = wanted;
        } else if (seat.modes?.current) {
          this.state.modes[config.name] = seat.modes.current;
        }
        ui.status(
          `${config.name}: ${info.agentName ?? config.command} ready` +
            (this.state.modes[config.name] ? `, mode ${this.state.modes[config.name]}` : ""),
        );
      }),
    );
  }

  /**
   * The human speaks, and it posts at once, whatever else is going on. Who
   * wakes: the seats it tags (anywhere in it, `@all` for every idle seat),
   * else whoever spoke last. Tagged seats answer one at a time (together in
   * parallel mode), each seeing the replies before it. A tag with `!`
   * (`@grok!`) interrupts that seat if it is busy. Resolves when the thread
   * this message starts has gone quiet.
   */
  async say(text: string): Promise<RoundResult> {
    const { ui } = this.opts;
    const { text: body } = parseAddress(text, this.seatNames);
    const tags = humanTags(text, this.seatNames);
    this.transcript.append(this.opts.human, "message", body);
    for (const t of tags.seats) if (this.benched.has(t)) this.unbench(t);
    // `!`: interrupt a busy seat so it reads this now.
    for (const t of tags.urgent) {
      if (this.background.has(t)) {
        ui.status(`${t} is interrupted: its background work stops here, and it reads this now`);
        await this.stopBackground(t);
      } else if (this.active.has(t)) {
        ui.status(`${t} is interrupted to read this now`);
        this.interrupted.set(t, this.opts.human);
        await this.seats.get(t)?.cancel().catch(() => undefined);
      }
    }
    let wanted: string[];
    if (tags.all) wanted = this.activeSeats();
    else if (tags.seats.length) wanted = tags.seats;
    else if (this.state.wake === "all") wanted = this.activeSeats();
    else wanted = this.lastSpeaker() ? [this.lastSpeaker()!] : this.activeSeats().slice(0, 1);
    for (const t of wanted.filter((x) => this.background.has(x))) {
      ui.status(`${t} is working in the background; it reads this when it finishes (@${t}! to interrupt)`);
    }
    wanted = wanted.filter((x) => !this.background.has(x) && !this.benched.has(x));
    if (wanted.length === 0) {
      if (!tags.seats.length && !this.activeSeats().length) ui.status(`every seat is benched or busy; @name one to bring it back`);
      return { cancelled: false };
    }
    // An interrupt jumps the line: the seats it names answer before other threads go on.
    return this.startThread(wanted, tags.urgent.some((u) => wanted.includes(u)));
  }

  /**
   * Wake seats with nothing new from the human. Without explicit seats,
   * every seat in the rotation except one that passed and has seen nothing
   * new since.
   */
  async continueRound(seats?: string[]): Promise<RoundResult> {
    const wanted = seats && seats.length ? seats : this.activeSeats().filter((s) => !this.passedWithNothingNew(s));
    if (wanted.length === 0) {
      this.opts.ui.status("everyone passed and nothing is new; say something to continue");
      return { cancelled: false };
    }
    return this.startThread(wanted);
  }

  /** The seat that spoke most recently and can still be woken. */
  private lastSpeaker(): string | undefined {
    const entries = this.transcript.entries;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if ((e.kind === "message" || e.kind === "pass") && this.seatNames.includes(e.from) && this.activeSeats().includes(e.from)) return e.from;
    }
    return undefined;
  }

  /** Seats in the rotation: not benched, not working in the background. In roster order. */
  activeSeats(): string[] {
    return this.seatNames.filter((s) => !this.benched.has(s) && !this.background.has(s));
  }

  unbench(seat: string): boolean {
    if (!this.benched.delete(seat)) return false;
    this.lastFailure.delete(seat);
    this.opts.ui.status(`${seat} is back in the rotation`);
    return true;
  }

  /** Whether any thread is still going: seats queued or answering. */
  get roundRunning(): boolean {
    return this.threads.length > 0;
  }

  /** Seats queued to answer, in the order they will, across threads. */
  get queued(): string[] {
    return [...new Set(this.threads.flatMap((t) => t.queue))];
  }

  /** Seat-to-seat wakes allowed per thread before the room pauses it; null for no limit. */
  get cap(): number | null {
    return this.state.cap === undefined ? MAX_HANDOFFS : this.state.cap;
  }

  /**
   * `/cap`: a number, `off`, or `+n`. Raising it lets paused threads go on:
   * seats held back at the old limit are queued again.
   */
  setCap(value: number | null, release = false): void {
    this.state.cap = value;
    this.saveState();
    if (!release) return;
    for (const t of this.threads) {
      for (const s of t.held.splice(0)) if (!t.queue.includes(s)) t.queue.push(s);
    }
    this.pump();
  }

  /**
   * Stop every thread: drop the queues and cancel the seats answering. Each
   * cancelled turn is recorded as a pass, and nothing it tagged wakes.
   * Background work goes on (`/stop` ends that).
   */
  async cancel(): Promise<void> {
    if (!this.threads.length) return;
    for (const t of this.threads) {
      t.cancelled = true;
      t.queue.length = 0;
      t.held.length = 0;
    }
    const answering = [...this.active].filter((n) => !this.background.has(n));
    await Promise.all(answering.map((n) => this.seats.get(n)?.cancel().catch(() => undefined)));
    this.opts.ui.status("round cancelled");
    this.pump();
  }

  // ---- threads: who answers, in what order ----

  private startThread(queue: string[], first = false): Promise<RoundResult> {
    const { thread, done } = this.newThread(queue);
    if (first) this.threads.unshift(...this.threads.splice(this.threads.indexOf(thread), 1));
    this.pump();
    return done;
  }

  private newThread(queue: string[]): { thread: Thread; done: Promise<RoundResult> } {
    let resolve!: (r: RoundResult) => void;
    const done = new Promise<RoundResult>((r) => (resolve = r));
    const thread: Thread = {
      id: ++this.threadCount,
      queue: [...new Set(queue)],
      answering: new Set(),
      wakes: 0,
      held: [],
      hops: [],
      bonus: 0,
      pending: 0,
      cancelled: false,
      resolve,
    };
    this.threads.push(thread);
    return { thread, done };
  }

  /**
   * Start whatever can start. A seat answers one turn at a time. In a
   * thread, seats go in order (all at once in parallel mode). Without desks
   * seats share one directory, so only one answers at a time in the whole
   * room, unless a parallel round refuses their edits.
   */
  private pump(): void {
    if (this.stopped) return;
    const parallel = this.state.mode === "parallel";
    for (const t of [...this.threads]) {
      if (t.cancelled) t.queue.length = 0;
      const shared = !this.useDesks && !parallel;
      const batch: string[] = [];
      // A parallel batch is recorded and landed in roster order, whoever finishes first.
      let prev: Promise<void> = Promise.resolve();
      while (t.queue.length && (parallel || t.answering.size === 0)) {
        if (shared && this.answeringCount() > 0) break;
        const i = t.queue.findIndex((s) => !this.active.has(s) && !this.starting.has(s) && !this.background.has(s));
        if (i < 0) break;
        const [seat] = t.queue.splice(i, 1);
        batch.push(seat);
        if (parallel) {
          if (batch.length === 1) this.opts.ui.status(`parallel round: ${[seat, ...t.queue.filter((s) => !this.active.has(s) && !this.background.has(s))].join(", ")}`);
          if (this.configOf(seat).adapter === "cli") this.opts.ui.status(`${seat} is a cli seat: its edits cannot be refused, only asked for in the prompt`);
        }
        let done!: () => void;
        const mine = new Promise<void>((r) => (done = r));
        this.beginTurn(t, seat, parallel, parallel ? { wait: prev, done } : undefined);
        prev = mine;
        if (!parallel) break;
      }
      if (!t.queue.length && t.answering.size === 0 && t.pending === 0) {
        this.threads.splice(this.threads.indexOf(t), 1);
        t.resolve({ cancelled: t.cancelled });
      }
    }
  }

  private answeringCount(): number {
    return [...this.active, ...this.starting].filter((n) => !this.background.has(n)).length;
  }

  private beginTurn(t: Thread, seat: string, parallel: boolean, order?: { wait: Promise<void>; done: () => void }): void {
    t.answering.add(seat);
    this.starting.add(seat);
    // Another seat is already answering: this one's output goes to the side, so neither splits the other.
    // In a parallel round every seat is alongside the others, the first included.
    const alongside = parallel || this.answeringCount() > 1;
    void (async () => {
      try {
        // Anything the human changed is theirs, not the seat's. Under the trunk lock: another seat may be merging.
        if (this.useGit) await this.withTrunk(() => this.commitHumanChanges(`changes before ${seat}'s turn`));
        if (t.cancelled) return;
        const { ui } = this.opts;
        const emit = (ev: SeatEvent) => (alongside && ui.sideEvent ? ui.sideEvent(seat, ev) : ui.seatEvent(seat, ev));
        const entry = await this.runTurn(seat, { emit, parallel, cancelled: () => t.cancelled, after: order?.wait });
        const cut = this.interrupted.delete(seat) && entry?.text.endsWith(`(interrupted by ${this.opts.human})`);
        if (entry?.kind === "message" && !cut && !t.cancelled && !this.stopped) {
          this.maybeBackground(seat, entry.text);
          this.route(t, seat, entry.text);
        }
      } catch (err) {
        this.opts.ui.status(`${seat}: ${(err as Error).message}`);
      } finally {
        order?.done();
        this.starting.delete(seat);
        t.answering.delete(seat);
        this.pump();
      }
    })();
  }

  /**
   * A seat's reply tags others: they join the end of its thread's queue. A
   * tag is `@name` (or `@all`) on the reply's first or last line; one in the
   * middle is a citation ("as @grok said"), so a seat cannot steer the room
   * from inside its prose. A seat mid-turn is not woken again: the message
   * waits in its unread part. Seat-to-seat wakes stop at the cap, and two
   * seats volleying short replies are paused.
   */
  private route(t: Thread, from: string, text: string): void {
    const { ui } = this.opts;
    const lines = text.split("\n").filter((l) => l.trim());
    const edges = lines.length <= 2 ? lines.join("\n") : `${lines[0]}\n${lines[lines.length - 1]}`;
    const all = /(?:^|[\s(,;:>"'*_])@all\b/i.test(edges.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " "));
    let mentions = scanMentions(edges, [...this.seatNames, this.opts.human]).filter((m) => m !== from);
    const human = this.opts.human.toLowerCase();
    if (mentions.some((m) => m.toLowerCase() === human)) ui.status(`${from} asked for ${this.opts.human}`);
    mentions = mentions.filter((m) => m.toLowerCase() !== human);
    if (all) mentions = [...new Set([...mentions, ...this.activeSeats().filter((s) => s !== from)])];
    for (const m of mentions) {
      if (this.benched.has(m)) {
        ui.status(`${from} → ${m}, but ${m} is benched; @${m} to bring it back`);
        continue;
      }
      if (this.background.has(m)) {
        ui.status(`${from} → ${m}, but ${m} is working in the background; it reads this when it finishes`);
        continue;
      }
      if (this.active.has(m) || this.starting.has(m)) {
        ui.status(`${from} → ${m}, who is mid-turn; it reads this next time`);
        continue;
      }
      if (t.queue.includes(m) || t.held.includes(m)) continue;
      const cap = this.cap;
      if (cap !== null && t.wakes >= cap * CEILING) {
        t.held.push(m);
        ui.status(`${from} → ${m}, held: ${t.wakes} seat-to-seat wakes this thread, the most even a moderator can allow (/cap +10 to go on)`);
        continue;
      }
      if (cap !== null && t.wakes >= cap + t.bonus) {
        if (this.moderator) this.consult(t, { kind: "cap", from, to: m, detail: `${t.wakes} seat-to-seat wakes this thread (cap ${cap})`, recent: this.recent() }, text);
        else {
          t.held.push(m);
          ui.status(`${from} → ${m}, held: ${cap} seat-to-seat wakes this thread (/cap +10 to let them go on)`);
        }
        continue;
      }
      if (this.volleying(t, from, m, text)) {
        if (this.moderator) this.consult(t, { kind: "echo", from, to: m, detail: `${from} and ${m} have traded short replies four times running`, recent: this.recent() }, text);
        else {
          t.held.push(m);
          ui.status(`${from} and ${m} have been going back and forth; paused. @ either to continue`);
        }
        continue;
      }
      t.wakes += 1;
      t.hops.push({ from, to: m, length: text.length });
      t.queue.push(m);
      ui.status(`${from} → ${m}`);
    }
  }

  /**
   * A limit tripped and a moderator is set: hold the seat while it decides.
   * Allowed, the seat is queued with a little headroom (three more wakes, or
   * a fresh echo count) so the moderator is not asked again at once.
   */
  private consult(t: Thread, c: LimitCase & { to: string }, text: string): void {
    const { ui } = this.opts;
    const mod = this.moderator!;
    t.held.push(c.to);
    t.pending += 1;
    ui.status(`${c.from} → ${c.to}: ${c.detail}; asking the moderator (${mod.label})`);
    void mod
      .decide(c)
      .catch((err): Verdict => ({ verdict: "hold", reason: `moderator failed: ${(err as Error).message}`, by: mod.label }))
      .then((v) => {
        const line = `moderator (${v.by}): ${v.verdict} ${c.from} → ${c.to}: ${v.reason}`;
        this.transcript.append("room", "system", line);
        ui.status(v.verdict === "hold" ? `${line} (/cap +10 or @${c.to} to go on)` : line);
        if (v.verdict === "hold" || t.cancelled || this.stopped) return;
        const i = t.held.indexOf(c.to);
        if (i < 0) return; // released meanwhile (/cap)
        t.held.splice(i, 1);
        if (c.kind === "cap") t.bonus = t.wakes + 3 - (this.cap ?? 0);
        else t.hops.length = 0;
        if (v.note) for (const s of [c.from, c.to]) this.modNotes.set(s, `[room]: The moderator says: ${v.note}`);
        if (!t.queue.includes(c.to)) {
          t.wakes += 1;
          t.hops.push({ from: c.from, to: c.to, length: text.length });
          t.queue.push(c.to);
        }
      })
      .finally(() => {
        t.pending -= 1;
        this.pump();
      });
  }

  /** The last few messages, for the moderator. */
  private recent(n = 8): string {
    const entries = this.transcript.entries.filter((e) => e.kind === "message").slice(-n);
    return entries.map((e) => `[${e.from}]: ${e.text.length > 600 ? e.text.slice(0, 600) + " …" : e.text}`).join("\n\n");
  }

  /** Who decides when a limit trips: a model, the human, or nobody (limits just hold). */
  get moderator(): Moderator | undefined {
    return this.mod;
  }

  setModerator(m: Moderator | undefined): void {
    this.mod = m;
  }

  /** `/mod`: "off", "you", "auto", or an OpenRouter model id. */
  useModerator(spec: string): void {
    const { ui } = this.opts;
    this.mod = moderatorFor(spec, { ask: ui.askLimit?.bind(ui), status: (l) => ui.status(l) });
  }

  /** Two seats waking each other with short replies, again and again: an echo, not a discussion. */
  private volleying(t: Thread, from: string, to: string, text: string): boolean {
    const recent = [...t.hops.slice(-3), { from, to, length: text.length }];
    if (recent.length < 4) return false;
    const pair = new Set([from, to]);
    return recent.every((h, i) => pair.has(h.from) && pair.has(h.to) && h.from !== h.to && (i === 0 || h.from === recent[i - 1].to)) &&
      recent.every((h) => h.length < VOLLEY_SHORT);
  }

  /**
   * A seat works on `task` in its desk while the room goes on without it:
   * out of the rotation, its events shown live, its reply posted and its
   * work landed when it finishes. From the human (`/bg`), or from a seat
   * ending its reply with `[background] <task>`.
   */
  startBackground(name: string, task: string, from: "human" | "seat" = "human"): boolean {
    const { ui } = this.opts;
    if (!this.seats.has(name)) throw new Error(`no such seat: ${name}`);
    if (!this.useDesks) {
      ui.status(`background work needs desks (a git repo, without --no-desks): ${name} would be editing the directory everyone shares`);
      return false;
    }
    if (this.background.has(name)) {
      ui.status(`${name} is already working in the background`);
      return false;
    }
    if (this.active.has(name)) {
      ui.status(`${name} is mid-turn; send it to the background after`);
      return false;
    }
    for (const t of this.threads) t.queue.splice(0, t.queue.length, ...t.queue.filter((s) => s !== name));
    if (from === "human") this.transcript.append(this.opts.human, "message", `@${name} (in the background) ${task}`);
    else this.transcript.append("room", "system", `${name} went on working in the background: ${task}`);
    ui.status(`${name} is working in the background: ${task} (/stop ${name} to cancel)`);
    const run = this.runBackground(name, task).finally(() => this.background.delete(name));
    this.background.set(name, run);
    return true;
  }

  /** Cancel a seat's background work. Its reply so far is recorded; its desk keeps the work. */
  async stopBackground(name: string, graceMs = Infinity): Promise<boolean> {
    const run = this.background.get(name);
    if (!run) return false;
    this.stopRequests.add(name);
    // The turn may not have reached the seat yet (its desk syncs first): cancel until it ends,
    // or until the grace runs out (shutting down: the seat's process is stopped next).
    let done = false;
    void run.finally(() => (done = true));
    const deadline = Date.now() + graceMs;
    while (!done && Date.now() < deadline) {
      await this.seats.get(name)?.cancel().catch(() => undefined);
      await Promise.race([run, new Promise((r) => setTimeout(r, 250))]);
    }
    if (done) this.stopRequests.delete(name);
    return true;
  }

  private async runBackground(name: string, task: string): Promise<void> {
    const { ui } = this.opts;
    await this.syncDesk(name);
    const snapshot = this.transcript.last;
    this.reading.set(name, snapshot);
    this.posts.delete(name);
    const prompt =
      this.buildPrompt(name, false) +
      `\n\n[room]: You are working in the background on: ${task}\n` +
      `The conversation goes on without you, and ${this.opts.human} sees your progress. ` +
      `Keep going until it is done; your reply is posted when you finish.`;
    const show = (ev: SeatEvent) => (ui.backgroundEvent ? ui.backgroundEvent(name, ev) : ui.seatEvent(name, ev));
    const result = this.stopRequests.has(name)
      ? { text: "", stopReason: "cancelled", activity: new Activity() }
      : await this.collectTurn(name, prompt, show, this.opts.backgroundTimeoutMs ?? 60 * 60_000);
    const entry = this.recordTurn(name, result);
    // It saw the room up to when it left, plus what it read with `inbox`, and not the rest said while it worked.
    this.state.cursors[name] = Math.max(snapshot, this.reading.get(name) ?? 0);
    this.reading.delete(name);
    if (result.stopReason === "cancelled" || result.failure) {
      // Half-done: committed on the desk, never landed by its reply; the human decides with /land.
      await this.closeTurn(name, entry, "");
      const line = `${name}'s background work ${result.failure ? "failed" : "was stopped"}; what it did is on its desk (/land ${name} to bring it in)`;
      ui.status(line);
      this.transcript.append("room", "system", line);
    } else {
      ui.status(`${name} finished its background work`);
      await this.closeTurn(name, entry, result.text);
    }
    this.saveState();
    if (!this.stopped && entry.kind === "message") this.maybeBackground(name, entry.text);
  }

  /**
   * How far a seat has read after a turn: what it was shown, plus its own
   * entries. Anything another seat (a background one) added during the turn
   * is still news to it.
   */
  private seenThrough(name: string, snapshot: number): number {
    let seen = snapshot;
    for (const e of this.transcript.since(snapshot)) {
      if (e.from !== name) break;
      seen = e.id;
    }
    return seen;
  }

  /** A reply ending `[background] <task>` sends its seat on working. */
  private maybeBackground(name: string, text: string): void {
    const task = backgroundTask(text);
    if (task !== undefined) this.startBackground(name, task || "the work it described", "seat");
  }

  private passedWithNothingNew(seat: string): boolean {
    const entries = this.transcript.entries;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.from === seat && (e.kind === "message" || e.kind === "pass")) {
        if (e.kind === "message") return false;
        return !entries.slice(i + 1).some((x) => x.kind === "message" && x.from !== seat);
      }
    }
    return false;
  }

  private buildPrompt(name: string, parallel: boolean): string {
    const config = this.configOf(name);
    const first = this.state.cursors[name] === undefined;
    const delta = this.transcript.since(this.state.cursors[name] ?? 0);
    const rendered = renderDelta(delta, name, [this.opts.human, "room"]);
    const preamble = first
      ? buildPreamble({
          seat: config,
          seats: this.opts.seats,
          human: this.opts.human,
          promptsForwarded: config.adapter === "acp" && !(config.deny?.includes("*") || config.allow?.includes("*")),
          branch: this.state.branch,
          desk: this.state.desks?.[name],
          tools: this.withTools.has(name),
        }) + "\n\n---\n\n"
      : "";
    const note = !parallel
      ? ""
      : this.useDesks
        ? "[room]: Parallel round: every seat answers at once, each in its own desk.\n\n"
        : "[room]: Parallel discussion round: every seat answers at once and file changes are refused this round.\n\n";
    const desk = this.deskNotes.get(name);
    this.deskNotes.delete(name);
    const cut = [this.cutNotes.get(name), this.modNotes.get(name)].filter(Boolean).join("\n\n");
    this.cutNotes.delete(name);
    this.modNotes.delete(name);
    return (
      preamble +
      note +
      (cut ? `${cut}\n\n` : "") +
      (rendered || `[room]: Your turn. Reply ${PASS} if you have nothing to add.`) +
      (desk ? `\n\n${desk}` : "")
    );
  }

  private async collectTurn(
    name: string,
    prompt: string,
    emit: (ev: SeatEvent) => void,
    timeoutMs = this.opts.turnTimeoutMs ?? 10 * 60_000,
  ): Promise<TurnResult> {
    const seat = this.seats.get(name);
    if (!seat) throw new Error(`no such seat: ${name}`);
    const result: TurnResult = { text: "", stopReason: "end_turn", activity: new Activity() };
    this.active.add(name);
    // Once the turn is over (timed out included), anything its reader still yields is dropped.
    let open = true;
    try {
      await withTimeout(
        (async () => {
          for await (const ev of seat.prompt(prompt)) {
            if (!open) return;
            emit(ev);
            result.activity.observe(ev);
            if (ev.type === "text") result.text += ev.text;
            if (ev.type === "stop") result.stopReason = ev.stopReason;
          }
        })(),
        timeoutMs,
        `${name}: turn timed out`,
      );
    } catch (err) {
      await seat.cancel();
      result.failure = describeError(err);
    } finally {
      open = false;
      this.active.delete(name);
    }
    return result;
  }

  /**
   * Append the turn's outcome to the transcript and note the session id. A
   * failed turn is the room's note, not the seat's message: harnesses often
   * stream their error as reply text first ("You've hit your session
   * limit"), and the other seats must not read that as the seat speaking.
   * Text streamed before a real failure is kept in the note, quoted.
   */
  private recordTurn(name: string, r: TurnResult): Entry {
    const reply = r.text.trim();
    const steps = r.activity.used ? { seat: name, items: r.activity.steps() } : undefined;
    const sid = this.seats.get(name)?.sessionId;
    if (sid) this.state.sessions[name] = sid;
    if (r.failure) {
      const failure = r.failure.replace(/\s+/g, " ").trim();
      this.opts.ui.status(`${this.label(name)} turn failed: ${failure}`);
      this.noteFailure(name, failure);
      const partial = reply && !failure.includes(reply.replace(/\s+/g, " "))
        ? `\nWhat it wrote before failing:\n${neutralizeLabels(reply)}`
        : "";
      return this.transcript.append("room", "system", `${name}'s turn failed: ${failure}${partial}`, steps);
    }
    this.lastFailure.delete(name);
    const by = this.interrupted.get(name);
    if (by && r.stopReason === "cancelled") {
      // Cut short by the human: what it had written stays, marked, and its tags wake nobody.
      this.cutNotes.set(name, `[room]: ${by} interrupted your last turn to say something. Read it first; pick your work back up only if it still stands.`);
      return reply
        ? this.transcript.append(name, "message", `${reply}\n\n(interrupted by ${by})`, steps)
        : this.transcript.append("room", "system", `${name} was interrupted by ${by}.`, steps);
    }
    return !reply || reply === PASS || r.stopReason === "cancelled"
      ? this.transcript.append(name, "pass", "", steps)
      : this.transcript.append(name, "message", reply, steps);
  }

  /** Bench a seat whose failures will not clear by themselves. */
  private noteFailure(name: string, failure: string): void {
    const prev = this.lastFailure.get(name);
    const count = prev?.error === failure ? prev.count + 1 : 1;
    this.lastFailure.set(name, { error: failure, count });
    const now = BENCH_NOW.test(failure);
    if (!now && count < 2) return;
    this.benched.add(name);
    const why = now ? "its harness says to wait or log in" : "it failed twice with the same error";
    this.opts.ui.status(`${name} is benched: ${why}. @${name} or /unbench ${name} brings it back`);
    this.transcript.append("room", "system", `${name} sits out until ${this.opts.human} brings it back.`);
    for (const t of this.threads) t.queue.splice(0, t.queue.length, ...t.queue.filter((s) => s !== name));
  }

  async runTurn(
    name: string,
    how: { emit?: (ev: SeatEvent) => void; parallel?: boolean; cancelled?: () => boolean; after?: Promise<void> } = {},
  ): Promise<Entry | undefined> {
    const { ui } = this.opts;
    if (!this.seats.has(name)) throw new Error(`no such seat: ${name}`);
    if (this.useDesks) await this.syncDesk(name);
    // A cancel that came during the git work above: the seat never starts.
    if (how.cancelled?.()) return undefined;
    const prompt = this.buildPrompt(name, Boolean(how.parallel));
    const snapshot = this.transcript.last;
    this.reading.set(name, snapshot);
    this.posts.delete(name);
    const headBefore = this.useGit ? await headSha(this.opts.cwd).catch(() => undefined) : undefined;
    const result = await this.collectTurn(name, prompt, how.emit ?? ((ev) => ui.seatEvent(name, ev)));
    await how.after;
    const entry = this.recordTurn(name, result);
    this.state.cursors[name] = this.seenThrough(name, Math.max(snapshot, this.reading.get(name) ?? 0));
    this.reading.delete(name);

    if (this.useDesks) {
      await this.closeTurn(name, entry, result.text);
    } else if (this.useGit) {
      try {
        const commit = await commitTurn(this.opts.cwd, name, `${name}: turn ${entry.id}\n\n${result.text.trim().slice(0, 400)}`);
        if (commit) {
          const line = `${name} committed ${commit.sha}: ${commit.stat} (${fileList(commit.files)})`;
          ui.status(line);
          this.transcript.append("room", "commit", line);
        }
        // The preamble says not to; note it when a seat commits anyway, so history stays explainable.
        const headAfter = await headSha(this.opts.cwd);
        if (headBefore && headAfter !== headBefore && !commit) {
          const line = `${name} committed directly: ${headAfter} ${await headSubject(this.opts.cwd)}`;
          ui.status(line);
          this.transcript.append("room", "system", line);
        }
      } catch (err) {
        ui.status(`${name}: commit failed: ${(err as Error).message}`);
      }
    }
    this.saveState();
    return entry;
  }

  private withTrunk<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.trunkLock.then(fn, fn);
    this.trunkLock = run.catch(() => undefined);
    return run;
  }

  /**
   * Before a seat's turn: bring the trunk into its desk, so it builds on
   * everyone's work. A conflict is left to the seat, which owns its desk.
   */
  private async syncDesk(name: string): Promise<void> {
    const desk = this.state.desks?.[name];
    const trunk = this.state.branch;
    if (!desk || !trunk) return;
    try {
      // Anything left uncommitted (a turn that failed before closing) is the seat's.
      await commitTurn(desk.path, name, `${name}: uncommitted work`);
      const r = await this.withTrunk(() => mergeRef(desk.path, trunk, name));
      if (r.status === "merged") {
        this.deskNotes.set(name, `[room]: Merged ${trunk} into your branch: ${r.stat} (${fileList(r.files)}).`);
      } else if (r.status === "conflict") {
        const where = r.files.length ? ` in ${fileList(r.files)}` : " (uncommitted changes in the way)";
        this.opts.ui.status(`${name}'s desk conflicts with ${trunk}${where}; ${name} is asked to merge it`);
        this.deskNotes.set(
          name,
          `[room]: ${trunk} has changes that conflict with your branch${where}. Merge it (\`git merge ${trunk}\`), ` +
            `resolve, and commit; the room brings your branch into ${trunk} when your turn ends.`,
        );
      }
    } catch (err) {
      this.opts.ui.status(`${name}: could not update its desk: ${(err as Error).message}`);
    }
  }

  /**
   * After a seat's turn: commit what it left uncommitted, as the seat, on
   * its desk. Its branch lands on the trunk only when its reply says `[land]`.
   */
  private async closeTurn(name: string, entry: Entry, text: string): Promise<void> {
    const desk = this.state.desks?.[name];
    if (!desk) return;
    try {
      await commitTurn(desk.path, name, `${name}: turn ${entry.id}\n\n${text.trim().slice(0, 400)}`);
    } catch (err) {
      this.opts.ui.status(`${name}: could not commit its desk: ${(err as Error).message}`);
    }
    if (wantsLand(text)) await this.mergeDesk(name);
    this.saveState();
  }

  /** Merge a seat's branch into the trunk. A conflict leaves the work on its desk, and says so. */
  private async mergeDesk(name: string): Promise<void> {
    const desk = this.state.desks?.[name];
    const trunk = this.state.branch;
    if (!desk || !trunk) return;
    const { ui } = this.opts;
    try {
      await this.withTrunk(async () => {
        await this.commitHumanChanges(`changes before ${name}'s work landed`);
        const r = await mergeRef(this.opts.cwd, desk.branch, name);
        if (r.status === "merged") {
          const line = `${name} landed ${r.commits} commit${r.commits === 1 ? "" : "s"} on ${trunk} (${r.sha}): ${r.stat} (${fileList(r.files)})`;
          ui.status(line);
          this.transcript.append("room", "commit", line);
        } else if (r.status === "conflict") {
          const line = `${name}'s work conflicts with ${trunk} in ${fileList(r.files)}; it stays on ${desk.branch} until ${name} merges ${trunk} into it`;
          ui.status(line);
          this.transcript.append("room", "system", line);
        } else {
          ui.status(`${name} has nothing to land: ${trunk} already has its work`);
        }
      });
    } catch (err) {
      ui.status(`${name}: could not land its work: ${(err as Error).message}`);
    }
  }

  /** The human's `/land`: commit what the seat left on its desk, as the seat, and merge it now. */
  async land(name: string): Promise<boolean> {
    const desk = this.state.desks?.[name];
    if (!desk) return false;
    if (this.active.has(name)) throw new Error(`${name} is mid-turn; land it after`);
    await commitTurn(desk.path, name, `${name}: uncommitted work`).catch(() => undefined);
    this.transcript.append("room", "system", `${this.opts.human} landed ${name}'s work.`);
    await this.mergeDesk(name);
    this.saveState();
    return true;
  }

  /** Commits on a seat's desk that the trunk does not have yet. */
  async unlanded(name: string): Promise<number> {
    const desk = this.state.desks?.[name];
    const trunk = this.state.branch;
    if (!desk || !trunk) return 0;
    return commitsAhead(this.opts.cwd, trunk, desk.branch).catch(() => 0);
  }

  /** Commit the working tree as the human, if dirty, so seat commits contain only seat changes. */
  private async commitHumanChanges(why: string): Promise<void> {
    try {
      const commit = await commitTurn(this.opts.cwd, this.opts.human, `${this.opts.human}: ${why}`);
      if (commit) {
        const line = `${this.opts.human} committed ${commit.sha}: ${commit.stat} (${fileList(commit.files)})`;
        this.opts.ui.status(line);
        this.transcript.append("room", "commit", line);
      }
    } catch (err) {
      this.opts.ui.status(`commit of ${this.opts.human}'s changes failed: ${(err as Error).message}`);
    }
  }

  // ---- the room's MCP tools, called by a seat mid-turn ----

  private toolsFor(): RoomTools {
    return {
      inbox: (seat) => this.inbox(seat),
      post: (seat, text) => this.post(seat, text),
      status: (seat) => this.statusFor(seat),
      show: (seat, args) => this.show(args),
      diff: (seat, args) => this.diffFor(seat, args.seat ?? seat),
    };
  }

  /** What others said since the seat last read; marks it read, so its next turn does not repeat it. */
  private inbox(seat: string): string {
    const from = this.reading.get(seat) ?? this.state.cursors[seat] ?? 0;
    const news = this.transcript.since(from).filter((e) => e.from !== seat);
    if (this.reading.has(seat)) this.reading.set(seat, this.transcript.last);
    const text = renderDelta(news, seat, [this.opts.human, "room"]);
    return text || "Nothing new.";
  }

  /** Post now, mid-turn. Tags on its first or last line wake seats as a reply's would. */
  private async post(seat: string, text: string): Promise<string> {
    if (!this.active.has(seat)) throw new Error("post works during your turn only; reply normally instead");
    if (text === PASS) return "Not posted: passing is for your final reply.";
    const limit = this.opts.postLimit ?? 3;
    const gap = this.opts.postGapMs ?? 5000;
    const mine = this.posts.get(seat) ?? { count: 0, at: 0, text: "" };
    if (text === mine.text) throw new Error("Not posted: you just posted that.");
    if (mine.count >= limit) {
      const refused = `Not posted: ${limit} posts a turn is the limit. Put the rest in your final reply.`;
      if (!this.moderator) throw new Error(refused);
      const v = await this.moderator.decide({ kind: "post", from: seat, detail: `${mine.count} posts this turn (limit ${limit})`, recent: this.recent(), text });
      const line = `moderator (${v.by}): ${v.verdict} a post from ${seat} past its limit: ${v.reason}`;
      this.transcript.append("room", "system", line);
      this.opts.ui.status(line);
      if (v.verdict === "hold") throw new Error(`${refused} (The moderator held it: ${v.reason})`);
      if (!this.active.has(seat)) throw new Error("post works during your turn only; reply normally instead");
    }
    const wait = mine.at + gap - Date.now();
    if (wait > 0) throw new Error(`Not posted: one post every ${Math.round(gap / 1000)}s; try again in ${Math.ceil(wait / 1000)}s, or keep working.`);
    this.posts.set(seat, { count: mine.count + 1, at: Date.now(), text });
    this.transcript.append(seat, "message", text);
    const { ui } = this.opts;
    if (ui.posted) ui.posted(seat, text);
    else ui.status(`${seat} posted: ${text}`);
    if (!this.background.has(seat) || /@/.test(text)) {
      const t = this.threads.find((x) => x.answering.has(seat)) ?? this.newThread([]).thread;
      this.route(t, seat, text);
      this.pump();
    }
    return "Posted.";
  }

  private statusFor(seat: string): string {
    const queued = this.queued;
    const rows = this.seatNames.map((s) => {
      const state = this.background.has(s)
        ? "working in the background"
        : this.active.has(s) || this.starting.has(s)
          ? "answering"
          : this.benched.has(s)
            ? "benched"
            : queued.includes(s)
              ? `queued (${queued.indexOf(s) + 1})`
              : "idle";
      return `- ${s}${s === seat ? " (you)" : ""}: ${state}${this.roleOf(s) ? `, role ${this.roleOf(s)}` : ""}`;
    });
    const cap = this.cap;
    return [
      `Room "${this.opts.name}", ${this.opts.human} is the human.`,
      ...rows,
      `mode ${this.state.mode}; untagged messages wake ${this.state.wake === "all" ? "everyone" : "whoever spoke last"}; ` +
        `seat-to-seat wakes per thread: ${cap === null ? "no limit" : cap}` +
        (this.useDesks ? `; trunk ${this.state.branch}` : ""),
    ].join("\n");
  }

  private show(args: { id?: number; from?: string; last?: number }): string {
    const all = this.transcript.entries;
    let picked: Entry[];
    if (args.id !== undefined) {
      const e = all.find((x) => x.id === args.id);
      if (!e) throw new Error(`no entry ${args.id} (last is ${this.transcript.last})`);
      picked = [e];
    } else {
      const n = Math.min(Math.max(1, Math.floor(args.last ?? 5)), 50);
      const from = args.from?.toLowerCase();
      picked = all.filter((e) => !from || e.from.toLowerCase() === from).slice(-n);
    }
    if (!picked.length) return "No entries.";
    return picked
      .map((e) => {
        const steps = e.steps?.items.filter((i) => "tool" in i).map((i) => `  tool: ${(i as { tool: string }).tool}`) ?? [];
        const body = e.kind === "pass" ? "(passed)" : neutralizeLabels(e.text);
        return [`#${e.id} [${e.from}] ${e.kind} ${e.ts}`, body, ...steps].join("\n");
      })
      .join("\n\n");
  }

  private async diffFor(caller: string, target: string): Promise<string> {
    const seat = this.seatNames.find((s) => s.toLowerCase() === target.toLowerCase());
    if (!seat) throw new Error(`no seat ${target} (have: ${this.seatNames.join(", ")})`);
    if (!this.useGit) return "The room is not in a git repo; there is nothing to diff against.";
    const cap = (text: string) => (text.length > 30_000 ? `${text.slice(0, 30_000)}\n… (cut at 30000 characters)` : text);
    const desk = this.state.desks?.[seat];
    const trunk = this.state.branch;
    if (desk && trunk) {
      const landed = await diffText(this.opts.cwd, [`${trunk}...${desk.branch}`]);
      const loose = await diffText(desk.path, ["HEAD"]).catch(() => "");
      const parts = [
        landed ? `Committed on ${desk.branch}, not on ${trunk} yet:\n${landed}` : `${seat} has no commits that ${trunk} lacks.`,
        loose ? `Uncommitted in ${seat === caller ? "your" : `${seat}'s`} desk:\n${loose}` : "",
      ].filter(Boolean);
      return cap(parts.join("\n\n"));
    }
    const loose = await diffText(this.opts.cwd, ["HEAD"]);
    return cap(loose ? `Uncommitted in the shared directory (all seats):\n${loose}` : "No uncommitted changes.");
  }

  // ---- permissions and modes, for the REPL ----

  policyOf(seat: string): SeatPolicy {
    return (this.state.policy[seat] ??= emptyPolicy());
  }

  addRule(seat: string, action: Action, pattern: string): void {
    const p = this.policyOf(seat);
    for (const list of [p.allow, p.ask, p.deny]) {
      const i = list.indexOf(pattern);
      if (i >= 0) list.splice(i, 1);
    }
    p[action].push(pattern);
    this.saveState();
  }

  removeRule(seat: string, pattern: string): boolean {
    const p = this.policyOf(seat);
    let removed = false;
    for (const list of [p.allow, p.ask, p.deny]) {
      const i = list.indexOf(pattern);
      if (i >= 0) {
        list.splice(i, 1);
        removed = true;
      }
    }
    this.saveState();
    return removed;
  }

  modesOf(seat: string): Seat["modes"] {
    return this.seats.get(seat)?.modes;
  }

  async setMode(seat: string, modeId: string): Promise<void> {
    const s = this.seats.get(seat);
    if (!s) throw new Error(`no such seat: ${seat}`);
    if (!s.setMode) throw new Error(`${seat} does not support modes`);
    await s.setMode(modeId);
    this.state.modes[seat] = modeId;
    this.saveState();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const running = [...this.background.values()];
    // A harness that ignores cancel must not hold the room open: a short grace, then stop its process.
    await Promise.all([...this.background.keys()].map((n) => this.stopBackground(n, 3000)));
    await Promise.all([...this.seats.values()].map((s) => s.stop().catch(() => undefined)));
    await Promise.race([Promise.allSettled(running), new Promise((r) => setTimeout(r, 2000))]);
    await this.mcp?.stop();
    this.saveState();
  }

  private saveState(): void {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2) + "\n");
  }
}
