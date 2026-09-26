/**
 * Slash commands that change the room mid-session: room mode, seat modes,
 * and room policy. Shared by the REPL and the ACP server; each supplies
 * where the output lines go.
 */
import { roleList } from "./preamble.js";
import type { Room } from "./room.js";

export const COMMAND_HELP = `  /seats                 seats, modes, and what is queued
  /parallel, /sequential room mode: all seats answer at once, or in turn
  /role <seat> [id|none]  give a seat a role from the web app's presets (/role alone lists them)
  /cap [n|+n|off]        seat-to-seat wakes per thread before the room pauses it (+n lets a paused thread go on)
  /mod [off|you|auto|<model>]  who decides when a limit trips: an OpenRouter model (falls back to you), you, or nobody
  /wake all|last         who an untagged message wakes: every idle seat (default), or whoever spoke last
  /auto [on|off]         tool calls run without asking, except deny and ask rules
  /mode <seat> [id]      show or set a seat's session mode
  /unbench <seat>        bring back a seat benched after failing (so does @seat)
  /sync                  bring the room's landed work into your branch (fast-forward; your checkout is never switched)
  /land <seat>           merge a seat's desk into the trunk now (seats land their own with [land])
  /bg <seat> <task>      the seat works on it in its desk while the room goes on
  /stop <seat>           cancel a seat's background work
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
    case "/role": {
      const [seat, id] = args;
      if (!seat) {
        for (const r of roleList()) out(`  ${r.id.padEnd(14)} ${r.label}`);
        for (const n of room.seatNames) out(`  ${n}: ${room.roleOf(n) ?? "no role"}`);
        return;
      }
      if (!room.seatNames.includes(seat)) return out(`  usage: /role <seat> [id|none]; seats: ${room.seatNames.join(", ")}`);
      if (!id) return out(`  ${seat}: ${room.roleOf(seat) ?? "no role"}`);
      try {
        room.setRole(seat, id === "none" ? null : id);
      } catch (err) {
        out(`  ${(err as Error).message}`);
      }
      return;
    }
    case "/cap": {
      const [arg] = args;
      if (!arg) return out(`  seat-to-seat cap: ${room.cap ?? "off"} per thread`);
      if (arg === "off") room.setCap(null, true);
      else if (/^\+\d+$/.test(arg)) room.setCap((room.cap ?? 0) + Number(arg.slice(1)), true);
      else if (/^\d+$/.test(arg)) room.setCap(Number(arg), true);
      else return out(`  usage: /cap <n>, /cap +<n>, or /cap off`);
      out(`  seat-to-seat cap: ${room.cap ?? "off"} per thread`);
      return;
    }
    case "/sync": {
      out(`  ${await room.syncOut()}`);
      return;
    }
    case "/mod": {
      const [arg] = args;
      if (arg) {
        try {
          room.useModerator(arg);
        } catch (err) {
          return out(`  ${(err as Error).message}`);
        }
      }
      out(`  moderator: ${room.moderator?.label ?? "off (limits just hold)"}`);
      return;
    }
    case "/wake": {
      const [arg] = args;
      if (arg === "last" || arg === "all") room.setWake(arg);
      out(`  untagged messages wake: ${room.state.wake === "last" ? "whoever spoke last" : "every idle seat"} (@name for one, @all for everyone)`);
      return;
    }
    case "/auto": {
      const arg = args[0];
      room.setAuto(arg === "on" ? true : arg === "off" ? false : !room.auto);
      out(room.auto ? "  auto: tool calls run without asking, except deny and ask rules" : "  auto off: tool calls no rule allows ask you");
      return;
    }
    case "/seats": {
      out(`  room mode: ${room.mode}${room.auto ? ", auto" : ""}`);
      for (const name of room.seatNames) {
        const modes = room.modesOf(name);
        const mode = room.state.modes[name] ?? modes?.current ?? "-";
        const ahead = await room.unlanded(name);
        const benched =
          (room.benched.has(name) ? "  (benched)" : "") +
          (ahead ? `  (${ahead} commit${ahead === 1 ? "" : "s"} not landed)` : "") +
          (room.background.has(name) ? "  (background)" : "");
        out(`  ${name.padEnd(8)} mode ${mode.padEnd(12)} session ${room.state.sessions[name] ?? "-"}${benched}`);
      }
      if (room.queued.length) out(`  next: ${room.queued.join(" → ")}`);
      out(`  untagged messages wake: ${room.state.wake === "last" ? "whoever spoke last" : "every idle seat"}; seat-to-seat cap: ${room.cap ?? "off"}; moderator: ${room.moderator?.label ?? "off"}`);
      return;
    }
    case "/bg": {
      const [seat, ...task] = args;
      if (!seat || !room.seatNames.includes(seat) || task.length === 0) return out(`  usage: /bg <seat> <task>`);
      room.startBackground(seat, task.join(" "));
      return;
    }
    case "/stop": {
      const [seat] = args;
      if (!seat || !room.seatNames.includes(seat)) return out(`  usage: /stop <seat>; in the background: ${[...room.background.keys()].join(", ") || "none"}`);
      if (!(await room.stopBackground(seat))) out(`  ${seat} is not working in the background`);
      return;
    }
    case "/land": {
      const [seat] = args;
      if (!seat || !room.seatNames.includes(seat)) return out(`  usage: /land <seat>`);
      try {
        if (!(await room.land(seat))) out(`  ${seat} has no desk (the room is not using desks)`);
      } catch (err) {
        out(`  ${(err as Error).message}`);
      }
      return;
    }
    case "/unbench": {
      const [seat] = args;
      if (!seat || !room.seatNames.includes(seat)) return out(`  usage: /unbench <seat>; benched: ${[...room.benched].join(", ") || "none"}`);
      if (!room.unbench(seat)) out(`  ${seat} is not benched`);
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
