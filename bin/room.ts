#!/usr/bin/env node
/**
 * room: a terminal room for one human and several coding agents.
 *
 * `start` and `resume` open a room in a REPL; `acp` serves it to an editor;
 * `doctor`, `roster`, and `spike` check the seats.
 */
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import readline from "node:readline/promises";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Command } from "commander";
import { applyRoomFile, ConfigError, loadRoomFile, loadRoster, pickSeats } from "../src/config.js";
import { runDoctor, type DoctorRow } from "../src/doctor.js";
import { EXIT } from "../src/exit-codes.js";
import { Room } from "../src/room.js";
import { AcpSeat } from "../src/seat/acp.js";
import type { PermissionRequestView, SeatConfig } from "../src/seat/types.js";
import { rolePrompt } from "../src/preamble.js";
import { serveAcp } from "../src/server/acp.js";
import { runTui, TuiUI } from "../src/ui/tui/run.js";
import { TuiStore } from "../src/ui/tui/store.js";
import { LineSource, ReplUI, runRepl } from "../src/ui/repl.js";

const program = new Command();
program
  .name("room")
  .description("One human, several coding agents, over the Agent Client Protocol")
  .version("0.0.1")
  .option("--roster <file>", "roster file (default: .room.toml, then ~/.config/room/roster.toml)");

program
  .command("roster")
  .description("Print the effective roster")
  .option("--json", "machine-readable output")
  .action((opts: { json?: boolean }) => {
    const roster = withConfig(() => loadRoster(program.opts().roster));
    if (opts.json) {
      console.log(JSON.stringify(roster, null, 2));
      return;
    }
    console.log(`# ${roster.source}`);
    for (const s of roster.seats) {
      console.log(`${s.name.padEnd(8)} ${s.adapter}  ${[s.command, ...(s.args ?? [])].join(" ")}`);
    }
  });

program
  .command("doctor [seats...]")
  .description("Start each seat, complete the ACP handshake, and report")
  .option("--json", "machine-readable output")
  .option("--deep", "also open a session and prove the permission round trip")
  .option("--timeout <seconds>", "handshake timeout", "90")
  .option("--turn-timeout <seconds>", "per-turn timeout in deep mode", "180")
  .option("--keep-scratch", "keep the scratch directories from deep mode")
  .action(
    async (
      names: string[],
      opts: { json?: boolean; deep?: boolean; timeout: string; turnTimeout: string; keepScratch?: boolean },
    ) => {
      const roster = withConfig(() => loadRoster(program.opts().roster));
      const seats = withConfig(() => pickSeats(roster, names));
      const report = await runDoctor(seats, {
        deep: Boolean(opts.deep),
        timeoutMs: Number(opts.timeout) * 1000,
        promptTimeoutMs: Number(opts.turnTimeout) * 1000,
        keepScratch: opts.keepScratch,
        log: opts.json ? undefined : (line) => console.error(line),
      });
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(renderRows(report.rows, Boolean(opts.deep)));
      }
      process.exitCode = report.code;
    },
  );

program
  .command("spike <seat> [prompt...]")
  .description("Open one seat, send one prompt, stream its events, answer permissions by hand")
  .option("--cwd <dir>", "session working directory", process.cwd())
  .action(async (name: string, words: string[], opts: { cwd: string }) => {
    const roster = withConfig(() => loadRoster(program.opts().roster));
    const [config] = withConfig(() => pickSeats(roster, [name]));
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    const seat = new AcpSeat(config, (req) => askHuman(rl, req));
    const prompt = words.length ? words.join(" ") : "Say hello and list the files in the current directory.";
    try {
      const info = await seat.start();
      console.error(`[${name}] ${info.agentName ?? "?"} ${info.agentVersion ?? ""} loadSession=${info.loadSession}`);
      const sid = await seat.newSession(opts.cwd);
      console.error(`[${name}] session ${sid} in ${opts.cwd}`);
      for await (const ev of seat.prompt(prompt)) {
        switch (ev.type) {
          case "text":
            process.stdout.write(ev.text);
            break;
          case "thought":
            break;
          case "tool_call":
            console.error(`\n[${name}] tool: ${ev.title} (${ev.kind ?? "?"}, ${ev.status ?? "?"})`);
            break;
          case "tool_update":
            if (ev.status) console.error(`[${name}] tool ${ev.id}: ${ev.status}`);
            break;
          case "stop":
            process.stdout.write("\n");
            console.error(`[${name}] stop: ${ev.stopReason}`);
            break;
          default:
            console.error(`[${name}] ${ev.update}`);
        }
      }
    } finally {
      rl.close();
      await seat.stop();
    }
  });

interface StartOptions {
  cwd: string;
  human: string;
  roomFile?: string;
  git: boolean;
  desks: boolean;
  parallel?: boolean;
  auto?: boolean;
  tui?: boolean;
  role?: string[];
  wake?: string;
  cap?: string;
  turnTimeout: string;
}

