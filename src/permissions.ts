/**
 * Room-level permission policy. This sits in the orchestrator, so it works
 * for every seat that asks, whatever the harness. Rules match a tool call's
 * kind (`edit`, `execute`, `read`, ...) or its title with `*` wildcards.
 * Deny beats ask beats allow, the same precedence grok uses.
 */
import type { PermissionDecider, PermissionRequestView } from "./seat/types.js";

export type Action = "allow" | "ask" | "deny";

export interface SeatPolicy {
  allow: string[];
  ask: string[];
  deny: string[];
}

export type Policy = Record<string, SeatPolicy>;

export function emptyPolicy(): SeatPolicy {
  return { allow: [], ask: [], deny: [] };
}

/** `*` matches anything; matching is case-insensitive and whole-string. */
export function matches(pattern: string, value: string): boolean {
  const re = new RegExp(
    "^" + pattern.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
    "i",
  );
  return re.test(value);
}

/** ACP's tool kinds. A rule naming one matches that kind only, never a title that says the word. */
export const TOOL_KINDS = new Set(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"]);

export function hit(patterns: string[], req: { kind?: string; title: string }): boolean {
  return patterns.some((p) => (TOOL_KINDS.has(p.toLowerCase()) ? req.kind?.toLowerCase() === p.toLowerCase() : matches(p, req.title)));
}

export function decide(policy: SeatPolicy | undefined, req: { kind?: string; title: string }): Action {
  if (!policy) return "ask";
  if (hit(policy.deny, req)) return "deny";
  if (hit(policy.ask, req)) return "ask";
  if (hit(policy.allow, req)) return "allow";
  return "ask";
}

export type HumanChoice = "allow" | "allow_always" | "deny" | "cancel";

export interface DeciderHooks {
  policyFor(seat: string): SeatPolicy | undefined;
  /** A room-wide override checked before policy, e.g. "no edits during a parallel round". */
  override?(req: PermissionRequestView): "allow" | "deny" | undefined;
  askHuman(req: PermissionRequestView): Promise<HumanChoice>;
  /**
   * Auto mode: a call no rule matches runs without asking. Deny rules still
   * block and explicit ask rules still ask.
   */
  auto?(): boolean;
  /** Called when the human picks "always". The pattern is the tool kind, or the title when there is no kind. */
  onAllowAlways(seat: string, pattern: string): void;
  log?(line: string): void;
}

/** Pick the agent's option for an action, falling back sensibly. */
export function optionFor(req: PermissionRequestView, action: "allow" | "deny"): string | "cancel" {
  const kinds = action === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const k of kinds) {
    const o = req.options.find((x) => x.kind === k);
    if (o) return o.optionId;
  }
  return action === "allow" ? (req.options[0]?.optionId ?? "cancel") : "cancel";
}

export function makeDecider(hooks: DeciderHooks): PermissionDecider {
  return async (req) => {
    const forced = hooks.override?.(req);
    if (forced) {
      hooks.log?.(`[${req.seat}] ${forced} by room: ${req.title}`);
      return optionFor(req, forced);
    }
    const policy = hooks.policyFor(req.seat);
    const action = decide(policy, req);
    // Allowed without a log line: the tool call itself is already on screen.
    if (action === "ask" && hooks.auto?.() && !(policy && hit(policy.ask, req))) return optionFor(req, "allow");
    if (action !== "ask") {
      hooks.log?.(`[${req.seat}] ${action} by policy: ${req.title}`);
      return optionFor(req, action);
    }
    const choice = await hooks.askHuman(req);
    switch (choice) {
      case "allow":
        return optionFor(req, "allow");
      case "allow_always":
        // A rule from a kind is safe. One from a title is not: the seat wrote the title,
        // and a `*` in it would be a wildcard. Allow this once and say so.
        if (req.kind && TOOL_KINDS.has(req.kind)) hooks.onAllowAlways(req.seat, req.kind);
        else hooks.log?.(`[${req.seat}] allowed once: "${req.title}" has no tool kind to make a rule from; /perm ${req.seat} allow <pattern> makes one`);
        return optionFor(req, "allow");
      case "deny":
        return optionFor(req, "deny");
      case "cancel":
        return "cancel";
    }
  };
}
