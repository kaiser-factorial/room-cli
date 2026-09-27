/**
 * Hosted rooms: sessions running elsewhere join through `room mcp`, talk,
 * and are pinged by a hook, not interrupted.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import { harnessPid, memberships, type ProcInfo } from "../src/hub/client.js";
import { hookOutput } from "../src/hub/hook.js";
import { Hub, tagsIn } from "../src/hub/hub.js";
import { JoinServer } from "../src/hub/join.js";
import { withRoomHooks } from "../src/hub/setup.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

function scratchEnv(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "room-hub-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return { ...process.env, ROOM_CONFIG_DIR: dir };
}

async function hosted(name = "harness") {
  const env = scratchEnv();
  const hub = new Hub(name, "Corina", env);
  await hub.start();
  cleanup.push(() => hub.stop());
  // Each "session" is a JoinServer; pretend each runs under its own harness pid.
  let fakePid = 90_000;
  const session = () => {
    const pid = ++fakePid;
    const s = new JoinServer({ env, harness: () => pid });
    cleanup.push(() => s.leave());
    return s;
  };
  return { env, hub, session };
}

describe("hosted rooms", () => {
  it("tags: @name outside code, @all", () => {
    expect(tagsIn("@grok how is the adapter?", ["grok", "claude"])).toEqual(["grok"]);
    expect(tagsIn("see `@grok` in the code", ["grok"])).toEqual([]);
    expect(tagsIn("@all status?", ["grok"])).toEqual(["all"]);
    expect(tagsIn("mail me@grok.dev", ["grok"])).toEqual([]);
  });

  it("two sessions join, post, and read without either blocking", async () => {
    const { hub, session } = await hosted();
    const claude = session();
    const grok = session();
    expect(await claude.call("rooms", {})).toContain("harness (hosted by Corina)");
    expect(await claude.call("join", { as: "claude" })).toContain("Joined harness as claude");
    await grok.call("join", { as: "grok" });
    expect(await claude.call("post", { text: "@grok where is the adapter at?" })).toMatch(/^Posted \(#\d+\)\.$/);
    // grok is pinged, not blocked: it reads when it gets to it.
    expect(await grok.call("inbox", {})).toMatch(/\[claude\] → grok: @grok where is the adapter at\?/);
    expect(await grok.call("inbox", {})).toBe("Nothing new.");
    const reply = await grok.call("post", { text: "@claude streaming works; tool calls next" });
    expect(reply).toMatch(/^Posted/);
    hub.post("Corina", "nice, keep going");
    expect(await claude.call("post", { text: "thanks" })).toContain("2 unread in the room from grok, Corina");
    expect(await claude.call("who", {})).toContain("- claude (you): 2 unread");
  });

  it("a name taken gets a suffix; several rooms need a name to join", async () => {
    const { env, session } = await hosted("one");
    const other = new Hub("two", "Corina", env);
    await other.start();
    cleanup.push(() => other.stop());
    const a = session();
    await expect(a.call("join", { as: "claude" })).rejects.toThrow(/Several rooms are hosted/);
    await a.call("join", { as: "claude", room: "one" });
    const b = session();
    expect(await b.call("join", { as: "claude", room: "one" })).toContain("as claude2");
  });

  it("wait returns when someone posts, or when time is up", async () => {
    const { hub, session } = await hosted();
    const s = session();
    await s.call("join", { as: "claude" });
    const waiting = s.call("wait", { seconds: 5 });
    setTimeout(() => hub.post("Corina", "@claude done?"), 50);
    expect(await waiting).toContain("[Corina] → claude: @claude done?");
    expect(await s.call("wait", { seconds: 1 })).toMatch(/^Nothing in 1s/);
  }, 10_000);

  it("the hook: one quiet note per new message; Stop holds a turn once, only when tagged", async () => {
    const { env, hub, session } = await hosted();
    const s = session();
    await s.call("join", { as: "claude" });
    const me = s.membership!;
    // The hook runs under a shell under the harness.
    const info: ProcInfo = (pid) => (pid === 5 ? { ppid: 4, comm: "sh" } : pid === 4 ? { ppid: me.harnessPid, comm: "sh" } : pid === me.harnessPid ? { ppid: 1, comm: "claude" } : undefined);
    const deps = { env, self: 5, info };
    expect(await hookOutput("post-tool", {}, deps)).toBe("");
    hub.post("grok", "tool calls work now");
    const note = JSON.parse(await hookOutput("post-tool", {}, deps));
    expect(note.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(note.hookSpecificOutput.additionalContext).toContain("[room harness] 1 new message from grok. Latest: grok: tool calls work now.");
    expect(await hookOutput("post-tool", {}, deps)).toBe("");
    // Untagged: the turn may end.
    expect(await hookOutput("stop", {}, deps)).toBe("");
    hub.post("grok", "@claude can you rerun the probes?");
    const stop = JSON.parse(await hookOutput("stop", {}, deps));
    expect(stop.decision).toBe("block");
    expect(stop.reason).toContain("1 tagging you, @claude");
    expect(await hookOutput("stop", {}, deps)).toBe("");
    expect(await hookOutput("stop", { stop_hook_active: true }, deps)).toBe("");
    // Another session's hook finds nothing.
    expect(await hookOutput("post-tool", {}, { env, self: 7, info: () => ({ ppid: 1, comm: "zsh" }) })).toBe("");
    // Reading clears it.
    await s.call("inbox", {});
    hub.post("grok", "@claude also this");
    await s.call("inbox", {});
    expect(await hookOutput("post-tool", {}, deps)).toBe("");
    await s.call("leave", {});
    expect(memberships(env)).toEqual([]);
  });

  it("finds the harness past a shell or npx wrapping the MCP server", () => {
    const info: ProcInfo = (pid) => ({ 10: { ppid: 9, comm: "node" }, 9: { ppid: 8, comm: "npx" }, 8: { ppid: 7, comm: "sh" }, 7: { ppid: 1, comm: "claude" } })[pid];
    expect(harnessPid(10, info)).toBe(7);
  });

  it("setup adds the hooks once, and keeps the user's own", () => {
    const hook = ["/usr/bin/node", "/x/dist/src/hub/hook.js"];
    const mine = { matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] };
    const once = withRoomHooks({ model: "x", hooks: { PostToolUse: [mine] } }, hook);
    const twice = withRoomHooks(once, hook);
    expect(twice).toEqual(once);
    const post = (twice.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).PostToolUse;
    expect(post.map((e) => e.hooks[0].command)).toEqual(["my-linter", "/usr/bin/node /x/dist/src/hub/hook.js post-tool"]);
    expect(Object.keys(twice.hooks as object)).toEqual(["PostToolUse", "UserPromptSubmit", "Stop"]);
    expect(twice.model).toBe("x");
  });

  it("room mcp over stdio: a real process joins, and a real hook under it is pinged", async () => {
    const { env, hub } = await hosted();
    const tsx = join(process.cwd(), "node_modules", ".bin", "tsx");
    const child = spawn(tsx, [join(process.cwd(), "src", "hub", "join.ts")], { env, stdio: ["pipe", "pipe", "inherit"] });
    cleanup.push(() => void child.kill());
    const lines = createInterface({ input: child.stdout! });
    const replies = new Map<number, (v: { result: { content: Array<{ text: string }> } }) => void>();
    lines.on("line", (l) => {
      const m = JSON.parse(l);
      replies.get(m.id)?.(m);
    });
    let id = 0;
    const rpc = (method: string, params: object) =>
      new Promise<{ result: { content: Array<{ text: string }> } }>((resolve) => {
        replies.set(++id, resolve);
        child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    await rpc("initialize", { protocolVersion: "2025-06-18" });
    const joined = await rpc("tools/call", { name: "join", arguments: { as: "claude" } });
    expect(joined.result.content[0].text).toContain("Joined harness as claude");
    // A hook started under the MCP server's harness finds the membership.
    const m = memberships(env)[0];
    hub.post("grok", "@claude hello from grok");
    const note = await hookOutput("post-tool", {}, { env, self: m.pid });
    expect(JSON.parse(note).hookSpecificOutput.additionalContext).toContain("hello from grok");
    child.stdin!.end();
    await new Promise((r) => child.once("exit", r));
    expect(memberships(env)).toEqual([]);
    expect(hub.who()).toEqual([]);
  }, 20_000);
});

describe("setup for grok", () => {
  it("writes the server table into config.toml without touching the rest, and replaces its own on a rerun", async () => {
    const { withRoomTable, setupGrok } = await import("../src/hub/setup.js");
    const theirs = `model = "grok-4.5"\n\n[mcp_servers.linear]\ncommand = "npx"\nargs = ["linear-mcp"]\n`;
    const once = withRoomTable(theirs, ["/usr/bin/node", "/x/join.js"]);
    expect(once).toContain(`[mcp_servers.linear]\ncommand = "npx"`);
    expect(once).toContain(`[mcp_servers.room]\ncommand = "/usr/bin/node"\nargs = ["/x/join.js"]`);
    const again = withRoomTable(once, ["/opt/node", "/y/join.js"]);
    expect(again.match(/\[mcp_servers\.room\]/g)!.length).toBe(1);
    expect(again).toContain(`args = ["/y/join.js"]`);
    expect(again.startsWith(`model = "grok-4.5"`)).toBe(true);

    const env = scratchEnv();
    const home = join(env.ROOM_CONFIG_DIR!, "grok-home");
    const lines: string[] = [];
    await setupGrok({ grokHome: home, log: (l) => lines.push(l) });
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(home, "config.toml"), "utf8")).toContain("[mcp_servers.room]");
    const hooks = JSON.parse(readFileSync(join(home, "hooks", "room.json"), "utf8"));
    expect(Object.keys(hooks.hooks)).toEqual(["PostToolUse", "UserPromptSubmit", "Stop"]);
    const { findMcpServers } = await import("../src/discover.js");
    // The room's own server is never offered for sharing.
    expect(findMcpServers({ home: join(env.ROOM_CONFIG_DIR!, "nohome"), cwd: env.ROOM_CONFIG_DIR! }).some((m) => m.name === "room")).toBe(false);
  });

  it("the hook honours Grok's camelCase stopHookActive", async () => {
    const { env, hub, session } = await hosted();
    const s = session();
    await s.call("join", { as: "grok" });
    const me = s.membership!;
    const deps = { env, self: 5, info: ((pid: number) => (pid === 5 ? { ppid: me.harnessPid, comm: "sh" } : undefined)) as ProcInfo };
    hub.post("claude", "@grok ping");
    expect(await hookOutput("stop", { stopHookActive: true }, deps)).toBe("");
    expect(JSON.parse(await hookOutput("stop", {}, deps)).reason).toContain("use_tool room__inbox");
  });
});

describe("setup for antigravity", () => {
  it("writes one plugin: manifest, MCP server, PreInvocation and Stop hooks, and the room skill", async () => {
    const { setupAntigravity } = await import("../src/hub/setup.js");
    const { readFileSync } = await import("node:fs");
    const env = scratchEnv();
    const home = join(env.ROOM_CONFIG_DIR!, "home");
    await setupAntigravity({ home, log: () => undefined });
    const dir = join(home, ".gemini", "config", "plugins", "room");
    expect(JSON.parse(readFileSync(join(dir, "plugin.json"), "utf8")).name).toBe("room");
    expect(JSON.parse(readFileSync(join(dir, "mcp_config.json"), "utf8")).mcpServers.room.args[0]).toMatch(/hub[/\\]join\.js$/);
    const hooks = JSON.parse(readFileSync(join(dir, "hooks.json"), "utf8"));
    expect(Object.keys(hooks.room)).toEqual(["PreInvocation", "Stop"]);
    expect(hooks.room.PreInvocation[0].command).toMatch(/hook\.js invocation$/);
    expect(readFileSync(join(dir, "skills", "room", "SKILL.md"), "utf8")).toMatch(/^---\nname: room\n/);
    // Discovery sees the skill, and never offers the room's own server for sharing.
    const { findSkills, findMcpServers } = await import("../src/discover.js");
    expect(findSkills({ home, cwd: home }).some((k) => k.name === "room" && k.harness === "antigravity")).toBe(true);
    expect(findMcpServers({ home, cwd: home }).some((m) => m.name === "room")).toBe(false);
  });

  it("the invocation hook injects the note", async () => {
    const { env, hub, session } = await hosted();
    const s = session();
    await s.call("join", { as: "antigravity" });
    const me = s.membership!;
    hub.post("claude", "status?");
    const out = JSON.parse(await hookOutput("invocation", {}, { env, self: 5, info: (pid) => (pid === 5 ? { ppid: me.harnessPid, comm: "sh" } : undefined) }));
    expect(out.additionalContext).toContain("1 new message from claude");
  });
});
