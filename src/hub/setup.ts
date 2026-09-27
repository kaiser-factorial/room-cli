/**
 * `room setup claude`: register `room mcp` with Claude Code (user scope) and
 * add the room's hooks to ~/.claude/settings.json. Idempotent; the settings
 * file is backed up before it is changed, and nothing else in it is touched.
 */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);

/** The node commands for the MCP server and the hook, by absolute path so PATH does not matter. */
export function entryPoints(): { mcp: string[]; hook: string[] } {
  const js = (f: string) => fileURLToPath(new URL(`./${f}`, import.meta.url)).replace(/\.ts$/, ".js");
  return { mcp: [process.execPath, js("join.js")], hook: [process.execPath, js("hook.js")] };
}

const quote = (a: string) => (/^[\w./:@-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

const EVENTS: Array<[string, string, string | undefined]> = [
  ["PostToolUse", "post-tool", "*"],
  ["UserPromptSubmit", "prompt", undefined],
  ["Stop", "stop", undefined],
];

type HookEntry = { matcher?: string; hooks: Array<{ type: string; command: string; timeout?: number }> };

/** Settings with the room's hooks in place of any earlier ones of the room's. */
export function withRoomHooks(settings: Record<string, unknown>, hook: string[]): Record<string, unknown> {
  const hooks = { ...((settings.hooks as Record<string, HookEntry[]> | undefined) ?? {}) };
  for (const [event, arg, matcher] of EVENTS) {
    const command = [...hook, arg].map(quote).join(" ");
    const kept = (hooks[event] ?? [])
      .map((e) => ({ ...e, hooks: e.hooks.filter((h) => !/hub[/\\]hook\.js['"]? /.test(h.command)) }))
      .filter((e) => e.hooks.length);
    hooks[event] = [...kept, { ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command, timeout: 5 }] }];
  }
  return { ...settings, hooks };
}

export async function setupClaude(o: { home?: string; dryRun?: boolean; log?: (l: string) => void } = {}): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const { mcp, hook } = entryPoints();
  const add = ["mcp", "add", "--scope", "user", "room", "--", ...mcp];
  if (o.dryRun) log(`would run: claude ${add.map(quote).join(" ")}`);
  else {
    await run("claude", ["mcp", "remove", "--scope", "user", "room"]).catch(() => undefined);
    await run("claude", add).then(
      () => log("registered the room MCP server with Claude Code (user scope)"),
      (err: Error) => log(`could not run claude (${err.message.split("\n")[0]}); run it yourself:\n  claude ${add.map(quote).join(" ")}`),
    );
  }
  const file = join(o.home ?? homedir(), ".claude", "settings.json");
  const current = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
  const next = withRoomHooks(current, hook);
  if (o.dryRun) {
    log(`would write hooks to ${file}:\n${JSON.stringify(next.hooks, null, 2)}`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) copyFileSync(file, `${file}.room-backup`);
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  log(`added the room's hooks to ${file}${existsSync(`${file}.room-backup`) ? ` (backup: ${file}.room-backup)` : ""}`);
  log("Restart your Claude Code sessions to pick them up. Then: `room host <name>` here, and ask a session to join it.");
}

/**
 * `room setup grok|codex|hermes`: register `room mcp` with that harness's own
 * `mcp add`. No hooks yet: their sessions see "(n unread)" on their room
 * tool results rather than a ping. When the harness's CLI is not found or
 * refuses, the command to run by hand is printed instead.
 */
export async function setupMcpOnly(harness: string, o: { dryRun?: boolean; log?: (l: string) => void } = {}): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const { mcp } = entryPoints();
  const add = [harness, "mcp", "add", "room", "--", ...mcp];
  const line = add.map(quote).join(" ");
  if (o.dryRun) return log(`would run: ${line}`);
  await run(add[0], add.slice(1)).then(
    () => log(`registered the room MCP server with ${harness}`),
    (err: Error) => log(`could not register it (${err.message.split("\n")[0]}). Register this stdio MCP server with ${harness} yourself:\n  ${line}`),
  );
  log(`${harness} has no room hooks yet: its sessions see "(n unread)" on room tool results, not a ping. Restart its sessions to pick up the server.`);
}
