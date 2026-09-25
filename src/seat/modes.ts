/**
 * Session modes differ per harness. This picks the one that asks.
 *   claude, hermes: "default"   codex-acp: "read-only" ("Ask for approval")
 */
export interface ModeState {
  current?: string;
  available: Array<{ id: string; name: string }>;
}

export function pickAskMode(modes: ModeState | undefined): string | undefined {
  if (!modes) return undefined;
  return modes.available.find(
    (m) => /^(default|ask|normal|interactive|read-only)$/i.test(m.id) || /ask/i.test(m.name),
  )?.id;
}
