/**
 * The Room: seats, transcript, scheduler, policy, and git, wired together.
 * The UI is injected so the REPL, tests, and a later TUI share this code.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, validateSeatName } from "./config.js";
import { commitTurn, ensureRoomBranch, headSha, headSubject, isRepo } from "./git.js";
import { emptyPolicy, makeDecider, type Action, type HumanChoice, type Policy, type SeatPolicy } from "./permissions.js";
import { buildPreamble, PASS } from "./preamble.js";
import { parseAddress, scanMentions, Scheduler } from "./scheduler.js";
import { withTimeout } from "./seat/acp.js";
import { createSeat } from "./seat/index.js";
import { pickAskMode } from "./seat/modes.js";
import type { PermissionDecider, PermissionRequestView, Seat, SeatConfig, SeatEvent } from "./seat/types.js";
import { renderDelta, Transcript, type Entry } from "./transcript.js";

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
  /** Initial mode for a new room. A resumed room keeps its saved mode. */
  mode?: RoomMode;
  /** Seat factory, for tests. */
  makeSeat?: (config: SeatConfig, decide: PermissionDecider) => Seat;
}

export interface RoomState {
  name: string;
  started: string;
  branch?: string;
  mode: RoomMode;
  cursors: Record<string, number>;
  sessions: Record<string, string>;
  modes: Record<string, string>;
  policy: Policy;
}

/** Hand-offs allowed per human message before the room stops seats volleying. */
export const MAX_HANDOFFS = 6;

/** Tool kinds refused during a parallel round: every seat is writing at once. */
const MUTATING_KINDS = new Set(["edit", "delete", "move", "execute"]);

interface TurnResult {
  text: string;
  stopReason: string;
  failure?: string;
}

export class Room {
  readonly transcript: Transcript;
  readonly scheduler: Scheduler;
  readonly seats = new Map<string, Seat>();
  readonly state: RoomState;
  private readonly statePath: string;
  private readonly stateDir: string;
  private useGit = false;
  private stopped = false;
  private busy = false;
  private handoffs = 0;

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

  static async open(opts: RoomOptions): Promise<Room> {
    const room = new Room(opts);
    room.useGit = opts.git ?? (await isRepo(opts.cwd));
    return room;
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
    if (this.useGit) {
      this.state.branch = await ensureRoomBranch(this.opts.cwd, this.opts.name);
      ui.status(`git: on branch ${this.state.branch}, committing after every edit turn`);
      await this.commitHumanChanges("changes before the room opened");
    }
    const decide = makeDecider({
      policyFor: (seat) => this.state.policy[seat],
      override: (req) =>
        this.state.mode === "parallel" && req.kind && MUTATING_KINDS.has(req.kind) ? "deny" : undefined,
      askHuman: (req) => ui.askHuman(req),
      onAllowAlways: (seat, pattern) => this.addRule(seat, "allow", pattern),
      log: (line) => ui.status(line),
    });
    try {
      await this.startSeats(decide);
    } catch (err) {
      // One seat failing must not leave the others running.
      await Promise.all([...this.seats.values()].map((s) => s.stop().catch(() => undefined)));
      this.seats.clear();
      throw err;
    }
    this.saveState();
    if (this.transcript.entries.length === 0) {
      this.transcript.append(
        "room",
        "system",
        `Room "${this.opts.name}" opened with seats ${this.seatNames.join(", ")} and ${this.opts.human}.`,
      );
    }
  }

