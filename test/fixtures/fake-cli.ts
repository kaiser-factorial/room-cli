/**
 * A fake CLI harness in Claude Code's headless shape:
 *   fake-claude -p --output-format json [--permission-mode m] [--resume <id>] <prompt>
 * Prints {"result", "session_id", "is_error"} and keeps per-session memory in
 * FAKE_CLI_STATE so resume can be tested. Understands `>> remember`, `>> recall`,
 * `>> say`, `>> edit <path> <text>` (always writes; a CLI turn cannot ask).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const argv = process.argv.slice(2);
const stateDir = process.env.FAKE_CLI_STATE ?? join(tmpdir(), "fake-cli-state");
mkdirSync(stateDir, { recursive: true });

const resumeIdx = argv.indexOf("--resume");
const sessionId = resumeIdx >= 0 ? argv[resumeIdx + 1] : `cli-${Math.random().toString(36).slice(2, 10)}`;
const prompt = argv[argv.length - 1] ?? "";
const statePath = join(stateDir, `${sessionId}.json`);
const state: { memory?: string; turns: number } = existsSync(statePath)
  ? (JSON.parse(readFileSync(statePath, "utf8")) as { memory?: string; turns: number })
  : { turns: 0 };

if (resumeIdx >= 0 && !existsSync(statePath)) {
  console.log(JSON.stringify({ result: `no session ${sessionId}`, session_id: sessionId, is_error: true }));
  process.exit(1);
}

const out: string[] = [];
const directives = [...prompt.matchAll(/^(?:\[[^\]\n]+\]: )?>> (\w+)(?: (.*))?$/gm)].map((m) => ({ verb: m[1], arg: m[2] ?? "" }));
if (directives.length === 0) directives.push({ verb: "say", arg: "ok" });
for (const d of directives) {
  switch (d.verb) {
    case "say":
      out.push(d.arg);
      break;
    case "remember":
      state.memory = d.arg;
      out.push("remembered");
      break;
    case "recall":
      out.push(state.memory ?? "nothing");
      break;
    case "edit": {
      const [rel, ...rest] = d.arg.split(" ");
      writeFileSync(resolve(process.cwd(), rel), rest.join(" ") + "\n");
      out.push(`edited ${rel}`);
      break;
    }
    default:
      out.push(`unknown directive ${d.verb}`);
  }
}
state.turns += 1;
writeFileSync(statePath, JSON.stringify(state));
console.log(JSON.stringify({ result: out.join(" "), session_id: sessionId, is_error: false, num_turns: state.turns }));
