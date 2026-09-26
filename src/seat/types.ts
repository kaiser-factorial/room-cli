/**
 * The Seat interface every adapter implements. The scheduler only ever talks
 * to this, never to a harness directly.
 */

export interface SeatConfig {
  /** Display name, also the address used in `@name`. */
  name: string;
  /** Transport. `acp` spawns an ACP agent over stdio; `cli` is the per-turn fallback (phase 2). */
  adapter: "acp" | "cli";
  /** Executable to spawn: an adapter the room ships with (e.g. `claude-agent-acp`), else found on PATH. */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Model override, passed through when the adapter supports it. */
  model?: string;
  /** Role preset id from the web app's roles.ts, applied in the preamble. */
  role?: string;
  /** Persona text appended to the preamble, or a file holding it (e.g. a SOUL.md). */
  prompt?: string;
  promptFile?: string;
  /** For the cli adapter: which recipe. Defaults to the command's basename. */
  cli?: string;
  /** Session mode to set at session start, when the agent advertises modes. Default: the one that asks. */
  mode?: string;
  /** Terminal colour: a name (orange, light-blue, ...) or a 256-colour index. Default: the harness's. */
  colour?: string;
  /** Room policy: tool kinds or title patterns. Deny beats ask beats allow. */
  allow?: string[];
  ask?: string[];
  deny?: string[];
}

export interface SeatInfo {
  agentName?: string;
  agentVersion?: string;
  protocolVersion?: number;
  loadSession: boolean;
  /** Auth methods the agent advertises. Empty usually means already authenticated. */
  authMethods: Array<{ id: string; name: string }>;
}

/** What a tool call produced, in a form the terminal can show. */
export type ToolContentView =
  | { type: "diff"; path: string; oldText?: string; newText: string }
  | { type: "text"; text: string };

export type SeatEvent =
  | { type: "text"; text: string }
  | { type: "thought"; text: string }
  | {
      type: "tool_call";
      id: string;
      title: string;
      kind?: string;
      status?: string;
      content?: ToolContentView[];
      locations?: string[];
    }
  | {
      type: "tool_update";
      id: string;
      title?: string;
      status?: string;
      content?: ToolContentView[];
      locations?: string[];
    }
  | { type: "other"; update: string }
  | { type: "stop"; stopReason: string };

export interface PermissionOptionView {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface PermissionRequestView {
  seat: string;
  sessionId: string;
  toolCallId: string;
  title: string;
  kind?: string;
  options: PermissionOptionView[];
  /** The proposed change, when the agent sends it with the request. */
  content?: ToolContentView[];
}

/** Answers a permission request. Return an optionId, or "cancel" to cancel the turn. */
export type PermissionDecider = (req: PermissionRequestView) => Promise<string | "cancel">;

export interface Seat {
  readonly name: string;
  readonly config: SeatConfig;
  /** Spawn the agent and complete the ACP handshake. */
  start(opts?: { timeoutMs?: number }): Promise<SeatInfo>;
  /** Open a fresh session rooted at `cwd`. Returns the session id. */
  newSession(cwd: string): Promise<string>;
  /** Reattach to a saved session. False when the harness cannot; the room then replays. */
  resumeSession?(sessionId: string, cwd: string): Promise<boolean>;
  /** Send one turn and stream its events until the agent stops. */
  prompt(text: string): AsyncIterable<SeatEvent>;
  /** Cancel the in-flight turn, if any. */
  cancel(): Promise<void>;
  /** Close the connection and kill the process. */
  stop(): Promise<void>;
  /** Last few KB of the agent's stderr, for diagnostics. */
  stderrTail(): string;
  /** The harness's session id once known. A cli seat learns it on its first turn. */
  readonly sessionId?: string;
  /** Session modes, when the agent advertises them. */
  readonly modes?: { current?: string; available: Array<{ id: string; name: string }> };
  setMode?(modeId: string): Promise<void>;
  /** Hand the room's MCP server (inbox, post, ...) to the sessions this seat opens. */
  useMcp?(
    endpoint: { name: string; url: string; bridge: { command: string; args: string[] } },
    extra?: Array<{ name: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string }>,
  ): void;
}