  private async startSeats(decide: PermissionDecider): Promise<void> {
    const { ui } = this.opts;
    await Promise.all(
      this.opts.seats.map(async (config) => {
        const seat = this.opts.makeSeat ? this.opts.makeSeat(config, decide) : createSeat(config, decide);
        this.seats.set(config.name, seat);
        const info = await seat.start();
        const sid = await seat.newSession(this.opts.cwd);
        this.state.sessions[config.name] = sid;
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
  async say(text: string): Promise<void> {
    if (this.busy) throw new Error("round in progress");
    const { targets, text: body } = parseAddress(text, this.seatNames);
    this.transcript.append(this.opts.human, "message", body);
    this.handoffs = 0;
    this.scheduler.fill(targets);
    await this.runRound();
  }

  /**
   * Another round with no new human message. Without explicit seats, a seat
   * whose last turn was a pass and who has seen nothing new since is skipped.
   */
  async continueRound(seats?: string[]): Promise<void> {
    if (this.busy) throw new Error("round in progress");
    const wanted = seats && seats.length ? seats : this.seatNames.filter((s) => !this.passedWithNothingNew(s));
    if (wanted.length === 0) {
      this.opts.ui.status("everyone passed and nothing is new; say something to continue");
      return;
    }
    this.scheduler.fill(wanted);
    await this.runRound();
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

  private async runRound(): Promise<void> {
    if (this.busy) throw new Error("round in progress");
    this.busy = true;
    try {
      while (!this.stopped && this.scheduler.pending.length) {
        if (this.state.mode === "parallel") {
          await this.runParallelBatch();
        } else {
          const seat = this.scheduler.shift()!;
          // Anything the human changed between turns is theirs, not the next seat's.
          if (this.useGit) await this.commitHumanChanges(`changes before ${seat}'s turn`);
          const entry = await this.runTurn(seat);
          if (entry?.kind === "message") this.handOff(seat, entry.text);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  /** A reply addressing another seat puts that seat next; addressing the human ends the round. */
  private handOff(from: string, text: string): void {
    const { ui } = this.opts;
    const mentions = scanMentions(text, [...this.seatNames, this.opts.human]).filter((m) => m !== from);
    if (mentions.some((m) => m.toLowerCase() === this.opts.human.toLowerCase())) {
      if (this.scheduler.pending.length) ui.status(`${from} handed back to ${this.opts.human}; round ends`);
      this.scheduler.clear();
      return;
    }
    for (const m of mentions.reverse()) {
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
    // Everyone answers this snapshot; afterwards each has seen up to here, plus its own reply.
    const snapshotLast = this.transcript.last;
    const prompts = names.map((n) => this.buildPrompt(n, true));
    const buffers = new Map<string, SeatEvent[]>(names.map((n) => [n, []]));
    const results = await Promise.all(
      names.map((n, i) => this.collectTurn(n, prompts[i], (ev) => buffers.get(n)!.push(ev))),
    );
    // Replay in roster order so the UI never interleaves two seats.
    const replies: Array<{ seat: string; entry: Entry }> = [];
    names.forEach((n, i) => {
      for (const ev of buffers.get(n)!) ui.seatEvent(n, ev);
      const entry = this.recordTurn(n, results[i]);
      replies.push({ seat: n, entry });
    });
    // Next round each seat gets the whole batch; its own entry is skipped when rendering.
    for (const r of replies) this.state.cursors[r.seat] = snapshotLast;
    this.saveState();
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
        }) + "\n\n---\n\n"
      : "";
    const note = parallel
      ? "[room]: Parallel discussion round: every seat answers at once and file changes are refused this round.\n\n"
      : "";
    return preamble + note + (rendered || `[room]: Your turn. Reply ${PASS} if you have nothing to add.`);
  }

  private async collectTurn(name: string, prompt: string, emit: (ev: SeatEvent) => void): Promise<TurnResult> {
    const seat = this.seats.get(name);
    if (!seat) throw new Error(`no such seat: ${name}`);
    const result: TurnResult = { text: "", stopReason: "end_turn" };
    try {
      await withTimeout(
        (async () => {
          for await (const ev of seat.prompt(prompt)) {
            emit(ev);
            if (ev.type === "text") result.text += ev.text;
            if (ev.type === "stop") result.stopReason = ev.stopReason;
          }
        })(),
        this.opts.turnTimeoutMs ?? 10 * 60_000,
        `${name}: turn timed out`,
      );
    } catch (err) {
      await seat.cancel();
      result.failure = (err as Error).message;
    }
    return result;
  }

  /** Append the turn's outcome to the transcript and note the session id. */
  private recordTurn(name: string, r: TurnResult): Entry {
    if (r.failure) {
      this.opts.ui.status(`${name}: ${r.failure}`);
      this.transcript.append("room", "system", `${name}'s turn failed: ${r.failure}`);
    }
    const reply = r.text.trim();
    const entry =
      !reply || reply === PASS || r.stopReason === "cancelled"
        ? this.transcript.append(name, "pass", "")
        : this.transcript.append(name, "message", reply);
    const sid = this.seats.get(name)?.sessionId;
    if (sid) this.state.sessions[name] = sid;
    return entry;
  }

  async runTurn(name: string): Promise<Entry | undefined> {
    const { ui } = this.opts;
    if (!this.seats.has(name)) throw new Error(`no such seat: ${name}`);
    const prompt = this.buildPrompt(name, false);
    const headBefore = this.useGit ? await headSha(this.opts.cwd).catch(() => undefined) : undefined;
    const result = await this.collectTurn(name, prompt, (ev) => ui.seatEvent(name, ev));
    const entry = this.recordTurn(name, result);
    // The seat has now seen everything up to and including its own reply.
    this.state.cursors[name] = this.transcript.last;

    if (this.useGit) {
      try {
        const commit = await commitTurn(this.opts.cwd, name, `${name}: turn ${entry.id}\n\n${result.text.trim().slice(0, 400)}`);
        if (commit) {
          const line = `${name} committed ${commit.sha}: ${commit.stat}`;
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

  /** Commit the working tree as the human, if dirty, so seat commits contain only seat changes. */
  private async commitHumanChanges(why: string): Promise<void> {
    try {
      const commit = await commitTurn(this.opts.cwd, this.opts.human, `${this.opts.human}: ${why}`);
      if (commit) {
        const line = `${this.opts.human} committed ${commit.sha}: ${commit.stat}`;
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
