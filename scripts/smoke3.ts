/**
 * Phase 3 live check: a hand-off between seats, then a parallel round.
 *
 *   npx tsx scripts/smoke3.ts claude hermes grok
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoster, pickSeats } from "../src/config.js";
import { Room, type RoomUI } from "../src/room.js";

const names = process.argv.slice(2);
if (names.length < 2) {
  console.error("usage: smoke3.ts <seat> <seat> [more...]");
  process.exit(10);
}
const seats = pickSeats(loadRoster(), names);
const [first, second] = names;

const cwd = mkdtempSync(join(tmpdir(), "room-smoke3-"));
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=s", "-c", "user.email=s@r", ...a], { cwd, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
writeFileSync(join(cwd, "hello.py"), `def greet(names):\n    out = []\n    for i in range(len(names)):\n        out.append("Hello, " + names[i] + "!")\n    return out\n`);
git("add", "hello.py");
git("commit", "-q", "-m", "seed");

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let speaker: string | undefined;
const asked: string[] = [];
const ui: RoomUI = {
  seatEvent(seat, ev) {
    if (ev.type === "text") {
      if (speaker !== seat) {
        process.stdout.write(`\n${seat}> `);
        speaker = seat;
      }
      process.stdout.write(ev.text);
    } else if (ev.type === "tool_call") {
      process.stdout.write(`\n  · ${seat}: ${ev.title}`);
      speaker = undefined;
    } else if (ev.type === "stop") {
      process.stdout.write("\n");
      speaker = undefined;
    }
  },
  async askHuman(req) {
    asked.push(`${req.seat}: ${req.title}`);
    process.stdout.write(`\n  ? ${req.seat} asks: ${req.title} -> allow\n`);
    speaker = undefined;
    return "allow";
  },
  status(line) {
    process.stdout.write(`\n  [room ${stamp()}] ${line}\n`);
    speaker = undefined;
  },
};

const room = await Room.open({ name: "smoke3", cwd, seats, human: "Corina", ui, turnTimeoutMs: 6 * 60_000 });
await room.start();

console.log("\n=== 1. hand-off: the first seat must address the second by @name");
await room.say(
  `@${first} read hello.py, then ask @${second} one specific question about it. Address them as @${second} so the room hands them the turn. Do not edit.`,
);

console.log("\n=== 2. parallel round: everyone answers at once; edits are refused");
room.setRoomMode("parallel");
await room.say("Everyone: in one sentence, what single change would you make to hello.py? Do not make it, just say it.");

console.log("\n=== 3. empty continue in parallel mode");
await room.continueRound();

await room.stop();
console.log("\n=== transcript");
for (const e of room.transcript.entries) console.log(`${String(e.id).padStart(2)} ${e.from.padEnd(7)} ${e.kind.padEnd(7)} ${e.text.replace(/\s+/g, " ").slice(0, 150)}`);
console.log(`\nhuman was asked ${asked.length} time(s) in total`);
console.log(`scratch: ${cwd}`);
