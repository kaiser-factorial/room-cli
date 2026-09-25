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
/** A seat ending its reply with this keeps the turn's work on its desk, unlanded. */
export const HOLD = "[hold]";

export interface PreambleOptions {
  seat: SeatConfig;
  seats: SeatConfig[];
  human: string;
  /** Whether this seat's permission prompts reach the human. */
  promptsForwarded: boolean;
  branch?: string;
  /** The seat's own worktree, when the room gives seats desks. */
  desk?: { path: string; branch: string };
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
    ? `You work in your own desk: a git worktree at ${o.desk.path}, on branch ${o.desk.branch}. It is yours: edit, run, and commit there freely, with messages that say why. Stay in it: do not check out other branches, push, or touch other worktrees. The shared trunk is ${o.branch}, in ${o.human}'s working directory. Before each of your turns the room merges the trunk into your branch, so you build on everyone's work; when your turn ends it commits whatever you left uncommitted, as you, and merges your branch into the trunk. If a merge conflicts, the room tells you, and resolving it is yours. Not ready to share yet? End your reply with \`${HOLD}\` on its own line: the room leaves this turn's work on your desk, uncommitted and unmerged, until a turn you end without it.`
    : o.branch
    ? `One shared working directory on branch ${o.branch}. The room commits after every turn that changes files, with you as author, so other seats see your edits through git and can build on them. Do not commit, branch, stash, or create worktrees yourself.`
    : `One shared working directory. Other seats see your file changes directly.`;

  return [
    `You are ${o.seat.name}, one seat in a room with several AI coding agents and one human. This is not a one-on-one session.`,
    persona,
    `Seats in the room:\n${roster}`,
    `How turns work: messages from others arrive labeled \`[name]: text\`. Lines from \`[room]\` are the orchestrator, not a participant. Turns go in order, and you see everything said since your last turn. Reply as yourself; do not write lines for other seats.`,
    `Addressing: start a sentence with \`@name\` to hand the next turn to that seat, for example \`@grok what do you think?\`.`,
    `Passing: reply with exactly \`${PASS}\` when you have nothing to add. Silence is a valid contribution and the human prefers it to filler.`,
    perms,
    git,
    `Keep replies short unless you are doing work. When you change files, say what you changed and where.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
