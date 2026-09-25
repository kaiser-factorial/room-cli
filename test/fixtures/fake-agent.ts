/**
 * A fake ACP agent: a real subprocess speaking the real protocol over stdio,
 * with switches for the quirks met on each harness. It lets the whole seat
 * path be tested on a machine with no harness installed.
 *
 *   tsx fake-agent.ts [--modes] [--auto-edit] [--no-ids] [--resume] [--load]
 *                     [--start-delay <ms>] [--fail-session <msg>] [--state-dir <dir>]
 *                     [--stray-reply <id>]
 *
 * `--stray-reply` mimics claude-agent-acp on a machine with skills set up: a
 * JSON-RPC reply to a request the client never made (id "skills-reload"),
 * written shortly after each session/new and each turn.
 *
 * It follows directives in the prompt, one per line:
 *   >> say <text>            stream text in word chunks (messageId unless --no-ids)
 *   >> say2 <text>           a second message (new messageId)
 *   >> think <text>          a thought chunk
 *   >> edit <path> <text>    tool_call edit with a diff; asks permission unless
 *                            --auto-edit or the session mode auto-approves
 *   >> run <cmd>             tool_call execute with boxed output
 *   >> remember <word>       keep a word in session state (persists across processes)
 *   >> recall                say the remembered word
 *   >> sleep <ms>            wait, cancellable
 *   >> pass                  say [pass]
 *   >> mention <name> <txt>  say "@name txt"
 *   >> commit <message>      git add -A and commit in the session's directory
 *   >> land                  say [land]
 * `{agent}` in an edit's text becomes the seat's git author name, so seats
 * given one instruction write different lines.
 * With no directive it says "ok".
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const opt = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
const cfg = {
  modes: flag("--modes"),
  autoEdit: flag("--auto-edit"),
  ids: !flag("--no-ids"),
  resume: flag("--resume"),
  load: flag("--load"),
  startDelay: Number(opt("--start-delay") ?? 0),
  failSession: opt("--fail-session"),
  stateDir: opt("--state-dir") ?? process.env.FAKE_AGENT_STATE ?? join(tmpdir(), "fake-agent-state"),
  strayReply: opt("--stray-reply"),
};

/** A reply nobody asked for, written after the current response has gone out. */
function strayReply(): void {
  if (!cfg.strayReply) return;
  setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: cfg.strayReply, result: {} }) + "\n"), 150);
}
mkdirSync(cfg.stateDir, { recursive: true });

interface State {
  cwd: string;
  mode: string;
  memory?: string;
  history: Array<{ role: "user" | "agent"; text: string }>;
}
const statePath = (id: string) => join(cfg.stateDir, `${id}.json`);
const loadState = (id: string): State | undefined =>
  existsSync(statePath(id)) ? (JSON.parse(readFileSync(statePath(id), "utf8")) as State) : undefined;
const saveState = (id: string, s: State) => writeFileSync(statePath(id), JSON.stringify(s));

const sessions = new Map<string, State>();
const pending = new Map<string, AbortController>();
let messageCounter = 0;

const AUTO_MODES = new Set(["auto", "acceptEdits", "bypassPermissions"]);

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    if (signal.aborted) return rej(new Error("cancelled"));
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      rej(new Error("cancelled"));
    });
  });
}

type Cx = { notify: acp.AgentContext["notify"]; request: acp.AgentContext["request"] };

async function chunk(cx: Cx, sessionId: string, text: string, messageId: string | null, signal: AbortSignal) {
  for (const word of text.split(" ")) {
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: word + " " }, messageId },
    });
    await sleep(2, signal);
  }
}

