/** Seat configs that spawn the fake harnesses. Usable from any test. */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SeatConfig } from "../../src/seat/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "..");
const tsxCandidates = [join(pkg, "node_modules", ".bin", "tsx"), join(pkg, "..", "..", "node_modules", ".bin", "tsx")];
export const TSX = tsxCandidates.find((p) => existsSync(p)) ?? "tsx";
export const FAKE_AGENT = join(here, "fake-agent.ts");
export const FAKE_CLAUDE = join(here, "fake-claude");

/** An ACP seat backed by the fake agent. `flags` are fake-agent switches. */
export function fakeAcpSeat(name: string, flags: string[] = [], stateDir?: string, extra: Partial<SeatConfig> = {}): SeatConfig {
  return {
    name,
    adapter: "acp",
    command: TSX,
    args: [FAKE_AGENT, ...flags, ...(stateDir ? ["--state-dir", stateDir] : [])],
    ...extra,
  };
}

/** A CLI seat backed by the fake Claude-shaped harness. */
export function fakeCliSeat(name: string, stateDir: string, extra: Partial<SeatConfig> = {}): SeatConfig {
  return {
    name,
    adapter: "cli",
    command: FAKE_CLAUDE,
    cli: "claude",
    env: { FAKE_CLI_STATE: stateDir },
    ...extra,
  };
}