function roomOptions(cmd: Command): Command {
  return cmd
    .option("--cwd <dir>", "working directory the seats share", process.cwd())
    .option("--human <name>", "your name in the transcript", "Corina")
    .option("--room-file <file>", "TOML with seats, modes, roles, and policy")
    .option("--no-git", "do not branch or commit per turn")
    .option("--no-desks", "seats share one working directory instead of a worktree each")
    .option("--parallel", "start in parallel discussion mode")
    .option("--auto", "tool calls run without asking you, except deny and ask rules")
    .option("--wake <who>", "who an untagged message wakes: last (whoever spoke last) or all")
    .option("--cap <n>", "seat-to-seat wakes per thread before the room pauses it (a number, or off)")
    .option("--tui", "full-screen terminal UI: live seat boxes, a status bar, and the input always open")
    .option("--role <seat=role...>", "give seats roles from the web app's presets, e.g. --role grok=critic claude=implementer")
    .option("--turn-timeout <seconds>", "per-turn timeout", "600");
}

function wakeOpt(v: string | undefined): "last" | "all" | undefined {
  if (v === undefined || v === "last" || v === "all") return v;
  return withConfig(() => {
    throw new ConfigError(`--wake takes last or all (got "${v}")`);
  });
}

function capOpt(v: string | undefined): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === "off") return null;
  if (/^\d+$/.test(v)) return Number(v);
  return withConfig(() => {
    throw new ConfigError(`--cap takes a number or off (got "${v}")`);
  });
}

/** `--role grok=critic`: the named seats' roles, over the roster's and the room file's. */
function withRoles(seats: SeatConfig[], roles: string[] | undefined): SeatConfig[] {
  const set = new Map<string, string>();
  for (const r of roles ?? []) {
    const [seat, role] = r.split("=");
    if (!seat || !role) withConfig(() => { throw new ConfigError(`--role takes seat=role, e.g. grok=critic (got "${r}")`); });
    if (!seats.some((s) => s.name === seat)) withConfig(() => { throw new ConfigError(`--role: no seat "${seat}" in this room`); });
    withConfig(() => {
      try {
        rolePrompt(role, seat);
      } catch (err) {
        throw new ConfigError(`--role: ${(err as Error).message}`);
      }
    });
    set.set(seat, role);
  }
  return seats.map((s) => (set.has(s.name) ? { ...s, role: set.get(s.name) } : s));
}

/** Seats named on the command line, else the room file's, with the room file's overrides applied. */
function lineup(names: string[], roomFile: string | undefined, fallback: string[] = []): SeatConfig[] {
  const roster = withConfig(() => loadRoster(program.opts().roster));
  const file = roomFile ? withConfig(() => loadRoomFile(roomFile)) : undefined;
  const wanted = names.length ? names : file?.seats?.length ? file.seats : fallback;
  if (wanted.length === 0) {
    console.error(`room: name the seats to open, e.g. room start claude grok (roster has: ${roster.seats.map((s) => s.name).join(", ")})`);
    process.exit(EXIT.CONFIG);
  }
  const seats = withConfig(() => pickSeats(roster, wanted));
  return file ? applyRoomFile(seats, file) : seats;
}

