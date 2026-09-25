/**
 * Phase 1 acceptance run, scripted so it is repeatable:
 * a scratch git repo with a buggy file, one discussion round with every
 * seat, then one seat is asked to fix it. Permission requests are logged
 * and answered allow. Ends by printing the transcript and git log.
 *
 *   npx tsx scripts/smoke.ts claude hermes grok pool --editor grok
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoster, pickSeats } from "../src/config.js";
import { Room, type RoomUI } from "../src/room.js";

const args = process.argv.slice(2);
const editorIdx = args.indexOf("--editor");
const editor = editorIdx >= 0 ? args[editorIdx + 1] : undefined;
const names = args.filter((a, i) => a !== "--editor" && i !== editorIdx + 1);
if (names.length === 0) {
  console.error("usage: smoke.ts <seat...> [--editor <seat>]");
  process.exit(10);
}
const seats = pickSeats(loadRoster(), names);
const fixer = editor ?? names[names.length - 1];

const cwd = mkdtempSync(join(tmpdir(), "room-smoke-"));
const git = (...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
git("init", "-q", "-b", "main");
writeFileSync(
  join(cwd, "hello.py"),
  `def greet(names):\n    """Return a greeting for each name."""\n    out = []\n    for i in range(len(names)):\n        out.append("Hello, " + names[i + 1] + "!")\n    return out\n\n\nif __name__ == "__main__":\n    print(greet(["Ada", "Grace"]))\n`,
);
git("-c", "user.name=smoke", "-c", "user.email=smoke@room", "add", "hello.py");
git("-c", "user.name=smoke", "-c", "user.email=smoke@room", "commit", "-q", "-m", "seed");

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let speaker: string | undefined;
const ui: RoomUI = {
  seatEvent(seat, ev) {
    if (ev.type === "text") {
      if (speaker !== seat) {
        process.stdout.write(`\n${seat}> `);
        speaker = seat;
      }
      process.stdout.write(ev.text);
    } else if (ev.type === "tool_call") {
      process.stdout.write(`\n  · ${seat}: ${ev.title} [${ev.kind ?? "?"}]`);
      speaker = undefined;
    } else if (ev.type === "stop") {
      process.stdout.write("\n");
      speaker = undefined;
    }
  },
  async askHuman(req) {
    process.stdout.write(`\n  ? ${req.seat} asks: ${req.title} [${req.kind ?? "?"}] -> allow (${stamp()})\n`);
    speaker = undefined;
    return "allow";
  },
  status(line) {
    process.stdout.write(`\n  [room ${stamp()}] ${line}\n`);
    speaker = undefined;
  },
};

const room = await Room.open({ name: "smoke", cwd, seats, human: "Corina", ui, turnTimeoutMs: 8 * 60_000 });
await room.start();
await room.say(
  "Everyone: read hello.py and say in one or two sentences what is wrong with it. Do not edit anything yet.",
);
await room.say(`@${fixer} fix the bug in hello.py with the smallest possible change, then say what you changed.`);
await room.continueRound(names.filter((n) => n !== fixer).slice(0, 1));
await room.stop();

console.log("\n=== transcript");
for (const e of room.transcript.entries) console.log(`${String(e.id).padStart(2)} ${e.from.padEnd(7)} ${e.kind.padEnd(7)} ${e.text.replace(/\s+/g, " ").slice(0, 140)}`);
console.log("\n=== git log");
console.log(git("log", "--format=%h %an  %s", "--", "."));
console.log("\n=== hello.py");
console.log(execFileSync("cat", ["hello.py"], { cwd, encoding: "utf8" }));
console.log(`scratch: ${cwd}`);
