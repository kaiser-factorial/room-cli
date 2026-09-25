/**
 * Phase 0 spike: do two seats of the same harness get separate sessions?
 * Each seat is told a different secret word, then asked for it.
 *
 *   npx tsx scripts/two-seats.ts grok
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoster, pickSeats } from "../src/config.js";
import { AcpSeat } from "../src/seat/acp.js";

const name = process.argv[2] ?? "grok";
const [config] = pickSeats(loadRoster(process.argv[3]), [name]);
const words = ["pelican", "marmalade"];

async function collect(seat: AcpSeat, prompt: string): Promise<string> {
  let text = "";
  for await (const ev of seat.prompt(prompt)) if (ev.type === "text") text += ev.text;
  return text.trim();
}

const seats = words.map(() => new AcpSeat(config, async () => "cancel"));
await Promise.all(seats.map((s) => s.start()));
const sids = await Promise.all(seats.map((s) => s.newSession(mkdtempSync(join(tmpdir(), "room-two-")))));
console.log("sessions:", sids);
const first = await Promise.all(
  seats.map((s, i) => collect(s, `Remember this secret word for later: ${words[i]}. Reply with exactly: ok`)),
);
console.log("first replies:", first);
const answers = await Promise.all(
  seats.map((s) => collect(s, "What was the secret word I gave you? Reply with the word only.")),
);
console.log("expected:", words);
console.log("answers: ", answers);
const ok = answers.every((a, i) => a.toLowerCase().includes(words[i]));
console.log(ok ? "SEPARATE SESSIONS: ok" : "SEPARATE SESSIONS: FAILED");
await Promise.all(seats.map((s) => s.stop()));
process.exit(ok ? 0 : 1);
