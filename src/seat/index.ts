import { AcpSeat } from "./acp.js";
import { CliSeat } from "./cli.js";
import type { PermissionDecider, Seat, SeatConfig } from "./types.js";

export function createSeat(config: SeatConfig, decide: PermissionDecider): Seat {
  switch (config.adapter) {
    case "acp":
      return new AcpSeat(config, decide);
    case "cli":
      return new CliSeat(config, decide);
  }
}
