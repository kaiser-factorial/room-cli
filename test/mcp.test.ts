/**
 * The room's MCP tools: a seat mid-turn reads what was posted, posts, and
 * looks at the room. In-process seats calling the real HTTP server, then the
 * fake agent reaching it over HTTP and through the stdio bridge.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Room, type RoomUI } from "../src/room.js";
import type { McpEndpoint } from "../src/server/mcp.js";
import type { Seat, SeatConfig, SeatEvent } from "../src/seat/types.js";
import { fakeAcpSeat } from "./fixtures/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "room-mcp-"));
  dirs.push(d);
  return d;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rpc(url: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((res, rej) => {
    const req = request(url, { method: "POST", headers: { "Content-Type": "application/json" } }, (r) => {
      let t = "";
      r.setEncoding("utf8");
      r.on("data", (c: string) => (t += c));
      r.on("end", () => res({ status: r.statusCode ?? 0, body: t ? JSON.parse(t) : undefined }));
    });
    req.on("error", rej);
    req.end(JSON.stringify(body));
  });
}

type Call = (tool: string, args?: object) => Promise<string>;
type Reply = string | ((prompt: string, call: Call) => Promise<string>);

class ToolSeat implements Seat {
  readonly name: string;
  prompts: string[] = [];
  endpoint?: McpEndpoint;
  constructor(
    readonly config: SeatConfig,
    private readonly replies: Reply[],
  ) {
    this.name = config.name;
  }
  useMcp(e: McpEndpoint) {
    this.endpoint = e;
  }
  private call: Call = async (tool, args = {}) => {
    const r = await rpc(this.endpoint!.url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } });
    const res = r.body.result;
    return (res.isError ? "error: " : "") + res.content[0].text;
  };
  async start() {
    return { loadSession: false, authMethods: [] };
  }
  async newSession() {
    return `${this.name}-s`;
  }
  async *prompt(text: string): AsyncIterable<SeatEvent> {
    this.prompts.push(text);
    const next = this.replies.shift() ?? "[pass]";
    yield { type: "text", text: typeof next === "function" ? await next(text, this.call) : next };
    yield { type: "stop", stopReason: "end_turn" };
  }
  async cancel() {}
  async stop() {}
  stderrTail() {
    return "";
  }
}

function makeUI() {
  const ui: RoomUI & { lines: string[]; posts: string[] } = {
    lines: [],
    posts: [],
    seatEvent() {},
    askHuman: async () => "deny",
    status(l) {
      this.lines.push(l);
    },
    posted(seat, text) {
      this.posts.push(`${seat}: ${text}`);
    },
  };
  return ui;
}

async function openRoom(scripts: Record<string, Reply[]>, cwd = tmp(), git = false) {
  const ui = makeUI();
  const fakes = new Map<string, ToolSeat>();
  const room = await Room.open({
    name: "mcp",
    cwd,
    seats: Object.keys(scripts).map((name) => ({ name, adapter: "acp" as const, command: "x" })),
    human: "Corina",
    ui,
    git: git ? undefined : false,
    makeSeat: (c) => {
      const f = new ToolSeat(c, scripts[c.name]);
      fakes.set(c.name, f);
      return f;
    },
  });
  await room.start();
  return { room, fakes, ui };
}

const said = (room: Room) => room.transcript.entries.filter((e) => e.kind === "message").map((e) => `${e.from}: ${e.text}`);

describe("room MCP tools", () => {
  it("speaks MCP: initialize, tools/list, a bad token is refused", async () => {
    const { room, fakes } = await openRoom({ a: [] });
    const url = fakes.get("a")!.endpoint!.url;
    const init = await rpc(url, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.body.result.serverInfo.name).toBe("room");
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    expect((await rpc(url, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    const list = await rpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual(["inbox", "post", "status", "show", "diff"]);
    expect((await rpc(url.replace(/[0-9a-f]+$/, "00"), { jsonrpc: "2.0", id: 3, method: "ping" })).status).toBe(404);
    expect(fakes.get("a")!.prompts.length).toBe(0);
    await room.stop();
  });

  it("the preamble tells a seat with tools about them", async () => {
    const { room, fakes } = await openRoom({ a: ["hi"] });
    await room.say("@a hello");
    expect(fakes.get("a")!.prompts[0]).toContain("Room tools: you have an MCP server named `room`");
    await room.stop();
  });

  it("inbox shows what was posted during the turn, and the next turn does not repeat it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inbox = "";
    const { room, fakes } = await openRoom({
      a: [async (_p, call) => (await gate, (inbox = await call("inbox")), "read it"), "second"],
      b: ["b here"],
    });
    const first = room.say("@a start");
    await new Promise((r) => setTimeout(r, 20));
    const second = room.say("@b hi b, a is busy");
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([first, second]);
    expect(inbox).toBe("[Corina]: hi b, a is busy");
    await room.say("@a again");
    const p = fakes.get("a")!.prompts[1];
    expect(p).not.toContain("hi b, a is busy");
    expect(p).toContain("[b]: b here");
    expect(p).toContain("[Corina]: again");
    await room.stop();
  });

  it("post puts a message in the room now, and its tag wakes a seat", async () => {
    const { room, ui } = await openRoom({
      a: [async (_p, call) => `${await call("post", { text: "halfway there\n@b can you check the parser?" })} done`],
      b: ["parser is fine"],
    });
    await room.say("@a go");
    expect(said(room)).toEqual([
      "Corina: go",
      "a: halfway there\n@b can you check the parser?",
      "a: Posted. done",
      "b: parser is fine",
    ]);
    expect(ui.posts).toEqual(["a: halfway there\n@b can you check the parser?"]);
    expect(ui.lines).toContain("a → b");
    await room.stop();
  });

  it("post outside a turn is refused; status and show describe the room", async () => {
    let status = "";
    let show = "";
    const { room, fakes } = await openRoom({
      a: [async (_p, call) => ((status = await call("status")), (show = await call("show", { last: 1 })), "ok")],
      b: [],
    });
    await room.say("@a look around");
    expect(status).toContain("- a (you): answering");
    expect(status).toContain("- b: idle");
    expect(show).toMatch(/^#\d+ \[Corina\] message .*\nlook around$/);
    const url = fakes.get("b")!.endpoint!.url;
    const r = await rpc(url, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "post", arguments: { text: "x" } } });
    expect(r.body.result.isError).toBe(true);
    await room.stop();
  });

  it("diff shows a seat's unlanded work from its desk", async () => {
    const cwd = tmp();
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd });
    git("init", "-q", "-b", "main");
    writeFileSync(join(cwd, "f.txt"), "seed\n");
    git("add", "f.txt");
    git("commit", "-q", "-m", "seed");
    let diff = "";
    const { room } = await openRoom(
      {
        a: [async () => (writeFileSync(join(cwd, ".room", "mcp", "desks", "a", "f.txt"), "from a\n"), "edited")],
        b: [async (_p, call) => ((diff = await call("diff", { seat: "a" })), "seen")],
      },
      cwd,
      true,
    );
    await room.say("@a edit");
    await room.say("@b what did a do?");
    expect(diff).toContain("not on room/mcp yet");
    expect(diff).toContain("+from a");
    await room.stop();
  });
});

describe("room MCP tools through a real harness", () => {
  it("reach the fake agent over HTTP, and through the stdio bridge when it has no HTTP", async () => {
    const cwd = tmp();
    const ui = makeUI();
    const room = await Room.open({
      name: "mcpfake",
      cwd,
      seats: [fakeAcpSeat("h", ["--mcp-http"]), fakeAcpSeat("s")],
      human: "Corina",
      ui,
      git: false,
    });
    await room.start();
    await room.say('@h @s >> tool post {"text":"hello from a tool"}');
    const text = said(room);
    expect(text).toContain("h: hello from a tool");
    expect(text).toContain("s: hello from a tool");
    expect(text.filter((t) => /tool post: Posted\./.test(t)).length).toBe(2);
    await room.stop();
  }, 30_000);
});
