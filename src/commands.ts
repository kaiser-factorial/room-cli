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
  /check [cmd|off]       a command that must pass in a seat's desk before its work lands (e.g. pnpm typecheck && pnpm test)
  /mute <seat>, /unmute   untagged messages and @all skip a muted seat; @seat still wakes it
  /land <seat> [--force]           merge a seat's desk into the trunk now (seats land their own with [land])
  /context               each seat's context use, as its harness reports it
  /compact <seat> [focus]  compact a seat's context (keeping what the focus names); /cmd <seat> /<command> runs any of its own commands
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
        const u = room.usageOf(name);
        out(`  ${name.padEnd(8)} mode ${mode.padEnd(12)} session ${room.state.sessions[name] ?? "-"}${u ? `  context ${contextLine(u)}` : ""}${benched}`);
      }
      if (room.queued.length) out(`  next: ${room.queued.join(" → ")}`);
      out(`  untagged messages wake: ${room.state.wake === "last" ? "whoever spoke last" : "every idle seat"}; seat-to-seat cap: ${room.cap ?? "off"}; moderator: ${room.moderator?.label ?? "off"}`);
      return;
    }
    case "/context": {
      for (const name of room.seatNames) out(`  ${name.padEnd(8)} ${contextLine(room.usageOf(name))}`);
      return;
    }
    case "/compact":
    case "/cmd": {
      const [seat, ...rest] = args;
      if (!seat || !room.seatNames.includes(seat)) {
        return out(`  usage: ${cmd === "/compact" ? "/compact <seat> [what to keep]" : "/cmd <seat> /<command> [args]"}; seats: ${room.seatNames.join(", ")}`);
      }
      const line = cmd === "/compact" ? `compact ${rest.join(" ")}` : rest.join(" ");
      if (!line.trim()) {
        const cmds = room.commandsOf(seat);
        return out(cmds.length ? cmds.map((c) => `  /${c.name.padEnd(14)} ${c.description}`).join("\n") : `  ${seat} advertises no commands`);
      }
      const before = room.usageOf(seat);
      out(`  ${seat}: /${line.trim().replace(/^\//, "")} ...`);
      try {
        const said = await room.seatCommand(seat, line);
        if (said) out(said.split("\n").map((l) => `  ${l}`).join("\n"));
        if (cmd === "/compact") out(`  ${seat}: ${contextLine(before)} → ${contextLine(room.usageOf(seat))}`);
      } catch (err) {
        out(`  ${(err as Error).message}`);
      }
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
    case "/check": {
      const rest = text.trim().slice(cmd.length).trim();
      if (rest === "off") room.setLandCheck(null);
      else if (rest) room.setLandCheck(rest);
      out(`  landing check: ${room.state.landCheck ?? "none (/check <command> sets one)"}`);
      return;
    }
    case "/mute":
    case "/unmute": {
      const [seat] = args;
      if (seat && room.seatNames.includes(seat)) room.setMuted(seat, cmd === "/mute");
      else if (seat) return out(`  no seat ${seat}`);
      out(`  muted: ${[...room.muted].join(", ") || "nobody"}`);
      return;
    }
    case "/land": {
      const [seat, flag] = args;
      if (!seat || !room.seatNames.includes(seat)) return out(`  usage: /land <seat> [--force]`);
      try {
        if (!(await room.land(seat, { force: flag === "--force" }))) out(`  ${seat} has no desk (the room is not using desks)`);
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

/** "62% (124k of 200k)", or a note that the harness does not say. */
export function contextLine(u: { used: number; size: number } | undefined): string {
  if (!u || !u.size) return "not reported by its harness";
  const k = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  return `${Math.round((u.used / u.size) * 100)}% (${k(u.used)} of ${k(u.size)})`;
}
