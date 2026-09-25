/**
 * The Room: seats, transcript, scheduler, policy, and git, wired together.
 * The UI is injected so the REPL, tests, and a later TUI share this code.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ConfigError, validateSeatName } from "./config.js";
import { commitTurn, ensureRoomBranch, ensureWorktree, headSha, headSubject, isRepo, mergeRef } from "./git.js";
import { emptyPolicy, makeDecider, type Action, type HumanChoice, type Policy, type SeatPolicy } from "./permissions.js";
import { buildPreamble, HOLD, PASS } from "./preamble.js";
import { parseAddress, scanMentions, Scheduler } from "./scheduler.js";
import { describeError, withTimeout } from "./seat/acp.js";
import { createSeat } from "./seat/index.js";
import { pickAskMode } from "./seat/modes.js";
import type { PermissionDecider, PermissionRequestView, Seat, SeatConfig, SeatEvent } from "./seat/types.js";
import { neutralizeLabels, renderDelta, Transcript, type Entry } from "./transcript.js";
import { Activity } from "./activity.js";

export interface RoomUI {
  seatEvent(seat: string, ev: SeatEvent): void;
  askHuman(req: PermissionRequestView): Promise<HumanChoice>;
  status(line: string): void;
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
  /** Commit after edit turns on a `room/<name>` branch. Default: true when cwd is a repo. */
  git?: boolean;
  /**
   * Give each seat its own desk: a git worktree on `desk/<room>/<seat>`,
   * merged into the room's branch after each turn. Default: on with git.
   */
  desks?: boolean;
  /** Initial mode for a new room. A resumed room keeps its saved mode. */
  mode?: RoomMode;
  /** Seat factory, for tests. */
  makeSeat?: (config: SeatConfig, decide: PermissionDecider, notice: (text: string) => void) => Seat;
}

