/**
 * The menu: `room` with no command. The first time, it walks through your
 * defaults; after that it opens on home: start a room with them, look back
 * at past rooms, change the defaults, set up the moderator, and see what
 * skills and MCP servers the harnesses here have (and share them).
 *
 * Keys: ↑↓ move, enter picks or edits, space toggles, ←→ cycles a choice,
 * esc goes back, q quits from home.
 */
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";
import type { McpServerEntry, Skill } from "../../discover.js";
import { humanBytes, type RoomSummary } from "../../history.js";
import { DEFAULT_MODERATOR_MODEL } from "../../moderator.js";
import type { SeatConfig } from "../../seat/types.js";
import { maskKey, type Settings } from "../../settings.js";
import type { Entry } from "../../transcript.js";

export type MenuResult = { action: "start" } | { action: "resume"; cwd: string; name: string } | { action: "quit" };

export interface MenuContext {
  roster: SeatConfig[];
  roles: Array<{ id: string; label: string }>;
  settings: Settings;
  firstRun: boolean;
  /** The saved OpenRouter key, or the environment's. */
  openrouterKey?: string;
  skills: Skill[];
  mcp: McpServerEntry[];
  rooms: () => RoomSummary[];
  transcript: (cwd: string, name: string) => Entry[];
  archive: (cwd: string, name: string) => Promise<{ saved: number }>;
  save: (s: Settings) => void;
  saveKey: (key: string | undefined) => void;
  cwd: string;
}

type Screen = "home" | "defaults" | "moderator" | "skills" | "rooms" | "room" | "view";

interface Editing {
  label: string;
  value: string;
  mask?: boolean;
  done: (value: string) => void;
}

const MOD_CHOICES = ["auto", "you", "off", "model"] as const;