async function runRoom(name: string, lineupSeats: SeatConfig[], opts: StartOptions): Promise<void> {
  const cwd = resolve(opts.cwd);
  const seats = withRoles(lineupSeats, opts.role);
  if (opts.tui) {
    const store = new TuiStore();
    const room = await Room.open({
      name,
      cwd,
      seats,
      human: opts.human,
      ui: new TuiUI(store),
      git: opts.git ? undefined : false,
      desks: opts.desks,
      auto: opts.auto,
      wake: wakeOpt(opts.wake),
      cap: capOpt(opts.cap),
      mode: opts.parallel ? "parallel" : undefined,
      turnTimeoutMs: Number(opts.turnTimeout) * 1000,
    });
    store.status(`room "${name}" with ${seats.map((s) => s.name).join(", ")} in ${cwd}. /help for commands, Ctrl+C to cancel a round.`);
    try {
      await runTui(room, store, room.start());
    } finally {
      await room.stop();
    }
    return;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const lines = new LineSource(rl);
  const ui = new ReplUI(lines);
  const room = await Room.open({
    name,
    cwd,
    seats,
    human: opts.human,
    ui,
    git: opts.git ? undefined : false,
    desks: opts.desks,
    auto: opts.auto,
    wake: wakeOpt(opts.wake),
    cap: capOpt(opts.cap),
    mode: opts.parallel ? "parallel" : undefined,
    turnTimeoutMs: Number(opts.turnTimeout) * 1000,
  });
  ui.status(`starting ${seats.map((s) => s.name).join(", ")} in ${cwd}`);
  try {
    await room.start();
    await runRepl(room, lines, ui);
  } finally {
    rl.close();
    await room.stop();
  }
}

roomOptions(
  program
    .command("start [seats...]")
    .description("Open a room with the named seats (nothing joins by default) and talk in a REPL")
    .option("--name <name>", "room name (default: main, or main-2, main-3, ... if taken); state lives in .room/<name>/"),
).action(async (names: string[], opts: StartOptions & { name?: string }) => {
  const cwd = resolve(opts.cwd);
  if (opts.name && Room.exists(cwd, opts.name)) {
    console.error(`room: a room named "${opts.name}" exists here; continue it with: room resume ${opts.name}`);
    process.exit(EXIT.CONFIG);
  }
  const name = opts.name ?? Room.freshName(cwd);
  const seats = lineup(names, opts.roomFile);
  if (!opts.name && name !== "main") console.error(`room: opening a new room, "${name}" (room resume <name> continues an old one)`);
  await runRoom(name, seats, opts);
});

roomOptions(
  program
    .command("resume <name> [seats...]")
    .description("Reopen a saved room: seats reattach to their sessions, or catch up from the transcript"),
).action(async (name: string, names: string[], opts: StartOptions) => {
  const cwd = resolve(opts.cwd);
  if (!Room.exists(cwd, name)) {
    console.error(`room: no saved room "${name}" in ${cwd} (looked for .room/${name}/state.json)`);
    process.exit(EXIT.CONFIG);
  }
  await runRoom(name, lineup(names, opts.roomFile, Room.savedSeats(cwd, name)), opts);
});

program
  .command("acp [seats...]")
  .description("Serve the room as an ACP agent on stdio, for an editor (Zed, VS Code); each editor session is a room")
  .option("--human <name>", "your name in the transcript", "Corina")
  .option("--room-file <file>", "TOML with seats, modes, roles, and policy")
  .option("--no-git", "do not branch or commit per turn")
  .option("--no-desks", "seats share one working directory instead of a worktree each")
  .option("--parallel", "new rooms start in parallel discussion mode")
  .option("--auto", "new rooms start in auto mode: tool calls run without asking, except deny and ask rules")
  .option("--wake <who>", "who an untagged message wakes in new rooms: last or all")
  .option("--cap <n>", "seat-to-seat wakes per thread in new rooms (a number, or off)")
  .option("--turn-timeout <seconds>", "per-turn timeout", "600")
  .action((names: string[], opts: Omit<StartOptions, "cwd">) => {
    // stdout is the wire; anything else printed there corrupts it.
    console.log = console.info = console.debug = console.warn = (...a: unknown[]) => console.error(...a);
    const seats = lineup(names, opts.roomFile);
    const stream = acp.ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    );
    const server = serveAcp(stream, {
      seats,
      human: opts.human,
      git: opts.git ? undefined : false,
      desks: opts.desks,
      auto: opts.auto,
      wake: wakeOpt(opts.wake),
      cap: capOpt(opts.cap),
      mode: opts.parallel ? "parallel" : undefined,
      turnTimeoutMs: Number(opts.turnTimeout) * 1000,
      log: (line) => console.error(`room: ${line}`),
    });
    console.error(`room: serving ACP with seats ${seats.map((s) => s.name).join(", ")}`);
    const shutdown = () => void server.stop().finally(() => process.exit(0));
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    void server.connection.closed.then(() => server.stop()).finally(() => process.exit(0));
  });

async function askHuman(rl: readline.Interface, req: PermissionRequestView): Promise<string | "cancel"> {
  console.error(`\n[${req.seat}] wants: ${req.title} (${req.kind ?? "tool"})`);
  req.options.forEach((o, i) => console.error(`  ${i + 1}. ${o.name} [${o.kind}]`));
  for (;;) {
    const a = (await rl.question("  choose (number, or c to cancel): ")).trim();
    if (a === "c") return "cancel";
    const i = Number(a) - 1;
    if (Number.isInteger(i) && req.options[i]) return req.options[i].optionId;
  }
}

function renderRows(rows: DoctorRow[], deep: boolean): string {
  const head = ["seat", "start", "agent", "load", "auth", ...(deep ? ["perms", "asked", "allow→file", "deny→file"] : []), "ms", "note"];
  const body = rows.map((r) => [
    r.seat,
    r.started ? "ok" : "FAIL",
    r.agent ? `${r.agent}${r.version ? " " + r.version : ""}` : "-",
    r.loadSession === undefined ? "-" : r.loadSession ? "yes" : "no",
    r.auth,
    ...(deep
      ? [
          r.deep?.forwarding ?? "-",
          r.deep?.allow ? String(r.deep.allow.askedFor.length) : "-",
          r.deep?.allow ? (r.deep.allow.created ? "yes" : "no") : "-",
          r.deep?.deny ? (r.deep.deny.created ? "yes" : "no") : "-",
        ]
      : []),
    String(r.ms),
    r.hint ?? r.error ?? r.deep?.allow?.error ?? r.deep?.deny?.error ?? "",
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(head), line(widths.map((w) => "-".repeat(w))), ...body.map(line)].join("\n");
}

function withConfig<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`room: ${err.message}`);
      process.exit(EXIT.CONFIG);
    }
    throw err;
  }
}

program.parseAsync(process.argv).catch((err) => {
  console.error(`room: ${(err as Error).stack ?? err}`);
  process.exit(EXIT.PROTOCOL);
});
