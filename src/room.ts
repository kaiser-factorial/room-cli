/**
 * The Room: seats, transcript, scheduler, policy, and git, wired together.
 * The UI is injected so the REPL, tests, and a later TUI share this code.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitTurn, ensureRoomBranch, isRepo } from "./git.js";
import { emptyPolicy, makeDecider, type Action, type HumanChoice, type Policy, type SeatPolicy } from "./permissions.js";
import { buildPreamble, PASS } from "./preamble.js";
import { parseAddress, Scheduler } from "./scheduler.js";
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
  /** Seat factory, for tests. */
  makeSeat?: (config: SeatConfig, decide: PermissionDecider) => Seat;
}

export interface RoomState {
  name: string;
  started: string;
  branch?: string;
  cursors: Record<string, number>;
  sessions: Record<string, string>;
  modes: Record<string, string>;
  policy: Policy;
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

  private constructor(readonly opts: RoomOptions) {
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
      : { name: opts.name, started: new Date().toISOString(), cursors: {}, sessions: {}, modes: {}, policy: {} };
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
      askHuman: (req) => ui.askHuman(req),
      onAllowAlways: (seat, pattern) => this.addRule(seat, "allow", pattern),
      log: (line) => ui.status(line),
    });
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
    this.saveState();
    if (this.transcript.entries.length === 0) {
      this.transcript.append("room", "system", `Room "${this.opts.name}" opened with seats ${this.seatNames.join(", ")} and ${this.opts.human}.`);
    }
  }

  /** The human speaks. A leading `@seat` routes the round to those seats only. */
  async say(text: string): Promise<void> {
    const { targets, text: body } = parseAddress(text, this.seatNames);
    this.transcript.append(this.opts.human, "message", body);
    this.scheduler.fill(targets);
    await this.runRound();
  }

  /** Another round with no new human message. */
  async continueRound(seats?: string[]): Promise<void> {
    this.scheduler.fill(seats);
    await this.runRound();
  }

  private async runRound(): Promise<void> {
    let seat: string | undefined;
    while (!this.stopped && (seat = this.scheduler.shift())) {
      // Anything the human changed between turns is theirs, not the next seat's.
      if (this.useGit) await this.commitHumanChanges(`changes before ${seat}'s turn`);
      await this.runTurn(seat);
    }
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

  async runTurn(name: string): Promise<Entry | undefined> {
    const seat = this.seats.get(name);
    const config = this.opts.seats.find((s) => s.name === name);
    if (!seat || !config) throw new Error(`no such seat: ${name}`);
    const { ui } = this.opts;
    const first = this.state.cursors[name] === undefined;
    const delta = this.transcript.since(this.state.cursors[name] ?? 0);
    const rendered = renderDelta(delta, name);
    const preamble = first
      ? buildPreamble({
          seat: config,
          seats: this.opts.seats,
          human: this.opts.human,
          promptsForwarded: config.adapter === "acp" && !(config.deny?.includes("*") || config.allow?.includes("*")),
          branch: this.state.branch,
        }) + "\n\n---\n\n"
      : "";
    const prompt = preamble + (rendered || `[room]: Your turn. Reply ${PASS} if you have nothing to add.`);

    let text = "";
    let stopReason = "end_turn";
    try {
      await withTimeout(
        (async () => {
          for await (const ev of seat.prompt(prompt)) {
            ui.seatEvent(name, ev);
            if (ev.type === "text") text += ev.text;
            if (ev.type === "stop") stopReason = ev.stopReason;
          }
        })(),
        this.opts.turnTimeoutMs ?? 10 * 60_000,
        `${name}: turn timed out`,
      );
    } catch (err) {
      await seat.cancel();
      const msg = (err as Error).message;
      ui.status(`${name}: ${msg}`);
      this.transcript.append("room", "system", `${name}'s turn failed: ${msg}`);
    }

    const reply = text.trim();
    let entry: Entry | undefined;
    if (!reply || reply === PASS || stopReason === "cancelled") {
      entry = this.transcript.append(name, "pass", "");
    } else {
      entry = this.transcript.append(name, "message", reply);
    }
    // The seat has now seen everything up to and including its own reply.
    this.state.cursors[name] = this.transcript.last;

    if (this.useGit) {
      try {
        const commit = await commitTurn(this.opts.cwd, name, `${name}: turn ${entry.id}\n\n${reply.slice(0, 400)}`);
        if (commit) {
          const line = `${name} committed ${commit.sha}: ${commit.stat}`;
          ui.status(line);
          this.transcript.append("room", "commit", line);
        }
      } catch (err) {
        ui.status(`${name}: commit failed: ${(err as Error).message}`);
      }
    }
    this.saveState();
    return entry;
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