export function Menu({ ctx, onDone }: { ctx: MenuContext; onDone: (r: MenuResult) => void }) {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>(ctx.firstRun ? "defaults" : "home");
  const [cursor, setCursor] = useState(0);
  const [settings, setSettings] = useState<Settings>(ctx.settings);
  const [key, setKey] = useState<string | undefined>(ctx.openrouterKey);
  const [editing, setEditing] = useState<Editing | undefined>();
  const [note, setNote] = useState<string | undefined>(ctx.firstRun ? "Welcome. Pick who joins your rooms by default, then Save." : undefined);
  const [rooms, setRooms] = useState<RoomSummary[]>(() => ctx.rooms());
  const [picked, setPicked] = useState<RoomSummary | undefined>();
  const [scroll, setScroll] = useState(0);

  const finish = (r: MenuResult) => {
    onDone(r);
    exit();
  };
  const go = (s: Screen) => {
    setScreen(s);
    setCursor(0);
    setNote(undefined);
  };
  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));
  const persist = (s: Settings, msg = "saved") => {
    ctx.save(s);
    setNote(msg);
  };

  const inRoom = settings.seats ?? [];
  const roleIds = ["", ...ctx.roles.map((r) => r.id)];
  const modSpec = settings.moderator ?? "auto";
  const modChoice: (typeof MOD_CHOICES)[number] = (MOD_CHOICES as readonly string[]).includes(modSpec) ? (modSpec as "auto") : "model";

  // ---- rows per screen: a label, and what enter / space / ←→ do ----
  interface Row {
    label: React.ReactNode;
    enter?: () => void;
    space?: () => void;
    cycle?: (dir: 1 | -1) => void;
    hint?: string;
  }
  let title = "";
  let rows: Row[] = [];
  let body: React.ReactNode = null;

  if (screen === "home") {
    title = "room";
    rows = [
      {
        label: `Start a room${inRoom.length ? ` (${inRoom.join(", ")})` : " (set your seats in Room defaults first)"}`,
        enter: () => (inRoom.length ? finish({ action: "start" }) : setNote("No seats yet: pick them in Room defaults.")),
      },
      { label: `Past rooms (${rooms.length})`, enter: () => go("rooms") },
      { label: "Room defaults: who joins, roles, personas, your name", enter: () => go("defaults") },
      { label: `Moderator: ${modSpec === "auto" ? `auto (${key ? "OpenRouter" : "you, no key yet"})` : modSpec}`, enter: () => go("moderator") },
      { label: `Skills & MCP (${ctx.skills.length} skills, ${ctx.mcp.length} servers)`, enter: () => go("skills") },
      { label: "Quit", enter: () => finish({ action: "quit" }) },
    ];
  } else if (screen === "defaults") {
    title = ctx.firstRun ? "Set up your room" : "Room defaults";
    rows = [
      {
        label: `Your name: ${settings.human ?? "Corina"}`,
        enter: () => setEditing({ label: "Your name", value: settings.human ?? "Corina", done: (v) => v.trim() && update({ human: v.trim() }) }),
      },
      ...ctx.roster.map((s): Row => {
        const on = inRoom.includes(s.name);
        const role = settings.roles?.[s.name] ?? s.role ?? "";
        const persona = settings.personas?.[s.name];
        return {
          label: (
            <Text>
              <Text color={on ? "green" : "gray"}>{on ? "[x]" : "[ ]"}</Text>
              {` ${s.name.padEnd(8)} role: ${(ctx.roles.find((r) => r.id === role)?.label ?? "none").padEnd(14)} persona: ${persona ? truncate(persona, 30) : "none"}`}
            </Text>
          ),
          hint: "space: in or out · ←→ role · enter: persona",
          space: () => update({ seats: on ? inRoom.filter((x) => x !== s.name) : ctx.roster.map((r) => r.name).filter((n) => n === s.name || inRoom.includes(n)) }),
          cycle: (d) => {
            const next = roleIds[(roleIds.indexOf(role) + d + roleIds.length) % roleIds.length];
            const roles = { ...(settings.roles ?? {}) };
            if (next) roles[s.name] = next;
            else delete roles[s.name];
            update({ roles });
          },
          enter: () =>
            setEditing({
              label: `${s.name}'s persona (who it is, in a sentence or two; empty for none)`,
              value: persona ?? "",
              done: (v) => {
                const personas = { ...(settings.personas ?? {}) };
                if (v.trim()) personas[s.name] = v.trim();
                else delete personas[s.name];
                update({ personas });
              },
            }),
        };
      }),
      {
        label: `Untagged messages wake: ${settings.wake === "last" ? "whoever spoke last" : "everyone"}`,
        hint: "←→ or enter",
        cycle: () => update({ wake: settings.wake === "last" ? "all" : "last" }),
        enter: () => update({ wake: settings.wake === "last" ? "all" : "last" }),
      },
      {
        label: `Seat-to-seat wakes per message: ${settings.cap === "off" ? "no limit" : (settings.cap ?? 6)}`,
        hint: "←→",
        cycle: (d) => {
          const cur = settings.cap === "off" ? 0 : (settings.cap ?? 6);
          const next = cur + d;
          update({ cap: next <= 0 ? "off" : next });
        },
      },
      {
        label: `Open rooms in: ${settings.tui === false ? "the plain REPL" : "the TUI"}`,
        hint: "←→ or enter",
        cycle: () => update({ tui: settings.tui === false }),
        enter: () => update({ tui: settings.tui === false }),
      },
      {
        label: <Text bold>Save</Text>,
        enter: () => {
          persist(settings, "Saved. These are your defaults for room start and the menu.");
          if (ctx.firstRun) go("home");
        },
      },
      { label: "Back without saving", enter: () => (setSettings(ctx.settings), go("home")) },
    ];
  } else if (screen === "moderator") {
    title = "Moderator";
    body = (
      <Text dimColor>
        When a limit trips (the wake cap, an echo, a seat's post limit), the moderator decides whether it goes through. auto: a model on
        OpenRouter when there is a key, else you.
      </Text>
    );
    rows = [
      {
        label: `Who decides: ${modChoice === "model" ? `a model of your choosing (${modSpec})` : modChoice}`,
        hint: "←→",
        cycle: (d) => {
          const next = MOD_CHOICES[(MOD_CHOICES.indexOf(modChoice) + d + MOD_CHOICES.length) % MOD_CHOICES.length];
          update({ moderator: next === "model" ? DEFAULT_MODERATOR_MODEL : next });
        },
      },
      {
        label: `Model: ${modChoice === "model" ? modSpec : `${DEFAULT_MODERATOR_MODEL} (default)`}`,
        hint: "enter to type an OpenRouter model id",
        enter: () => setEditing({ label: "OpenRouter model id", value: modChoice === "model" ? modSpec : DEFAULT_MODERATOR_MODEL, done: (v) => v.trim() && update({ moderator: v.trim() }) }),
      },
      {
        label: `OpenRouter key: ${maskKey(key)}`,
        hint: "enter to paste a key (saved to secrets.toml, readable only by you); empty clears it",
        enter: () =>
          setEditing({
            label: "OpenRouter API key",
            value: "",
            mask: true,
            done: (v) => {
              const k = v.trim() || undefined;
              ctx.saveKey(k);
              setKey(k);
              setNote(k ? "Key saved." : "Key cleared.");
            },
          }),
      },
      { label: <Text bold>Save</Text>, enter: () => persist(settings) },
      { label: "Back", enter: () => go("home") },
    ];
  } else if (screen === "skills") {
    title = "Skills & MCP";
    const share = settings.shareSkills !== false;
    const shared = new Set(settings.shareMcp ?? []);
    rows = [
      {
        label: `Share skills with every seat: ${share ? "on" : "off"}`,
        hint: "space · seats read them through the room's skills tool",
        space: () => update({ shareSkills: !share }),
        enter: () => update({ shareSkills: !share }),
      },
      ...ctx.skills.map((k): Row => ({ label: <Text dimColor={!share}>{`  ${k.name.padEnd(24)} ${k.harness.padEnd(7)} ${truncate(k.description, 60)}`}</Text> })),
      ...ctx.mcp.map((m): Row => {
        const on = shared.has(m.name);
        return {
          label: (
            <Text>
              <Text color={on ? "green" : "gray"}>{on ? "[x]" : "[ ]"}</Text>
              {` mcp ${m.name.padEnd(20)} ${m.harness.padEnd(7)} ${truncate(m.url ?? [m.command, ...(m.args ?? [])].join(" "), 50)}`}
            </Text>
          ),
          hint: "space: hand this server to every seat (not back to its own harness)",
          space: () => update({ shareMcp: on ? [...shared].filter((x) => x !== m.name) : [...shared, m.name] }),
        };
      }),
      { label: <Text bold>Save</Text>, enter: () => persist(settings) },
      { label: "Back", enter: () => go("home") },
    ];
    if (!ctx.skills.length && !ctx.mcp.length) body = <Text dimColor>No skills or MCP servers found in ~/.claude, ~/.codex, ~/.gemini, ~/.hermes, or ~/.agents.</Text>;
  } else if (screen === "rooms") {
    title = "Past rooms";
    rows = [
      ...rooms.map((r): Row => ({
        label: `${r.name.padEnd(12)} ${ago(r.updated).padEnd(9)} ${r.seats.join(", ").padEnd(22)} ${humanBytes(r.bytes).padStart(8)}${r.archived ? " archived" : ""}${r.cwd !== ctx.cwd ? `  ${shortPath(r.cwd)}` : ""}`,
        hint: r.last ? truncate(r.last, 90) : undefined,
        enter: () => {
          setPicked(r);
          go("room");
        },
      })),
      { label: "Back", enter: () => go("home") },
    ];
    if (!rooms.length) body = <Text dimColor>No rooms yet.</Text>;
  } else if (screen === "room" && picked) {
    title = `${picked.name} (${shortPath(picked.cwd)})`;
    body = (
      <Text dimColor>
        {`${picked.seats.join(", ")} · started ${picked.started?.slice(0, 16).replace("T", " ") ?? "?"} · ${humanBytes(picked.bytes)}${picked.desks ? ` · ${picked.desks} desk worktrees on disk` : ""}`}
      </Text>
    );
    rows = [
      { label: "Read it", enter: () => (setScroll(Number.MAX_SAFE_INTEGER), setScreen("view")) },
      { label: "Resume it", enter: () => finish({ action: "resume", cwd: picked.cwd, name: picked.name }) },
      {
        label: picked.archived && !picked.desks ? "Archived" : "Archive: gzip the transcript, remove desk worktrees (branches stay)",
        enter: () =>
          void ctx.archive(picked.cwd, picked.name).then(({ saved }) => {
            const fresh = ctx.rooms();
            setRooms(fresh);
            setPicked(fresh.find((r) => r.cwd === picked.cwd && r.name === picked.name));
            setNote(`Archived; freed ${humanBytes(saved)}. Resume unpacks it.`);
          }),
      },
      { label: "Back", enter: () => go("rooms") },
    ];
  }

  const view = screen === "view" && picked ? ctx.transcript(picked.cwd, picked.name) : [];
  const viewLines = view.flatMap((e) => (e.kind === "message" ? [`[${e.from}]`, ...e.text.split("\n"), ""] : e.kind === "pass" ? [`[${e.from}] passed`, ""] : [`  ${e.text}`, ""]));
  const page = 20;
  const top = Math.max(0, Math.min(scroll, viewLines.length - page));

  useInput((input, k) => {
    if (editing) {
      if (k.escape) setEditing(undefined);
      return;
    }
    if (screen === "view") {
      if (k.escape || input === "q") setScreen("room");
      else if (k.upArrow) setScroll(top - 1);
      else if (k.downArrow) setScroll(top + 1);
      else if (k.pageUp || input === "b") setScroll(top - page);
      else if (k.pageDown || input === " ") setScroll(top + page);
      return;
    }
    if (k.upArrow) setCursor((c) => (c - 1 + rows.length) % rows.length);
    else if (k.downArrow) setCursor((c) => (c + 1) % rows.length);
    else if (k.return) rows[cursor]?.enter?.();
    else if (input === " ") (rows[cursor]?.space ?? rows[cursor]?.enter)?.();
    else if (k.leftArrow) rows[cursor]?.cycle?.(-1);
    else if (k.rightArrow) rows[cursor]?.cycle?.(1);
    else if (k.escape) go(screen === "room" ? "rooms" : "home");
    else if (input === "q" && screen === "home") finish({ action: "quit" });
  });

  if (screen === "view" && picked) {
    return (
      <Box flexDirection="column">
        <Text bold>{`${picked.name}  ${top + 1}–${Math.min(top + page, viewLines.length)} of ${viewLines.length} lines`}</Text>
        {viewLines.slice(top, top + page).map((l, i) => (
          <Text key={i} dimColor={l.startsWith("  ")}>
            {l || " "}
          </Text>
        ))}
        <Text dimColor>↑↓ line · space/b page · esc back</Text>
      </Box>
    );
  }

  const hint = editing ? undefined : rows[cursor]?.hint;
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {title}
      </Text>
      {body}
      <Box flexDirection="column" marginTop={1}>
        {rows.map((r, i) => (
          <Text key={i} inverse={i === cursor && !editing}>
            {i === cursor ? "› " : "  "}
            {r.label}
          </Text>
        ))}
      </Box>
      {editing ? (
        <Box marginTop={1}>
          <Text>{`${editing.label}: `}</Text>
          <TextInput
            value={editing.value}
            mask={editing.mask ? "*" : undefined}
            onChange={(v) => setEditing({ ...editing, value: v })}
            onSubmit={(v) => {
              editing.done(v);
              setEditing(undefined);
            }}
          />
        </Box>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {hint ? <Text dimColor>{hint}</Text> : null}
        {note ? <Text color="green">{note}</Text> : null}
        <Text dimColor>{editing ? "enter saves · esc cancels" : `↑↓ move · enter pick · space toggle · ←→ change · esc back${screen === "home" ? " · q quit" : ""}`}</Text>
      </Box>
    </Box>
  );
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function shortPath(p: string): string {
  const home = process.env.HOME;
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function ago(d: Date): string {
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
