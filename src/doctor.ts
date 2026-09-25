/**
 * `room doctor`: start every roster seat, complete the ACP handshake, and
 * report what each one advertises. With `--deep`, also open a session in a
 * scratch directory and prove the permission round trip: one turn answered
 * allow must create a file, one answered deny must not.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpSeat, withTimeout } from "./seat/acp.js";
import { pickAskMode } from "./seat/modes.js";
import type { PermissionRequestView, SeatConfig, SeatEvent } from "./seat/types.js";
import { EXIT, type ExitCode, worst } from "./exit-codes.js";

export interface DoctorOptions {
  deep: boolean;
  /** Handshake timeout. */
  timeoutMs: number;
  /** Per-turn timeout in deep mode. */
  promptTimeoutMs: number;
  /** Progress lines, for the human-readable mode. */
  log?: (line: string) => void;
  /** Keep scratch directories for inspection. */
  keepScratch?: boolean;
}

export interface TurnResult {
  asked: boolean;
  /** Titles of the tool calls the agent asked permission for. */
  askedFor: string[];
  created: boolean;
  replyChars: number;
  /** First 300 characters of the reply, so a refusal or quota message is visible. */
  replyPreview: string;
  toolCalls: number;
  /** Update kinds seen that the seat does not map, e.g. "notice", "usage_update". */
  otherUpdates: string[];
  stopReason?: string;
  error?: string;
  ms: number;
}

export interface DeepResult {
  sessionId?: string;
  modes?: { current?: string; available: Array<{ id: string; name: string }> };
  configOptions?: Array<{
    id: string;
    name: string;
    type: string;
    category?: string;
    current?: unknown;
    values?: Array<{ id: string; name: string }>;
  }>;
  allow?: TurnResult;
  deny?: TurnResult;
  forwarding: "ok" | "edits-without-asking" | "deny-ignored" | "no-tool-use" | "failed" | "skipped";
  scratch?: string;
}

export interface DoctorRow {
  seat: string;
  command: string;
  started: boolean;
  ms: number;
  agent?: string;
  version?: string;
  loadSession?: boolean;
  authMethods: string[];
  auth: "ok" | "needed" | "unknown";
  deep?: DeepResult;
  error?: string;
  stderr?: string;
  /** What to do about a known failure, learned in phase 0. */
  hint?: string;
  code: ExitCode;
}

/** Known seat quirks. Keyed by seat name because the harness decides the fix. */
function hintFor(seat: string, row: DoctorRow): string | undefined {
  const fwd = row.deep?.forwarding;
  const preview = `${row.deep?.allow?.replyPreview ?? ""} ${row.deep?.deny?.replyPreview ?? ""}`;
  if (/usage limit|quota|rate limit/i.test(preview)) return "harness reports a usage limit; try later or use API-key auth";
  if (seat === "grok" && fwd === "edits-without-asking") {
    return "grok auto-approves; in ~/.grok/config.toml set `[ui] permission_mode = \"default\"` and add `[permission] ask = [\"Write(*)\", \"Edit(*)\", \"Bash(*)\"]`";
  }
  if (seat === "agy" && fwd === "edits-without-asking") {
    return "the antigravity-acp adapter always runs agy with --dangerously-skip-permissions; treat agy as a sandbox-only seat";
  }
  if (seat === "pool" && row.error && /docker/i.test(row.stderr ?? row.error)) {
    return "pool's sandbox needs the Docker daemon; start Docker or pass --sandbox disabled";
  }
  if (fwd === "no-tool-use") return "the agent did not try to write; check the model has file tools";
  return undefined;
}

export interface DoctorReport {
  ok: boolean;
  code: ExitCode;
  rows: DoctorRow[];
}

const PROMPT =
  "Create a file named scratch.txt in the current working directory containing the single word hello. " +
  "Use your file tools to do it. Do nothing else. When you are finished, reply with exactly one word: done";

export async function runDoctor(seats: SeatConfig[], opts: DoctorOptions): Promise<DoctorReport> {
  const rows = await Promise.all(seats.map((s) => checkSeat(s, opts)));
  const code = worst(rows.map((r) => r.code));
  return { ok: code === EXIT.OK, code, rows };
}

