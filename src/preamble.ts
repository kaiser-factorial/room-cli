/**
 * The room preamble: what every seat is told on its first turn, plus its
 * persona from the web app's role presets.
 */
import { readFileSync } from "node:fs";
import { ROLE_PRESETS } from "../../../src/lib/roles.js";
import type { SeatConfig } from "./seat/types.js";

/** Persona text from `prompt` or `promptFile`, or undefined. */
export function personaText(seat: SeatConfig): string | undefined {
  const parts: string[] = [];
  if (seat.promptFile) {
    try {
      parts.push(readFileSync(seat.promptFile, "utf8").trim());
    } catch (err) {
      throw new Error(`${seat.name}: cannot read promptFile ${seat.promptFile}: ${(err as Error).message}`);
    }
  }
  if (seat.prompt) parts.push(seat.prompt.trim());
  return parts.length ? parts.join("\n\n") : undefined;
}

export const PASS = "[pass]";
/** A reply's first or last line `[background] <task>`: the seat keeps working while the room goes on. */
export const BACKGROUND = "[background]";
/** A reply's first or last line `[land]`: the seat's branch is ready, merge it into the trunk. */
export const LAND = "[land]";

export interface PreambleOptions {
  seat: SeatConfig;
  seats: SeatConfig[];
  human: string;
  /** Whether this seat's permission prompts reach the human. */
  promptsForwarded: boolean;
  branch?: string;
  /** The seat's own worktree, when the room gives seats desks. */
  desk?: { path: string; branch: string };
  /** Whether the seat has the room's MCP tools. */
  tools?: boolean;
  /** How many skills the room shares through its `skills` tool. */
  skills?: number;
}

/** The web app's role presets, as `/role` lists them. */
export function roleList(): Array<{ id: string; label: string }> {
  return ROLE_PRESETS.map((r) => ({ id: r.id, label: r.label }));
}

export function rolePrompt(roleId: string | undefined, name: string): string | undefined {
  if (!roleId) return undefined;
  const preset = ROLE_PRESETS.find((r) => r.id === roleId);
  if (!preset) throw new Error(`unknown role "${roleId}" (have: ${ROLE_PRESETS.map((r) => r.id).join(", ")})`);
  return preset.prompt.replaceAll("{name}", name);
}

export function buildPreamble(o: PreambleOptions): string {
  const others = o.seats.filter((s) => s.name !== o.seat.name);
  const roster = [
    ...others.map((s) => `- ${s.name}: ${s.command}${s.model ? ` (${s.model})` : ""}${s.role ? `, role ${s.role}` : ""}`),
    `- ${o.human}: the human. Reads everything and can answer your permission prompts.`,
  ].join("\n");
  const role = rolePrompt(o.seat.role, o.seat.name);
  const identity = personaText(o.seat);
  const persona = [role, identity ? `Your identity, in your own words:\n\n${identity}` : undefined]
    .filter(Boolean)
    .join("\n\n");
  const perms = o.promptsForwarded
    ? `Your permission prompts reach ${o.human}. Answers can take a while, so batch small tool calls into one turn rather than asking many times.`
    : `Your permission prompts do not reach anyone. You run in a sandbox, and actions outside the workspace will fail.`;
  const git = o.desk && o.branch
    ? `You work in your own desk: a git worktree at ${o.desk.path}, on branch ${o.desk.branch}. It is yours: edit, run, and commit there freely, with messages that say why. Stay in it: do not check out other branches, push, or touch other worktrees. The shared trunk is ${o.branch}, in ${o.human}'s working directory. Before each of your turns the room merges the trunk into your branch, so you build on everyone's work; when your turn ends it commits whatever you left uncommitted, as you. Your branch reaches the trunk only when you say so: end a reply with \`${LAND}\` on its own line when your work is ready for the others, and the room merges it (${o.human} can also land it). If a merge conflicts, the room tells you, and resolving it is yours. The room shows you other seats' tool calls one line each; for the full work, their branches are visible from your desk: \`git log -p ${o.desk.branch.replace(/[^/]+$/, "<seat>")}\` for what one did, \`git diff ${o.branch}...${o.desk.branch.replace(/[^/]+$/, "<seat>")}\` for what it has not landed yet. Something that takes a while (a build, a long refactor, a test run to watch)? End your reply with \`${BACKGROUND} <what you will do>\` on its own line: you keep working in your desk while the conversation goes on without you, ${o.human} watches your progress, and your reply is posted when you finish.`
    : o.branch
    ? `One shared working directory on branch ${o.branch}. The room commits after every turn that changes files, with you as author, so other seats see your edits through git and can build on them. Do not commit, branch, stash, or create worktrees yourself.`
    : `One shared working directory. Other seats see your file changes directly.`;

  return [
    `You are ${o.seat.name}, one seat in a room with several AI coding agents and one human. This is not a one-on-one session.`,
    persona,
    `Seats in the room:\n${roster}`,
    `How turns work: messages from others arrive labeled \`[name]: text\`. Lines from \`[room]\` are the orchestrator, not a participant. You are woken when someone tags you (or you spoke last and the human replies), and you see everything said since your last turn. Reply as yourself; do not write lines for other seats.`,
    `Addressing: this is a group chat, and messages arrive whenever they are sent. You are woken when someone tags you. To want an answer from a seat, tag it with \`@name\` on the first or last line of your reply (\`@a @b\` for several, \`@all\` for everyone); tagged seats answer after you, one at a time. Tag only when you need an answer: agreeing needs no tag, and tagging just to agree starts an echo the room will pause. A seat that is busy reads your message when it is free.`,
    `Passing: reply with exactly \`${PASS}\` when you have nothing to add. Silence is a valid contribution and the human prefers it to filler.`,
    perms,
    git,
    o.tools
      ? `Room tools: you have an MCP server named \`room\`. While you work, \`inbox\` shows what others posted since you last read (worth a look between long steps, in case someone redirects you), \`post\` puts a short message in the room now (progress, a question, a heads-up; tag with @name to wake someone), \`status\` says who is busy, \`show\` gives a message in full with its tool calls, and \`diff\` shows a seat's work not landed yet. Post sparingly: your final reply is posted anyway.` +
        (o.skills
          ? ` The room also shares ${o.skills} skill${o.skills === 1 ? "" : "s"} set up across the seats' harnesses: \`skills\` lists them, \`skill\` gives one in full. Check it before building something a skill may already cover.`
          : "")
      : "",
    `Keep replies short unless you are doing work. When you change files, say what you changed and where.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
