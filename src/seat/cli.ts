/**
 * CliSeat: the fallback adapter. One harness process per turn, resumed by
 * session id, reply parsed from its JSON output. No streaming, and no
 * forwarded permissions: the recipe's unattended flags decide what the
 * harness may do. Same Seat interface as AcpSeat, so the scheduler cannot
 * tell them apart.
 */
import { execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv } from "../env.js";
import { recipeFor, type CliRecipe } from "./cli-recipes.js";
import type { PermissionDecider, Seat, SeatConfig, SeatEvent, SeatInfo } from "./types.js";

export class CliSeat implements Seat {
  readonly name: string;
  readonly recipe: CliRecipe;
  private cwd = process.cwd();
  private sid?: string;
  private child?: ChildProcess;
  private stderr = "";
  private readonly scratchDir: string;
  private turns = 0;

  constructor(
    readonly config: SeatConfig,
    // Kept for interface symmetry; a CLI turn has nothing to forward.
    _decide: PermissionDecider,
  ) {
    this.name = config.name;
    this.recipe = recipeFor(config.cli, config.command);
    this.scratchDir = mkdtempSync(join(tmpdir(), `room-cli-${config.name}-`));
  }

  async start(): Promise<SeatInfo> {
    return { agentName: `${this.recipe.id} (cli)`, loadSession: true, authMethods: [] };
  }

  async newSession(cwd: string): Promise<string> {
    this.cwd = cwd;
    this.sid = undefined;
    this.turns = 0;
    return `pending:${this.name}`;
  }

  get sessionId(): string | undefined {
    return this.sid;
  }

  async *prompt(text: string): AsyncIterable<SeatEvent> {
    this.turns += 1;
    const turn = {
      prompt: text,
      sessionId: this.sid,
      cwd: this.cwd,
      scratchFile: join(this.scratchDir, `turn-${this.turns}.txt`),
    };
    const args = [...this.recipe.args(turn), ...(this.config.args ?? [])];
    const stdout = await new Promise<string>((resolve, reject) => {
      this.child = execFile(
        this.config.command,
        args,
        { cwd: this.cwd, env: childEnv(this.config.env), maxBuffer: 64 * 1024 * 1024 },
        (err, out, errOut) => {
          this.stderr = String(errOut ?? "").slice(-16384);
          this.child = undefined;
          // A non-zero exit still often carries a JSON error we can show.
          if (err && !out) reject(new Error(`${this.name}: ${this.recipe.id} exited: ${err.message.split("\n")[0]}`));
          else resolve(String(out ?? ""));
        },
      );
    });
    const reply = this.recipe.parse(stdout, turn);
    if (reply.sessionId) this.sid = reply.sessionId;
    if (reply.error) {
      yield { type: "text", text: reply.text || `[${this.name} error: ${reply.error}]` };
      yield { type: "stop", stopReason: "refusal" };
      return;
    }
    yield { type: "text", text: reply.text };
    yield { type: "stop", stopReason: "end_turn" };
  }

  async cancel(): Promise<void> {
    this.child?.kill("SIGTERM");
  }

  async stop(): Promise<void> {
    this.child?.kill("SIGTERM");
  }

  stderrTail(): string {
    return this.stderr;
  }
}