async function runPrompt(sessionId: string, text: string, cx: Cx, signal: AbortSignal): Promise<acp.StopReason> {
  const s = sessions.get(sessionId);
  if (!s) throw new Error(`unknown session ${sessionId}`);
  s.history.push({ role: "user", text });
  const directives = [...text.matchAll(/^(?:\[[^\]\n]+\]: )?>> (\w+)(?: (.*))?$/gm)].map((m) => ({ verb: m[1], arg: m[2] ?? "" }));
  // The doctor's real prompt: "Create a file named scratch.txt ... containing the single word hello ... reply ... done".
  const natural = /file named (\S+)[^\n]*?containing (?:the single word )?(\w+)/i.exec(text);
  if (directives.length === 0 && natural) directives.push({ verb: "edit", arg: `${natural[1]} ${natural[2]}` }, { verb: "say", arg: "done" });
  if (directives.length === 0) directives.push({ verb: "say", arg: "ok" });
  let said = "";
  const say = async (t: string) => {
    said += t + " ";
    await chunk(cx, sessionId, t, cfg.ids ? `m${++messageCounter}` : null, signal);
  };
  let toolN = 0;
  for (const d of directives) {
    switch (d.verb) {
      case "say":
        await say(d.arg);
        break;
      case "say2":
        await say(d.arg);
        break;
      case "think":
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: d.arg } },
        });
        break;
      case "pass":
        await say("[pass]");
        break;
      case "land":
        await say("[land]");
        break;
      case "commit":
        execFileSync("git", ["add", "-A"], { cwd: s.cwd });
        execFileSync("git", ["commit", "-q", "-m", d.arg], { cwd: s.cwd });
        await say("committed");
        break;
      case "mention": {
        const [name, ...rest] = d.arg.split(" ");
        await say(`@${name} ${rest.join(" ")}`);
        break;
      }
      case "remember":
        s.memory = d.arg;
        await say("remembered");
        break;
      case "recall":
        await say(s.memory ?? "nothing");
        break;
      case "sleep":
        await sleep(Number(d.arg), signal);
        await say("woke");
        break;
      case "run": {
        const id = `t${++toolN}`;
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: "tool_call", toolCallId: id, title: `Run: ${d.arg}`, kind: "execute", status: "in_progress" },
        });
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: id,
            status: "completed",
            content: [{ type: "content", content: { type: "text", text: `ran: ${d.arg}\nexit 0` } }],
          },
        });
        await say(`ran ${d.arg}`);
        break;
      }
      case "edit": {
        const [rel, ...rest] = d.arg.split(" ");
        const path = resolve(s.cwd, rel);
        const newText = rest.join(" ").replaceAll("{agent}", process.env.GIT_AUTHOR_NAME ?? "fake") + "\n";
        const oldText = existsSync(path) ? readFileSync(path, "utf8") : undefined;
        const id = `t${++toolN}`;
        const call = {
          toolCallId: id,
          title: `Edit ${rel}`,
          kind: "edit" as const,
          content: [{ type: "diff" as const, path, oldText: oldText ?? null, newText }],
          locations: [{ path }],
        };
        await cx.notify(acp.methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: "tool_call", ...call, status: "pending" },
        });
        let allowed = cfg.autoEdit || AUTO_MODES.has(s.mode);
        if (!allowed) {
          const res = await cx.request(acp.methods.client.session.requestPermission, {
            sessionId,
            toolCall: { ...call, status: "pending" },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "always", name: "Always allow", kind: "allow_always" },
              { optionId: "reject", name: "Deny", kind: "reject_once" },
            ],
          });
          if (res.outcome.outcome === "cancelled") return "cancelled";
          allowed = res.outcome.optionId === "allow" || res.outcome.optionId === "always";
        }
        if (allowed) {
          writeFileSync(path, newText);
          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: call.content },
          });
          await say(`edited ${rel}`);
        } else {
          await cx.notify(acp.methods.client.session.update, {
            sessionId,
            update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "failed" },
          });
          await say("edit refused");
        }
        break;
      }
      default:
        await say(`unknown directive ${d.verb}`);
    }
  }
  s.history.push({ role: "agent", text: said.trim() });
  saveState(sessionId, s);
  return "end_turn";
}

