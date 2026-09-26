/**
 * The menu and what it stands on: settings and secrets, skills and MCP
 * servers found in the harnesses' configs, past rooms and archiving.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { findMcpServers, findSkills, frontmatter, harnessOf, readSkill, searchSkills, type Skill } from "../src/discover.js";
import { linkIgnored } from "../src/git.js";
import { archiveRoom, listRooms, readTranscript, recordRoom } from "../src/history.js";
import { Room, type RoomUI } from "../src/room.js";
import { applySecrets, loadSecrets, loadSettings, maskKey, saveOpenRouterKey, saveSettings } from "../src/settings.js";
import { Transcript } from "../src/transcript.js";
import { Menu, type MenuContext, type MenuResult } from "../src/ui/menu/menu.js";
import type { SeatConfig } from "../src/seat/types.js";

const dirs: string[] = [];
const tmp = (label = "x") => {
  const d = mkdtempSync(join(tmpdir(), `room-setup-${label}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("settings and secrets", () => {
  it("round-trip, and the key file is yours alone", () => {
    const env = { ROOM_CONFIG_DIR: tmp("cfg") } as NodeJS.ProcessEnv;
    expect(loadSettings(env)).toEqual({});
    saveSettings({ human: "Ana", seats: ["claude", "grok"], roles: { grok: "critic" }, personas: {}, cap: "off", shareMcp: ["linear"] }, env);
    expect(loadSettings(env)).toMatchObject({ human: "Ana", seats: ["claude", "grok"], roles: { grok: "critic" }, cap: "off", shareMcp: ["linear"] });
    saveOpenRouterKey("sk-or-v1-0123456789abcdef", env);
    expect(statSync(join(env.ROOM_CONFIG_DIR!, "secrets.toml")).mode & 0o777).toBe(0o600);
    expect(loadSecrets(env).openrouterApiKey).toBe("sk-or-v1-0123456789abcdef");
    applySecrets(env);
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-v1-0123456789abcdef");
    expect(maskKey(env.OPENROUTER_API_KEY)).toBe("sk-or-v1…cdef");
    saveOpenRouterKey(undefined, env);
    expect(loadSecrets(env).openrouterApiKey).toBeUndefined();
  });

  it("the environment's key wins over the saved one", () => {
    const env = { ROOM_CONFIG_DIR: tmp("cfg"), OPENROUTER_API_KEY: "from-env" } as NodeJS.ProcessEnv;
    saveOpenRouterKey("saved", env);
    applySecrets(env);
    expect(env.OPENROUTER_API_KEY).toBe("from-env");
  });
});

describe("discovery", () => {
  function home() {
    const h = tmp("home");
    const skill = (root: string, name: string, desc: string) => {
      mkdirSync(join(root, name), { recursive: true });
      writeFileSync(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: "${desc}"\n---\n# ${name}\nDo the thing.\n`);
    };
    skill(join(h, ".claude", "skills"), "pdf", "Read PDFs");
    skill(join(h, ".claude", "plugins", "acme", "skills"), "deploy", "Ship it");
    skill(join(h, ".codex", "skills"), "sql", "Query safely");
    writeFileSync(join(h, ".claude", "skills", "pdf", "forms.md"), "fill forms");
    writeFileSync(join(h, ".claude.json"), JSON.stringify({ mcpServers: { linear: { command: "npx", args: ["linear-mcp"], env: { T: "1" } } } }));
    mkdirSync(join(h, ".codex"), { recursive: true });
    writeFileSync(join(h, ".codex", "config.toml"), '[mcp_servers.docs]\nurl = "https://docs.example/mcp"\n');
    return h;
  }

  it("finds skills in every harness's folders, plugins included", () => {
    const h = home();
    const skills = findSkills({ home: h, cwd: tmp("cwd") });
    expect(skills.map((s) => `${s.harness}:${s.name}`).sort()).toEqual(["claude:deploy", "claude:pdf", "codex:sql"]);
    const pdf = skills.find((s) => s.name === "pdf")!;
    expect(pdf.description).toBe("Read PDFs");
    expect(readSkill(pdf)).toContain("Do the thing.");
    expect(readSkill(pdf)).toContain("- forms.md");
  });

  it("finds MCP servers in Claude's and Codex's configs", () => {
    const servers = findMcpServers({ home: home(), cwd: tmp("cwd") });
    expect(servers).toEqual([
      expect.objectContaining({ name: "linear", harness: "claude", command: "npx", args: ["linear-mcp"], env: { T: "1" } }),
      expect.objectContaining({ name: "docs", harness: "codex", url: "https://docs.example/mcp" }),
    ]);
  });

  it("reads front matter, and tells harnesses apart by command", () => {
    expect(frontmatter("---\nname: x\ndescription: 'y z'\n---\nbody")).toEqual({ name: "x", description: "y z" });
    expect(frontmatter("no front matter")).toEqual({});
    expect(harnessOf("claude-agent-acp")).toBe("claude");
    expect(harnessOf("antigravity-acp")).toBe("gemini");
  });
});

class ToolSeat {
  prompts: string[] = [];
  endpoint?: { url: string };
  extra: unknown[] = [];
  constructor(readonly config: SeatConfig) {}
  get name() {
    return this.config.name;
  }
  useMcp(e: { url: string }, extra: unknown[] = []) {
    this.endpoint = e;
    this.extra = extra;
  }
  async start() {
    return { loadSession: false, authMethods: [] };
  }
  async newSession() {
    return "s";
  }
  async *prompt(text: string) {
    this.prompts.push(text);
    yield { type: "text" as const, text: "ok" };
    yield { type: "stop" as const, stopReason: "end_turn" };
  }
  async cancel() {}
  async stop() {}
  stderrTail() {
    return "";
  }
}

describe("searchSkills", () => {
  const many: Skill[] = Array.from({ length: 381 }, (_, i) => ({
    name: i === 200 ? "pdf" : `skill-${i}`,
    description: i === 7 ? "Fill PDF forms from a template" : i === 200 ? "Read PDFs" : "x ".repeat(200),
    harness: i % 2 ? "claude" : "codex",
    dir: "/x",
  }));
  it("without a query: a count by harness and a short sample, never the whole list", () => {
    const out = searchSkills(many);
    expect(out).toMatch(/^381 skills \(191 from codex, 190 from claude\)\. Pass a query/);
    expect(out.split("\n").length).toBe(41);
    expect(out.length).toBeLessThan(6000);
  });
  it("a query matches all its words, names first", () => {
    expect(searchSkills(many, "pdf").split("\n").slice(1)).toEqual(["- pdf (codex): Read PDFs", "- skill-7 (claude): Fill PDF forms from a template"]);
    expect(searchSkills(many, "pdf template")).toContain("1 match");
    expect(searchSkills(many, "nothing-like-this")).toMatch(/^No skill matches/);
  });
});

describe("desks share the main checkout's ignored deps", () => {
  it("links node_modules and .env files git ignores, and nothing it tracks", async () => {
    const cwd = tmp("repo");
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd });
    git("init", "-q", "-b", "main");
    writeFileSync(join(cwd, ".gitignore"), "node_modules\n.env.local\n");
    mkdirSync(join(cwd, "node_modules", "x"), { recursive: true });
    mkdirSync(join(cwd, "packages", "app", "node_modules"), { recursive: true });
    writeFileSync(join(cwd, "packages", "app", "index.ts"), "");
    writeFileSync(join(cwd, ".env.local"), "K=1");
    writeFileSync(join(cwd, ".env.example"), "K=");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    const desk = join(cwd, ".room", "d", "desks", "a");
    git("worktree", "add", "-q", "-b", "desk/a", desk);
    const linked = await linkIgnored(cwd, desk);
    expect(linked.sort()).toEqual([".env.local", "node_modules", join("packages", "app", "node_modules")].sort());
    expect(existsSync(join(desk, "node_modules", "x"))).toBe(true);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: desk, encoding: "utf8" })).toBe("");
  });

  it("links a Python venv too, only what exists, and nothing when turned off", async () => {
    const cwd = tmp("py");
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd });
    git("init", "-q", "-b", "main");
    writeFileSync(join(cwd, ".gitignore"), ".venv\n");
    mkdirSync(join(cwd, ".venv", "lib"), { recursive: true });
    writeFileSync(join(cwd, "app.py"), "");
    git("add", "-A");
    git("commit", "-q", "-m", "seed");
    const desk = join(cwd, ".room", "d", "desks", "a");
    git("worktree", "add", "-q", "-b", "desk/a", desk);
    expect(await linkIgnored(cwd, desk, [])).toEqual([]);
    expect(await linkIgnored(cwd, desk)).toEqual([".venv"]);
  });
});

describe("sharing skills and MCP servers with every seat", () => {
  it("the room's skills tools list and serve them; shared servers skip their own harness", async () => {
    const h = tmp("home");
    mkdirSync(join(h, "skills", "pdf"), { recursive: true });
    writeFileSync(join(h, "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: Read PDFs\n---\nUse pdftotext.\n");
    const fakes = new Map<string, ToolSeat>();
    const ui: RoomUI = { seatEvent() {}, askHuman: async () => "deny", status() {} };
    const room = await Room.open({
      name: "share",
      cwd: tmp("cwd"),
      seats: [
        { name: "claude", adapter: "acp", command: "claude-agent-acp" },
        { name: "grok", adapter: "acp", command: "grok" },
      ],
      human: "Corina",
      ui,
      git: false,
      skills: [{ name: "pdf", description: "Read PDFs", harness: "claude", dir: join(h, "skills", "pdf") }],
      shareMcp: [{ name: "linear", harness: "claude", source: "x", command: "npx", args: ["linear-mcp"] }],
      makeSeat: (c) => {
        const f = new ToolSeat(c);
        fakes.set(c.name, f);
        return f as never;
      },
    });
    await room.start();
    expect(fakes.get("claude")!.extra).toEqual([]);
    expect(fakes.get("grok")!.extra).toEqual([expect.objectContaining({ name: "linear" })]);
    const call = async (tool: string, args: object = {}) => {
      const res = await fetch(fakes.get("grok")!.endpoint!.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
      });
      return ((await res.json()) as { result: { content: Array<{ text: string }> } }).result.content[0].text;
    };
    expect(await call("skills")).toBe("1 skills (1 from claude):\n- pdf (claude): Read PDFs");
    expect(await call("skill", { name: "PDF" })).toContain("Use pdftotext.");
    await room.say("@grok hi");
    expect(fakes.get("grok")!.prompts[0]).toContain("The room also shares 1 skill");
    await room.stop();
  });
});

describe("waking", () => {
  it("an untagged message wakes every seat by default, the first one included", async () => {
    const fakes = new Map<string, ToolSeat>();
    const room = await Room.open({
      name: "wake",
      cwd: tmp("cwd"),
      seats: [
        { name: "a", adapter: "acp", command: "x" },
        { name: "b", adapter: "acp", command: "x" },
      ],
      human: "Corina",
      ui: { seatEvent() {}, askHuman: async () => "deny", status() {} },
      git: false,
      tools: false,
      makeSeat: (c) => {
        const f = new ToolSeat(c);
        fakes.set(c.name, f);
        return f as never;
      },
    });
    await room.start();
    await room.say("hi all");
    await room.say("and again");
    expect(fakes.get("a")!.prompts.length).toBe(2);
    expect(fakes.get("b")!.prompts.length).toBe(2);
    await room.stop();
  });
});

describe("resuming", () => {
  class Resumable extends ToolSeat {
    async resumeSession() {
      return true;
    }
    get sessionId() {
      return "s1";
    }
  }
  async function openWith(cwd: string, seats: SeatConfig[], fakes: Map<string, ToolSeat>) {
    const room = await Room.open({
      name: "r",
      cwd,
      seats,
      human: "Corina",
      ui: { seatEvent() {}, askHuman: async () => "deny", status() {} },
      git: false,
      tools: false,
      makeSeat: (c) => {
        const f = new Resumable(c);
        fakes.set(c.name, f);
        return f as never;
      },
    });
    await room.start();
    return room;
  }

  it("a resumed seat is given the room's instructions again when they have changed, once", async () => {
    const cwd = tmp("cwd");
    let fakes = new Map<string, ToolSeat>();
    let room = await openWith(cwd, [{ name: "a", adapter: "acp", command: "x" }], fakes);
    await room.say("hello");
    expect(fakes.get("a")!.prompts[0]).toContain("You are a, one seat in a room");
    await room.stop();
    // Reopened with a role: the instructions differ, so the resumed session is told.
    fakes = new Map();
    room = await openWith(cwd, [{ name: "a", adapter: "acp", command: "x", role: "critic" }], fakes);
    await room.say("again");
    expect(fakes.get("a")!.prompts[0]).toMatch(/^\[room\]: The room's instructions have changed since your session began/);
    await room.say("and again");
    expect(fakes.get("a")!.prompts[1]).not.toContain("instructions have changed");
    await room.stop();
  });

  it("an old room whose trunk is checked out in your directory says how to move on", async () => {
    const cwd = tmp("repo");
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd });
    git("init", "-q", "-b", "main");
    writeFileSync(join(cwd, "f.txt"), "seed\n");
    git("add", "f.txt");
    git("commit", "-q", "-m", "seed");
    git("checkout", "-q", "-b", "room/r");
    const room = await Room.open({
      name: "r",
      cwd,
      seats: [{ name: "a", adapter: "acp", command: "x" }],
      human: "Corina",
      ui: { seatEvent() {}, askHuman: async () => "deny", status() {} },
      tools: false,
      makeSeat: (c) => new ToolSeat(c) as never,
    });
    await expect(room.start()).rejects.toThrow(/your checkout is on room\/r, the room's trunk .* Check out your own branch/);
  });
});

describe("past rooms", () => {
  async function aRoom(cwd: string, name: string, git = false) {
    const ui: RoomUI = { seatEvent() {}, askHuman: async () => "deny", status() {} };
    const room = await Room.open({
      name,
      cwd,
      seats: [{ name: "a", adapter: "acp", command: "x" }],
      human: "Corina",
      ui,
      git: git ? undefined : false,
      tools: false,
      makeSeat: (c) => new ToolSeat(c) as never,
    });
    await room.start();
    await room.say("@a hello there");
    await room.stop();
  }

  it("lists rooms here and indexed elsewhere, newest first, with the last thing said", async () => {
    const env = { ...process.env, ROOM_CONFIG_DIR: tmp("cfg") };
    const here = tmp("here");
    const there = tmp("there");
    await aRoom(here, "one");
    await aRoom(there, "two");
    recordRoom(there, "two", env);
    recordRoom(there, "two", env);
    expect(listRooms(here).map((r) => r.name)).toEqual(["one"]);
    const all = listRooms(here, { everywhere: true, env });
    expect(all.map((r) => r.name).sort()).toEqual(["one", "two"]);
    expect(all.find((r) => r.name === "one")).toMatchObject({ seats: ["a"], archived: false, last: "a: ok" });
  });

  it("archive gzips the transcript and removes desks; reading and resuming still work", async () => {
    const cwd = tmp("repo");
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd });
    git("init", "-q", "-b", "main");
    writeFileSync(join(cwd, "f.txt"), "seed\n");
    git("add", "f.txt");
    git("commit", "-q", "-m", "seed");
    await aRoom(cwd, "big", true);
    const desk = join(cwd, ".room", "big", "desks", "a");
    expect(existsSync(desk)).toBe(true);
    const before = readTranscript(cwd, "big").length;
    const { saved } = await archiveRoom(cwd, "big");
    expect(saved).toBeGreaterThan(0);
    expect(existsSync(desk)).toBe(false);
    expect(existsSync(join(cwd, ".room", "big", "transcript.jsonl.gz"))).toBe(true);
    expect(listRooms(cwd)[0]).toMatchObject({ archived: true, desks: 0 });
    expect(readTranscript(cwd, "big").length).toBe(before);
    expect(execFileSync("git", ["branch", "--list", "desk/big/a"], { cwd, encoding: "utf8" })).toContain("desk/big/a");
    // Opening it again unpacks the transcript and carries on counting.
    const t = Transcript.open(join(cwd, ".room", "big", "transcript.jsonl"));
    expect(t.entries.length).toBe(before);
    expect(t.append("Corina", "message", "back").id).toBe(before + 1);
  });
});

describe("the menu", () => {
  const roster: SeatConfig[] = [
    { name: "claude", adapter: "acp", command: "claude-agent-acp" },
    { name: "grok", adapter: "acp", command: "grok" },
  ];
  function ctx(over: Partial<MenuContext> = {}) {
    const saved: unknown[] = [];
    const keys: Array<string | undefined> = [];
    const c: MenuContext = {
      roster,
      roles: [
        { id: "critic", label: "Critic" },
        { id: "builder", label: "Builder" },
      ],
      settings: {},
      firstRun: false,
      skills: [{ name: "pdf", description: "Read PDFs", harness: "claude", dir: "/x" }],
      mcp: [{ name: "linear", harness: "claude", source: "x", command: "npx" }],
      rooms: () => [],
      transcript: () => [],
      archive: async () => ({ saved: 0 }),
      save: (s) => saved.push(s),
      saveKey: (k) => keys.push(k),
      cwd: "/w",
      ...over,
    };
    return { c, saved, keys };
  }
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const DOWN = "\u001b[B";
  const RIGHT = "\u001b[C";

  it("first run: pick seats and a role, save, and land on home", async () => {
    const { c, saved } = ctx({ firstRun: true });
    const r = render(<Menu ctx={c} onDone={() => undefined} />);
    await tick();
    expect(r.lastFrame()).toContain("Set up your room");
    for (const k of [DOWN, " ", DOWN, " ", RIGHT]) {
      r.stdin.write(k);
      await tick();
    }
    expect(r.lastFrame()).toMatch(/\[x\] grok\s+role: Critic/);
    // Down past wake, cap, TUI to Save.
    for (const k of [DOWN, DOWN, DOWN, DOWN, "\r"]) {
      r.stdin.write(k);
      await tick();
    }
    expect(saved).toEqual([{ seats: ["claude", "grok"], roles: { grok: "critic" } }]);
    expect(r.lastFrame()).toContain("Start a room (claude, grok)");
    r.unmount();
  });

  it("home: start returns start; the moderator screen saves a key", async () => {
    let result: MenuResult | undefined;
    const { c, keys } = ctx({ settings: { seats: ["claude"] } });
    const r = render(<Menu ctx={c} onDone={(x) => (result = x)} />);
    await tick();
    expect(r.lastFrame()).toContain("Skills & MCP (1 skills, 1 servers)");
    for (const k of [DOWN, DOWN, DOWN, "\r", DOWN, DOWN, "\r"]) {
      r.stdin.write(k);
      await tick();
    }
    expect(r.lastFrame()).toContain("OpenRouter API key");
    r.stdin.write("sk-or-v1-secretsecret");
    await tick();
    expect(r.lastFrame()).not.toContain("secretsecret");
    r.stdin.write("\r");
    await tick();
    expect(keys).toEqual(["sk-or-v1-secretsecret"]);
    expect(r.lastFrame()).toContain("OpenRouter key: sk-or-v1…cret");
    r.stdin.write("\u001b");
    await tick();
    r.stdin.write("\r");
    await tick();
    expect(result).toEqual({ action: "start" });
    r.unmount();
  });

  it("skills: toggling an MCP server to share, and saving", async () => {
    const { c, saved } = ctx();
    const r = render(<Menu ctx={c} onDone={() => undefined} />);
    await tick();
    for (const k of [DOWN, DOWN, DOWN, DOWN, "\r", DOWN, DOWN, " ", DOWN, "\r"]) {
      r.stdin.write(k);
      await tick();
    }
    expect(r.lastFrame()).toMatch(/\[x\] mcp linear/);
    expect(saved).toEqual([{ shareMcp: ["linear"] }]);
    r.unmount();
  });
});
