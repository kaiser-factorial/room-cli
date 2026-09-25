/**
 * Per-harness recipes for the CLI fallback adapter: how to run one turn
 * headless, how to resume, and how to read the reply and session id out of
 * the output. Unattended flags are part of the recipe because a CLI turn
 * cannot forward permission prompts; the room policy never sees them.
 */
import { readFileSync } from "node:fs";

export interface CliTurn {
  /** Text the human's message goes in. */
  prompt: string;
  /** Session id from a previous turn, if any. */
  sessionId?: string;
  cwd: string;
  /** A scratch file path the recipe may use for the final message. */
  scratchFile: string;
}

export interface CliReply {
  text: string;
  sessionId?: string;
  error?: string;
}

export interface CliRecipe {
  /** Seat-config `cli` value, and the default command. */
  id: string;
  command: string;
  args(turn: CliTurn): string[];
  parse(stdout: string, turn: CliTurn): CliReply;
  /** One line for the doctor table. */
  unattended: string;
}

function json(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // Some harnesses print a preamble; take the last line that parses.
    for (const line of trimmed.split("\n").reverse()) {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        /* keep looking */
      }
    }
    return undefined;
  }
}

export const RECIPES: Record<string, CliRecipe> = {
  claude: {
    id: "claude",
    command: "claude",
    unattended: "--permission-mode acceptEdits",
    args: (t) => [
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      ...(t.sessionId ? ["--resume", t.sessionId] : []),
      t.prompt,
    ],
    parse: (out) => {
      const j = json(out);
      if (!j) return { text: "", error: "no JSON in output" };
      return {
        text: String(j.result ?? ""),
        sessionId: typeof j.session_id === "string" ? j.session_id : undefined,
        error: j.is_error ? String(j.result ?? "error") : undefined,
      };
    },
  },
  grok: {
    id: "grok",
    command: "grok",
    // With ask rules in ~/.grok/config.toml, headless grok silently drops
    // writes under acceptEdits and even under --allow flags, while still
    // claiming it made the edit. Only --always-approve writes. Prefer the
    // ACP route for grok; this fallback is unsandboxed.
    unattended: "--always-approve (unsandboxed; prefer grok over ACP)",
    args: (t) => [
      "-p",
      t.prompt,
      "--output-format",
      "json",
      "--always-approve",
      ...(t.sessionId ? ["-r", t.sessionId] : []),
    ],
    parse: (out) => {
      const j = json(out);
      if (!j) return { text: "", error: "no JSON in output" };
      return {
        text: String(j.text ?? ""),
        sessionId: typeof j.sessionId === "string" ? j.sessionId : undefined,
      };
    },
  },
  agy: {
    id: "agy",
    command: "agy",
    unattended: "--mode accept-edits (agy never asks headless anyway)",
    args: (t) => [
      `--print=${t.prompt}`,
      "--output-format",
      "json",
      "--mode",
      "accept-edits",
      ...(t.sessionId ? ["--conversation", t.sessionId] : []),
    ],
    parse: (out) => {
      const j = json(out);
      if (!j) return { text: "", error: "no JSON in output" };
      return {
        text: String(j.response ?? ""),
        sessionId: typeof j.conversation_id === "string" ? j.conversation_id : undefined,
        error: j.status && j.status !== "SUCCESS" ? String(j.status) : undefined,
      };
    },
  },
  codex: {
    id: "codex",
    command: "codex",
    unattended: "--sandbox workspace-write",
    args: (t) => [
      "exec",
      ...(t.sessionId ? ["resume", t.sessionId] : []),
      "--json",
      "--skip-git-repo-check",
      "--sandbox",
      "workspace-write",
      "-o",
      t.scratchFile,
      t.prompt,
    ],
    parse: (out, t) => {
      let sessionId: string | undefined;
      let error: string | undefined;
      for (const line of out.split("\n")) {
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (ev.type === "thread.started" && typeof ev.thread_id === "string") sessionId = ev.thread_id;
        if (ev.type === "error" && typeof ev.message === "string") error = ev.message;
      }
      let text = "";
      try {
        text = readFileSync(t.scratchFile, "utf8").trim();
      } catch {
        /* no final message */
      }
      return { text, sessionId, error };
    },
  },
};

/** Pick a recipe from the seat's `cli` field, else the command's basename. */
export function recipeFor(cli: string | undefined, command: string): CliRecipe {
  const key = cli ?? command.split("/").pop() ?? command;
  const r = RECIPES[key];
  if (!r) throw new Error(`no CLI recipe "${key}" (have: ${Object.keys(RECIPES).join(", ")})`);
  return r;
}
