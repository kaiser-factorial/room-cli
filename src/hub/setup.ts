/**
 * `room setup claude`: register `room mcp` with Claude Code (user scope) and
 * add the room's hooks to ~/.claude/settings.json. Idempotent; the settings
 * file is backed up before it is changed, and nothing else in it is touched.
 */
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  writeSkill(join(o.home ?? homedir(), ".claude", "skills", "room"), log);
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

/** A `[mcp_servers.room]` table in a Grok or Codex config.toml, replacing an earlier one and leaving the rest of the file as it was. */
export function withRoomTable(toml: string, command: string[]): string {
  const table = [`[mcp_servers.room]`, `command = ${JSON.stringify(command[0])}`, `args = [${command.slice(1).map((a) => JSON.stringify(a)).join(", ")}]`].join("\n");
  const re = /^\[mcp_servers\.room\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/m;
  if (re.test(toml)) return toml.replace(re, `${table}\n\n`).replace(/\n{3,}/g, "\n\n");
  return `${toml.replace(/\s*$/, "")}${toml.trim() ? "\n\n" : ""}${table}\n`;
}

/**
 * `room setup grok`: the server as a table in GROK_HOME/config.toml (user
 * config needs no folder trust), and the ping hooks as GROK_HOME/hooks/room.json:
 * Grok's hooks are Claude's (PostToolUse additionalContext reaches the model;
 * Stop's decision: block holds the turn; stdin is camelCase). Grok also runs
 * ~/.claude/settings.json hooks, so when room setup claude put them there,
 * no second copy is written.
 */
export async function setupGrok(o: { grokHome?: string; claudeHome?: string; dryRun?: boolean; log?: (l: string) => void } = {}): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const home = o.grokHome ?? process.env.GROK_HOME ?? join(homedir(), ".grok");
  const { mcp, hook } = entryPoints();
  const config = join(home, "config.toml");
  const current = existsSync(config) ? readFileSync(config, "utf8") : "";
  const next = withRoomTable(current, mcp);
  const hooksFile = join(home, "hooks", "room.json");
  // Grok never adds UserPromptSubmit output to context, so only the two that work.
  const all = withRoomHooks({}, hook).hooks as Record<string, unknown>;
  const hooks = { hooks: { PostToolUse: all.PostToolUse, Stop: all.Stop } };
  // Grok also runs the hooks in ~/.claude/settings.json (by default): if room setup claude put them there, a second copy only doubles the work.
  const claudeSettings = join(o.claudeHome ?? homedir(), ".claude", "settings.json");
  const viaClaude = existsSync(claudeSettings) && /hub[/\\]hook\.js/.test(readFileSync(claudeSettings, "utf8"));
  if (o.dryRun) {
    log(`would write to ${config}:\n${next}`);
    log(`would write ${hooksFile}:\n${JSON.stringify(hooks, null, 2)}`);
    return;
  }
  mkdirSync(join(home, "hooks"), { recursive: true });
  if (existsSync(config)) copyFileSync(config, `${config}.room-backup`);
  writeFileSync(config, next);
  log(`added [mcp_servers.room] to ${config}${existsSync(`${config}.room-backup`) ? ` (backup: ${config}.room-backup)` : ""}`);
  if (viaClaude) {
    rmSync(hooksFile, { force: true });
    log(`hooks: Grok already runs the room's hooks from ${claudeSettings} (Claude compatibility), so none were added (to use Grok's own, set [compat.claude] hooks = false and run this again)`);
  } else {
    writeFileSync(hooksFile, JSON.stringify(hooks, null, 2) + "\n");
    log(`wrote the room's hooks to ${hooksFile}`);
  }
  writeSkill(join(home, "skills", "room"), log);
  log("Restart Grok sessions to pick them up; `grok inspect` should list both.");
}

/** The room skill every harness can load: what the room is and how to behave in it. */
export const ROOM_SKILL = `---
name: room
description: Talk with the human and other agents' sessions in a hosted room (room host), then go back to your own work. Use when asked to join a room, or when a note says the room has new messages.
---

# The room

A room is a conversation between the human and several agent sessions, each
working somewhere else. You join it with the room MCP server's tools
(rooms, join, post, inbox, wait, who, leave) and keep your own context and
work; nothing of yours is shared except what you post.

- Join with a short name, usually your harness (claude, grok, antigravity).
- Post what others need: status, findings, decisions, a question. Not your
  whole context, not a log of every step.
- Tag someone with @name to ask them directly; @all for everyone.
- After posting a question, go back to your work. A note tells you when
  something new arrives; read it with inbox at a good stopping point.
- Use wait only when you truly cannot go on without an answer.
- Leave when the discussion is done, and carry on where you were.
`;

/**
 * `room setup antigravity`: one plugin in ~/.gemini/config/plugins/room with
 * the MCP server (mcp_config.json), the ping hooks (hooks.json:
 * PreInvocation for the note, Stop to hold a turn once), and the room skill.
 * Antigravity enables plugins it finds there by default.
 */
export async function setupAntigravity(o: { home?: string; dryRun?: boolean; log?: (l: string) => void } = {}): Promise<void> {
  const log = o.log ?? ((l: string) => console.log(l));
  const dir = join(o.home ?? homedir(), ".gemini", "config", "plugins", "room");
  const { mcp, hook } = entryPoints();
  const cmd = (arg: string) => ({ type: "command", command: [...hook, arg].map(quote).join(" "), timeout: 5 });
  const files: Record<string, string> = {
    "plugin.json": JSON.stringify({ name: "room", version: "0.0.1", description: "Join a hosted room to talk with the human and other agents' sessions" }, null, 2),
    "mcp_config.json": JSON.stringify({ mcpServers: { room: { command: mcp[0], args: mcp.slice(1) } } }, null, 2),
    "hooks.json": JSON.stringify({ room: { PreInvocation: [cmd("invocation")], Stop: [cmd("stop")] } }, null, 2),
    "skills/room/SKILL.md": ROOM_SKILL,
  };
  if (o.dryRun) {
    for (const [f, text] of Object.entries(files)) log(`would write ${join(dir, f)}:\n${text}`);
    return;
  }
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text.endsWith("\n") ? text : text + "\n");
  }
  log(`wrote the room plugin to ${dir} (MCP server, hooks, and a room skill)`);
  log("Restart Antigravity; the server should show under ... > MCP Servers.");
  log("Not yet confirmed: the output shape PreInvocation and Stop hooks use. Start Antigravity with ROOM_HOOK_LOG=/tmp/room-hook.log to see each run.");
}

function writeSkill(dir: string, log: (l: string) => void): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), ROOM_SKILL);
  log(`wrote the room skill to ${join(dir, "SKILL.md")}`);
}