const modes = (): acp.SessionModeState | undefined =>
  cfg.modes
    ? {
        currentModeId: "auto",
        availableModes: [
          { id: "default", name: "Manual" },
          { id: "auto", name: "Auto" },
          { id: "acceptEdits", name: "Accept edits" },
        ],
      }
    : undefined;

async function main() {
  if (cfg.startDelay) await new Promise((r) => setTimeout(r, cfg.startDelay));
  const stream = acp.ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  );
  acp
    .agent({ name: "fake-agent" })
    .onRequest(acp.methods.agent.initialize, () => ({
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: { name: "fake-agent", version: "1.0.0" },
      agentCapabilities: {
        loadSession: cfg.load,
        sessionCapabilities: cfg.resume ? { resume: {} } : {},
      },
      authMethods: [],
    }))
    .onRequest(acp.methods.agent.session.new, (ctx) => {
      // A plain Error becomes a bare "Internal error" on the wire, as with real harnesses;
      // detail travels only as RequestError data. `auth` mimics a harness wanting a login.
      if (cfg.failSession === "auth") throw acp.RequestError.authRequired({ message: "run `fake login` first" });
      if (cfg.failSession) throw acp.RequestError.internalError({ message: cfg.failSession }, cfg.failSession);
      const sessionId = `fake-${Math.random().toString(36).slice(2, 10)}`;
      const s: State = { cwd: ctx.params.cwd, mode: cfg.modes ? "auto" : "default", history: [] };
      sessions.set(sessionId, s);
      saveState(sessionId, s);
      strayReply();
      return { sessionId, modes: modes() ?? null };
    })
    .onRequest(acp.methods.agent.session.setMode, (ctx) => {
      const s = sessions.get(ctx.params.sessionId);
      if (!s) throw new Error("unknown session");
      s.mode = ctx.params.modeId;
      saveState(ctx.params.sessionId, s);
      return {};
    })
    .onRequest(acp.methods.agent.session.resume, (ctx) => {
      if (!cfg.resume) throw new Error("resume not supported");
      const s = loadState(ctx.params.sessionId);
      if (!s) throw new Error("no such session");
      s.cwd = ctx.params.cwd;
      sessions.set(ctx.params.sessionId, s);
      return { modes: modes() ?? null };
    })
    .onRequest(acp.methods.agent.session.load, async (ctx) => {
      if (!cfg.load) throw new Error("load not supported");
      const s = loadState(ctx.params.sessionId);
      if (!s) throw new Error("no such session");
      s.cwd = ctx.params.cwd;
      sessions.set(ctx.params.sessionId, s);
      // Replay the history as updates, the way session/load specifies.
      for (const h of s.history) {
        await ctx.client.notify(acp.methods.client.session.update, {
          sessionId: ctx.params.sessionId,
          update: {
            sessionUpdate: h.role === "user" ? "user_message_chunk" : "agent_message_chunk",
            content: { type: "text", text: h.text },
          },
        });
      }
      return { modes: modes() ?? null };
    })
    .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
      const { sessionId } = ctx.params;
      const text = ctx.params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("");
      pending.get(sessionId)?.abort();
      const ac = new AbortController();
      pending.set(sessionId, ac);
      try {
        const stopReason = await runPrompt(sessionId, text, ctx.client, ac.signal);
        strayReply();
        return { stopReason };
      } catch (err) {
        if (ac.signal.aborted) return { stopReason: "cancelled" as const };
        throw err;
      } finally {
        pending.delete(sessionId);
      }
    })
    .onNotification(acp.methods.agent.session.cancel, (ctx) => {
      pending.get(ctx.params.sessionId)?.abort();
    })
    .connect(stream);
}

main().catch((err) => {
  process.stderr.write(`fake-agent: ${(err as Error).stack}\n`);
  process.exit(1);
});