async function checkSeat(config: SeatConfig, opts: DoctorOptions): Promise<DoctorRow> {
  const log = (m: string) => opts.log?.(`[${config.name}] ${m}`);
  const started = Date.now();
  const row: DoctorRow = {
    seat: config.name,
    command: [config.command, ...(config.args ?? [])].join(" "),
    started: false,
    ms: 0,
    authMethods: [],
    auth: "unknown",
    code: EXIT.OK,
  };

  if (config.adapter !== "acp") {
    row.error = `adapter "${config.adapter}" is not implemented yet`;
    row.code = EXIT.CONFIG;
    return row;
  }

  // Deep mode records every request and answers by policy; shallow mode never sees one.
  let policy: "allow" | "deny" = "allow";
  const asked: PermissionRequestView[] = [];
  const seat = new AcpSeat(config, async (req) => {
    asked.push(req);
    log(`permission requested: ${req.title} [${req.kind ?? "?"}] -> ${policy}`);
    const want: string[] =
      policy === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
    for (const kind of want) {
      const opt = req.options.find((o) => o.kind === kind);
      if (opt) return opt.optionId;
    }
    return policy === "deny" ? "cancel" : (req.options[0]?.optionId ?? "cancel");
  });

  try {
    log("starting");
    const info = await seat.start({ timeoutMs: opts.timeoutMs });
    row.started = true;
    row.agent = info.agentName;
    row.version = info.agentVersion;
    row.loadSession = info.loadSession;
    row.authMethods = info.authMethods.map((m) => m.id);
    row.auth = info.authMethods.length === 0 ? "ok" : "unknown";
    log(`handshake ok: ${info.agentName ?? "?"} ${info.agentVersion ?? ""}`.trim());
  } catch (err) {
    row.error = (err as Error).message;
    row.stderr = seat.stderrTail().trim() || undefined;
    row.code = EXIT.SEAT_START;
    row.ms = Date.now() - started;
    return row;
  }

  if (opts.deep) {
    row.deep = { forwarding: "skipped" };
    const scratch = mkdtempSync(join(tmpdir(), `room-doctor-${config.name}-`));
    row.deep.scratch = scratch;
    // Each turn gets its own session in its own directory, so the deny turn
    // can neither reuse an earlier approval nor see the allow turn's file.
    const allowDir = join(scratch, "allow");
    const denyDir = join(scratch, "deny");
    mkdirSync(allowDir, { recursive: true });
    mkdirSync(denyDir, { recursive: true });

    const open = async (dir: string): Promise<boolean> => {
      try {
        log(`opening session in ${dir}`);
        row.deep!.sessionId = await withTimeout(
          seat.newSession(dir),
          opts.timeoutMs,
          `${config.name}: session/new timed out`,
        );
        row.auth = "ok";
        const modes = seat.modes;
        const configOptions = seat.configOptions;
        if (configOptions.length) row.deep!.configOptions = configOptions;
        if (modes) {
          row.deep!.modes = modes;
          const ask = pickAskMode(modes);
          if (ask && modes.current !== ask) {
            log(`switching mode ${modes.current ?? "?"} -> ${ask}`);
            await seat.setMode(ask).catch((err) => log(`set_mode failed: ${(err as Error).message}`));
            row.deep!.modes = { ...modes, current: ask };
          }
        } else {
          // No modes advertised. Some agents still accept the conventional id.
          await seat
            .setMode("default")
            .then(() => log(`set_mode default accepted without advertised modes`))
            .catch((err) => log(`set_mode default rejected: ${(err as Error).message}`));
        }
        // A permission-like select config option: pick its ask/default value.
        for (const o of configOptions) {
          if (o.type !== "select" || !o.values) continue;
          if (!(o.category === "mode" || /permission|approv|mode/i.test(o.id + o.name))) continue;
          const ask = o.values.find((v) => /^(default|ask|manual)$/i.test(v.id) || /ask|manual/i.test(v.name));
          if (ask && o.current !== ask.id) {
            log(`config ${o.id}: ${String(o.current)} -> ${ask.id}`);
            await seat
              .setConfigOption(o.id, ask.id)
              .catch((err) => log(`set_config_option failed: ${(err as Error).message}`));
          }
        }
        return true;
      } catch (err) {
        const msg = (err as Error).message;
        row.error = msg;
        row.auth = /auth/i.test(msg) ? "needed" : row.auth;
        row.code = row.auth === "needed" ? EXIT.AUTH : EXIT.PROTOCOL;
        row.deep!.forwarding = "failed";
        return false;
      }
    };

    // Turn 1: allow. Expect a permission request and a file.
    policy = "allow";
    asked.length = 0;
    if (await open(allowDir)) {
      row.deep.allow = await runTurn(seat, config, allowDir, asked, opts, log);
    }

    // Turn 2: deny. Expect a permission request and no file.
    policy = "deny";
    asked.length = 0;
    if (row.deep.allow && (await open(denyDir))) {
      row.deep.deny = await runTurn(seat, config, denyDir, asked, opts, log);
    }

    if (row.deep.forwarding !== "failed") {
      row.deep.forwarding = verdict(row.deep.allow, row.deep.deny);
      if (row.deep.forwarding !== "ok") {
        row.code = row.deep.forwarding === "failed" ? EXIT.PROTOCOL : EXIT.PERMISSIONS;
      }
    }
    row.hint = hintFor(config.name, row);
    log(`forwarding: ${row.deep.forwarding}${row.hint ? ` (${row.hint})` : ""}`);

    if (!opts.keepScratch) rmSync(scratch, { recursive: true, force: true });
  }

  await seat.stop();
  row.stderr = seat.stderrTail().trim() || undefined;
  row.ms = Date.now() - started;
  return row;
}

