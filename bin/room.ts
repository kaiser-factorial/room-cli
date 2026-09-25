#!/usr/bin/env node
/**
 * room: a terminal room for one human and several coding agents.
 *
 * Phase 0 commands: `doctor`, `roster`, `spike`.
 */
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import readline from "node:readline/promises";
import { Command } from "commander";
import { applyRoomFile, ConfigError, loadRoomFile, loadRoster, pickSeats } from "../src/config.js";
import { runDoctor, type DoctorRow } from "../src/doctor.js";
import { EXIT } from "../src/exit-codes.js";
import { Room } from "../src/room.js";
import { AcpSeat } from "../src/seat/acp.js";
import type { PermissionRequestView } from "../src/seat/types.js";
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

program
  .command("start [seats...]")
  .description("Open a room with the named seats (nothing joins by default) and talk in a REPL")
  .option("--name <name>", "room name; transcript lives in .room/<name>/", "main")
  .option("--cwd <dir>", "working directory the seats share", process.cwd())
  .option("--human <name>", "your name in the transcript", "Corina")
  .option("--room-file <file>", "TOML with seats, modes, roles, and policy")
  .option("--no-git", "do not branch or commit per turn")
  .option("--turn-timeout <seconds>", "per-turn timeout", "600")
  .action(
    async (
      names: string[],
      opts: { name: string; cwd: string; human: string; roomFile?: string; git: boolean; turnTimeout: string },
    ) => {
      const roster = withConfig(() => loadRoster(program.opts().roster));
      const file = opts.roomFile ? withConfig(() => loadRoomFile(opts.roomFile!)) : undefined;
      const wanted = names.length ? names : (file?.seats ?? []);
      if (wanted.length === 0) {
        console.error(`room: name the seats to open, e.g. room start claude grok (roster has: ${roster.seats.map((s) => s.name).join(", ")})`);
        process.exit(EXIT.CONFIG);
      }
      let seats = withConfig(() => pickSeats(roster, wanted));
      if (file) seats = applyRoomFile(seats, file);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const lines = new LineSource(rl);
      const ui = new ReplUI(lines);
      const room = await Room.open({
        name: opts.name,
        cwd: resolve(opts.cwd),
        seats,
        human: opts.human,
        ui,
        git: opts.git ? undefined : false,
        turnTimeoutMs: Number(opts.turnTimeout) * 1000,
      });
      ui.status(`starting ${seats.map((s) => s.name).join(", ")} in ${resolve(opts.cwd)}`);
      try {
        await room.start();
        await runRepl(room, lines, ui);
      } finally {
        rl.close();
        await room.stop();
      }
    },
  );

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