export interface RoomState {
  name: string;
  started: string;
  branch?: string;
  mode: RoomMode;
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

/** A reply whose first or last line is `[hold]`. */
export function wantsHold(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && (lines[0] === HOLD || lines[lines.length - 1] === HOLD);
}

/** `a.py, b.py` for a commit note; the first few files, then a count. */
function fileList(files: string[], max = 5): string {
  return files.length <= max ? files.join(", ") : `${files.slice(0, max).join(", ")} and ${files.length - max} more`;
}

/** Hand-offs allowed per human message before the room stops seats volleying. */
export const MAX_HANDOFFS = 6;

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
  readonly scheduler: Scheduler;
  readonly seats = new Map<string, Seat>();
  readonly state: RoomState;
  private readonly statePath: string;
  private readonly stateDir: string;
  private useGit = false;
  private useDesks = false;
  /** Trunk merges run one at a time, whichever seat finishes first. */
  private trunkLock: Promise<unknown> = Promise.resolve();
  /** Seats whose work stays on their desk: they ended their last turn with `[hold]`. */
  readonly holding = new Set<string>();
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
  private cancelRequested = false;

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
    this.scheduler = new Scheduler(opts.seats.map((s) => s.name));
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
        ui.status(`git: trunk ${this.state.branch}; each seat works in its own desk and lands on the trunk after its turn`);
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
      onAllowAlways: (seat, pattern) => this.addRule(seat, "allow", pattern),
      log: (line) => ui.status(line),
    });
    try {
      await this.startSeats(decide, movedIn);
    } catch (err) {
      // One seat failing must not leave the others running.
      await Promise.all([...this.seats.values()].map((s) => s.stop().catch(() => undefined)));
      this.seats.clear();
      throw err;
    }
    this.state.seats = this.seatNames;
    this.saveState();
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

  /** The human speaks. A leading `@seat` routes the round to those seats only. */
  async say(text: string): Promise<RoundResult> {
    if (this.busy) throw new Error("round in progress");
    const { targets, text: body } = parseAddress(text, this.seatNames);
    this.transcript.append(this.opts.human, "message", body);
    this.handoffs = 0;
    // Addressing a benched seat is asking for it back.
    for (const t of targets) if (this.benched.has(t)) this.unbench(t);
    const wanted = targets.length ? targets : this.activeSeats();
    if (wanted.length === 0) {
      this.opts.ui.status(`every seat is benched; @name one, or /unbench, to bring it back`);
      return { cancelled: false };
    }
    this.scheduler.fill(wanted);
    return this.runRound();
  }

  /**
   * Another round with no new human message. Without explicit seats, a seat
   * whose last turn was a pass and who has seen nothing new since is skipped.
   */
  async continueRound(seats?: string[]): Promise<RoundResult> {
    if (this.busy) throw new Error("round in progress");
    const wanted = seats && seats.length ? seats : this.activeSeats().filter((s) => !this.passedWithNothingNew(s));
    if (wanted.length === 0) {
      this.opts.ui.status("everyone passed and nothing is new; say something to continue");
      return { cancelled: false };
    }
    this.scheduler.fill(wanted);
    return this.runRound();
  }

  /** Seats not benched, in roster order. */
  activeSeats(): string[] {
    return this.seatNames.filter((s) => !this.benched.has(s));
  }

  unbench(seat: string): boolean {
    if (!this.benched.delete(seat)) return false;
    this.lastFailure.delete(seat);
    this.opts.ui.status(`${seat} is back in the rotation`);
    return true;
  }

  get roundRunning(): boolean {
    return this.busy;
  }

  /**
   * Stop the running round: drop the queue and cancel every seat mid-turn.
   * Each cancelled turn is recorded as a pass, and no hand-off follows it.
   */
  async cancel(): Promise<void> {
    if (!this.busy) return;
    this.cancelRequested = true;
    this.scheduler.clear();
    await Promise.all([...this.active].map((n) => this.seats.get(n)?.cancel().catch(() => undefined)));
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

  private async runRound(): Promise<RoundResult> {
    if (this.busy) throw new Error("round in progress");
    this.busy = true;
    this.cancelRequested = false;
    try {
      while (!this.stopped && !this.cancelRequested && this.scheduler.pending.length) {
        if (this.state.mode === "parallel") {
          await this.runParallelBatch();
        } else {
          const seat = this.scheduler.shift()!;
          // Anything the human changed between turns is theirs, not the next seat's.
          if (this.useGit) await this.commitHumanChanges(`changes before ${seat}'s turn`);
          const entry = await this.runTurn(seat);
          if (entry?.kind === "message" && !this.cancelRequested) this.handOff(seat, entry.text);
        }
      }
      if (this.cancelRequested) {
        this.scheduler.clear();
        this.opts.ui.status("round cancelled");
      }
      return { cancelled: this.cancelRequested };
    } finally {
      this.busy = false;
      this.cancelRequested = false;
    }
  }

  /**
   * A reply addressing another seat puts that seat next. An address is a
   * mention on the reply's first or last line; one in the middle is a
   * citation ("as @grok said") and is ignored, so a seat cannot steer the
   * room from inside its prose. Asking for the human is announced, never
   * lets one seat cut the others off.
   */
  private handOff(from: string, text: string): void {
    const { ui } = this.opts;
    const lines = text.split("\n").filter((l) => l.trim());
    const edges = lines.length <= 2 ? lines.join("\n") : `${lines[0]}\n${lines[lines.length - 1]}`;
    const mentions = scanMentions(edges, [...this.seatNames, this.opts.human]).filter((m) => m !== from);
    const human = this.opts.human.toLowerCase();
    if (mentions.some((m) => m.toLowerCase() === human)) ui.status(`${from} asked for ${this.opts.human}`);
    for (const m of mentions.filter((x) => x.toLowerCase() !== human).reverse()) {
      if (this.benched.has(m)) {
        ui.status(`${from} → ${m}, but ${m} is benched; @${m} to bring it back`);
        continue;
      }
      // Moving an already-queued seat forward is free; adding a turn counts.
      const extraTurn = !this.scheduler.pending.includes(m);
      if (extraTurn && this.handoffs >= MAX_HANDOFFS) {
        ui.status(`hand-off limit (${MAX_HANDOFFS}) reached; say something to continue`);
        return;
      }
      if (extraTurn) this.handoffs += 1;
      this.scheduler.pushFront(m);
      ui.status(`${from} → ${m}`);
    }
  }

  /** Every queued seat answers the same snapshot at once. Edits are refused by the decider. */
  private async runParallelBatch(): Promise<void> {
    const { ui } = this.opts;
    const names: string[] = [];
    let s: string | undefined;
    while ((s = this.scheduler.shift())) names.push(s);
    ui.status(`parallel round: ${names.join(", ")}`);
    for (const n of names) {
      if (this.opts.seats.find((s) => s.name === n)?.adapter === "cli") {
        ui.status(`${n} is a cli seat: its edits cannot be refused, only asked for in the prompt`);
      }
    }
    if (this.useDesks) for (const n of names) await this.syncDesk(n);
    // Everyone answers this snapshot; afterwards each has seen up to here, plus its own reply.
    const snapshotLast = this.transcript.last;
    const prompts = names.map((n) => this.buildPrompt(n, true));
    const buffers = new Map<string, SeatEvent[]>(names.map((n) => [n, []]));
    const results = await Promise.all(
      names.map((n, i) => this.collectTurn(n, prompts[i], (ev) => buffers.get(n)!.push(ev))),
    );
    // Replay in roster order so the UI never interleaves two seats.
    const replies: Array<{ seat: string; entry: Entry }> = [];
    for (const [i, n] of names.entries()) {
      for (const ev of buffers.get(n)!) ui.seatEvent(n, ev);
      const entry = this.recordTurn(n, results[i]);
      replies.push({ seat: n, entry });
      // Landed in roster order: a later seat that touched the same lines conflicts and is told.
      if (this.useDesks) await this.landDesk(n, entry, results[i].text);
    }
    // Next round each seat gets the whole batch; its own entry is skipped when rendering.
    for (const r of replies) this.state.cursors[r.seat] = snapshotLast;
    this.saveState();
    if (this.cancelRequested) return;
    for (const r of replies) if (r.entry.kind === "message") this.handOff(r.seat, r.entry.text);
  }

  private buildPrompt(name: string, parallel: boolean): string {
    const config = this.opts.seats.find((s) => s.name === name)!;
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
        }) + "\n\n---\n\n"
      : "";
    const note = !parallel
      ? ""
      : this.useDesks
        ? "[room]: Parallel round: every seat answers at once, each in its own desk.\n\n"
        : "[room]: Parallel discussion round: every seat answers at once and file changes are refused this round.\n\n";
    const desk = this.deskNotes.get(name);
    this.deskNotes.delete(name);
    return (
      preamble +
      note +
      (rendered || `[room]: Your turn. Reply ${PASS} if you have nothing to add.`) +
      (desk ? `\n\n${desk}` : "")
    );
  }

  private async collectTurn(name: string, prompt: string, emit: (ev: SeatEvent) => void): Promise<TurnResult> {
    const seat = this.seats.get(name);
    if (!seat) throw new Error(`no such seat: ${name}`);
    const result: TurnResult = { text: "", stopReason: "end_turn", activity: new Activity() };
    this.active.add(name);
    try {
      await withTimeout(
        (async () => {
          for await (const ev of seat.prompt(prompt)) {
            emit(ev);
            result.activity.observe(ev);
            if (ev.type === "text") result.text += ev.text;
            if (ev.type === "stop") result.stopReason = ev.stopReason;
          }
        })(),
        this.opts.turnTimeoutMs ?? 10 * 60_000,
        `${name}: turn timed out`,
      );
    } catch (err) {
      await seat.cancel();
      result.failure = describeError(err);
    } finally {
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
    this.scheduler.remove(name);
  }

  async runTurn(name: string): Promise<Entry | undefined> {
    const { ui } = this.opts;
    if (!this.seats.has(name)) throw new Error(`no such seat: ${name}`);
    if (this.useDesks) await this.syncDesk(name);
    const prompt = this.buildPrompt(name, false);
    const headBefore = this.useGit ? await headSha(this.opts.cwd).catch(() => undefined) : undefined;
    const result = await this.collectTurn(name, prompt, (ev) => ui.seatEvent(name, ev));
    const entry = this.recordTurn(name, result);
    // The seat has now seen everything up to and including its own reply.
    this.state.cursors[name] = this.transcript.last;

    if (this.useDesks) {
      await this.landDesk(name, entry, result.text);
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
      // Anything left uncommitted (a turn that failed before landing) is the seat's;
      // held work stays as the seat left it.
      if (!this.holding.has(name)) await commitTurn(desk.path, name, `${name}: uncommitted work`);
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
   * After a seat's turn: commit what it left uncommitted, as the seat, and
   * merge its branch into the trunk. A conflict leaves the work on the desk.
   */
  private async landDesk(name: string, entry: Entry, text: string): Promise<void> {
    const desk = this.state.desks?.[name];
    const trunk = this.state.branch;
    if (!desk || !trunk) return;
    const { ui } = this.opts;
    if (wantsHold(text)) {
      this.holding.add(name);
      const line = `${name} is holding its work on ${desk.branch}; it lands after a turn ${name} ends without ${HOLD}, or on /land ${name}`;
      ui.status(line);
      this.transcript.append("room", "system", line);
      return;
    }
    this.holding.delete(name);
    try {
      await commitTurn(desk.path, name, `${name}: turn ${entry.id}\n\n${text.trim().slice(0, 400)}`);
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
        }
      });
    } catch (err) {
      ui.status(`${name}: could not land its work: ${(err as Error).message}`);
    }
    this.saveState();
  }

  /** Land a seat's work now, held or not: the human's `/land`. */
  async land(name: string): Promise<boolean> {
    if (!this.state.desks?.[name]) return false;
    if (this.active.has(name)) throw new Error(`${name} is mid-turn; land it after`);
    this.holding.delete(name);
    await this.landDesk(name, this.transcript.append("room", "system", `${this.opts.human} landed ${name}'s work.`), "");
    return true;
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
    await Promise.all([...this.seats.values()].map((s) => s.stop().catch(() => undefined)));
    this.saveState();
  }

  private saveState(): void {
    writeFileSync(this.statePath, JSON.stringify(this.state, null, 2) + "\n");
  }
}