async function runTurn(
  seat: AcpSeat,
  config: SeatConfig,
  dir: string,
  asked: PermissionRequestView[],
  opts: DoctorOptions,
  log: (m: string) => void,
): Promise<TurnResult> {
  const t0 = Date.now();
  const result: TurnResult = {
    asked: false,
    askedFor: [],
    created: false,
    replyChars: 0,
    replyPreview: "",
    toolCalls: 0,
    otherUpdates: [],
    ms: 0,
  };
  try {
    const events = seat.prompt(PROMPT);
    await withTimeout(
      (async () => {
        for await (const ev of events) {
          result.stopReason = tally(ev, result) ?? result.stopReason;
        }
      })(),
      opts.promptTimeoutMs,
      `${config.name}: turn timed out after ${opts.promptTimeoutMs} ms`,
    );
  } catch (err) {
    result.error = (err as Error).message;
    await seat.cancel();
    log(`turn error: ${result.error}`);
  }
  result.asked = asked.length > 0;
  result.askedFor = asked.map((a) => a.title);
  result.created = existsSync(join(dir, "scratch.txt"));
  result.ms = Date.now() - t0;
  log(
    `turn done: asked=${result.asked} created=${result.created} tools=${result.toolCalls} stop=${result.stopReason ?? "?"} in ${result.ms} ms`,
  );
  return result;
}

function tally(ev: SeatEvent, r: TurnResult): string | undefined {
  switch (ev.type) {
    case "text":
      r.replyChars += ev.text.length;
      if (r.replyPreview.length < 300) r.replyPreview = (r.replyPreview + ev.text).slice(0, 300);
      return;
    case "tool_call":
      r.toolCalls += 1;
      return;
    case "other":
      if (!r.otherUpdates.includes(ev.update)) r.otherUpdates.push(ev.update);
      return;
    case "stop":
      return ev.stopReason;
    default:
      return;
  }
}

function verdict(allow?: TurnResult, deny?: TurnResult): DeepResult["forwarding"] {
  if (!allow || !deny) return "failed";
  if (allow.error && deny.error) return "failed";
  if (!allow.asked && allow.created) return "edits-without-asking";
  if (deny.asked && deny.created) return "deny-ignored";
  if (!allow.asked && !allow.created && allow.toolCalls === 0) return "no-tool-use";
  if (allow.asked && !deny.created) return "ok";
  return "failed";
}
