/**
 * `room hook <event>`: a Claude Code hook that tells a session, without
 * interrupting it, that its room has something new. It runs on every tool
 * call, so it is quick and quiet: no room joined, nothing new, or anything
 * going wrong, and it prints nothing.
 *
 * - post-tool (PostToolUse): a one-line note beside the tool result, once per new message.
 * - prompt (UserPromptSubmit): the same note beside your next prompt.
 * - stop (Stop): a turn about to end with a message that tags this session
 *   unread is held once, so the session can answer before it goes idle.
 */
import { readFileSync } from "node:fs";
import { ancestors, callHub, memberships, procInfo, saveMembership, type Membership, type ProcInfo } from "./client.js";
import type { Peek } from "./hub.js";

export type HookEvent = "post-tool" | "prompt" | "stop";

export interface HookDeps {
  env?: NodeJS.ProcessEnv;
  self?: number;
  info?: ProcInfo;
  peek?: (m: Membership) => Promise<Peek>;
}

/** Which room this hook's session is in: the membership whose harness is among the hook's ancestors. */
export function findMembership(o: HookDeps = {}): Membership | undefined {
  const all = memberships(o.env);
  if (!all.length) return undefined;
  const chain = ancestors(o.self ?? process.pid, o.info ?? procInfo);
  for (const pid of chain) {
    const m = all.find((x) => x.harnessPid === pid);
    if (m) return m;
  }
  return undefined;
}

/** The hook's stdout for one event, or "" for nothing to say. */
export async function hookOutput(event: HookEvent, input: { stop_hook_active?: boolean }, o: HookDeps = {}): Promise<string> {
  const m = findMembership(o);
  if (!m) return "";
  const peek = await (o.peek ?? ((x: Membership) => callHub<Peek>(x, "peek", { token: x.token }, 1500)))(m);
  if (!peek.unread) return "";
  const who = peek.from.join(", ");
  const note =
    `[room ${m.room}] ${peek.unread} new message${peek.unread === 1 ? "" : "s"} from ${who}` +
    `${peek.addressed ? ` (${peek.addressed} tagging you, @${m.name})` : ""}. Latest: ${peek.preview}. ` +
    `Read them with the room inbox tool when you reach a good stopping point; no need to drop what you are doing.`;
  if (event === "stop") {
    // Only for a message that asks this session something, once per message, and never twice in a row.
    if (!peek.addressed || input.stop_hook_active || (m.held ?? 0) >= peek.lastId) return "";
    saveMembership({ ...m, held: peek.lastId, pinged: peek.lastId }, o.env);
    return JSON.stringify({
      decision: "block",
      reason: `${note.replace(" when you reach a good stopping point; no need to drop what you are doing.", ".")} Answer in the room (post) before you finish, or say there that you will get to it later.`,
    });
  }
  if ((m.pinged ?? 0) >= peek.lastId) return "";
  saveMembership({ ...m, pinged: peek.lastId }, o.env);
  const hookEventName = event === "prompt" ? "UserPromptSubmit" : "PostToolUse";
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: note } });
}

export async function runHook(event: string): Promise<void> {
  if (event !== "post-tool" && event !== "prompt" && event !== "stop") {
    process.stderr.write("usage: room hook post-tool|prompt|stop\n");
    process.exitCode = 0;
    return;
  }
  let input: { stop_hook_active?: boolean } = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}") as typeof input;
  } catch {
    /* no input is fine */
  }
  try {
    const out = await hookOutput(event, input);
    if (out) process.stdout.write(out + "\n");
  } catch {
    /* a hook never gets in the session's way */
  }
}

if (process.argv[1] && /hub[/\\]hook\.[jt]s$/.test(process.argv[1])) void runHook(process.argv[2] ?? "");
