/**
 * Slash commands that change the room mid-session: room mode, seat modes,
 * and room policy. Shared by the REPL and the ACP server; each supplies
 * where the output lines go.
 */
import type { Room } from "./room.js";

export const COMMAND_HELP = `  /seats                 seats, modes, and what is queued
  /parallel, /sequential room mode: all seats answer at once (no edits), or in turn
  /mode <seat> [id]      show or set a seat's session mode
  /perm <seat>           show a seat's policy
  /perm <seat> allow|ask|deny <pattern>   add a rule (kind like edit, or title glob like "Write *")
  /unperm <seat> <pattern>                remove a rule`;

export async function runCommand(room: Room, text: string, out: (line: string) => void): Promise<void> {
  const [cmd, ...args] = text.trim().split(/\s+/);
  switch (cmd) {
    case "/parallel":
    case "/sequential": {
      room.setRoomMode(cmd === "/parallel" ? "parallel" : "sequential");
      out(`  room mode: ${room.mode}${room.mode === "parallel" ? " (file changes refused during rounds)" : ""}`);
      return;
    }
    case "/seats": {
      out(`  room mode: ${room.mode}`);
      for (const name of room.seatNames) {
        const modes = room.modesOf(name);
        const mode = room.state.modes[name] ?? modes?.current ?? "-";
        out(`  ${name.padEnd(8)} mode ${mode.padEnd(12)} session ${room.state.sessions[name] ?? "-"}`);
      }
      if (room.scheduler.pending.length) out(`  queued: ${room.scheduler.pending.join(", ")}`);
      return;
    }
    case "/mode": {
      const [seat, id] = args;
      if (!seat || !room.seatNames.includes(seat)) return out(`  usage: /mode <seat> [id]; seats: ${room.seatNames.join(", ")}`);
      const modes = room.modesOf(seat);
      if (!id) {
        if (!modes) return out(`  ${seat} advertises no modes (its config file is the lever)`);
        for (const m of modes.available) out(`  ${m.id === (room.state.modes[seat] ?? modes.current) ? "*" : " "} ${m.id.padEnd(20)} ${m.name}`);
        return;
      }
      try {
        await room.setMode(seat, id);
        out(`  ${seat}: mode ${id}`);
      } catch (err) {
        out(`  ${(err as Error).message}`);
      }
      return;
    }
    case "/perm": {
      const [seat, action, ...rest] = args;
      if (!seat || !room.seatNames.includes(seat)) return out(`  usage: /perm <seat> [allow|ask|deny <pattern>]`);
      if (action) {
        if ((action !== "allow" && action !== "ask" && action !== "deny") || rest.length === 0) {
          return out(`  usage: /perm <seat> allow|ask|deny <pattern>`);
        }
        room.addRule(seat, action, rest.join(" "));
      }
      const p = room.policyOf(seat);
      out(`  ${seat}: allow ${JSON.stringify(p.allow)}  ask ${JSON.stringify(p.ask)}  deny ${JSON.stringify(p.deny)}`);
      out(`  (deny beats ask beats allow; unmatched calls ask you)`);
      return;
    }
    case "/unperm": {
      const [seat, ...rest] = args;
      if (!seat || rest.length === 0) return out(`  usage: /unperm <seat> <pattern>`);
      out(room.removeRule(seat, rest.join(" ")) ? `  removed` : `  no such rule`);
      return;
    }
    default:
      out(`  unknown command ${cmd}; /help`);
  }
}
