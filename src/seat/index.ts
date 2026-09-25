import { AcpSeat } from "./acp.js";
import { CliSeat } from "./cli.js";
import type { PermissionDecider, Seat, SeatConfig } from "./types.js";

export function createSeat(config: SeatConfig, decide: PermissionDecider, notice?: (text: string) => void): Seat {
  switch (config.adapter) {
    case "acp":
      return new AcpSeat(config, decide, notice);
    case "cli":
      return new CliSeat(config, decide);
  }
}
