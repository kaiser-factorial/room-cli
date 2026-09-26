/**
 * The seat adapter, the doctor, and the room against real subprocesses that
 * speak the real protocol: the fake ACP agent and the fake CLI harness in
 * test/fixtures. These run anywhere with Node, no harness or login needed,
 * and cover what the live checks on the owner's machine cover.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import { EXIT } from "../src/exit-codes.js";
import { Room, type RoomUI } from "../src/room.js";
import { AcpSeat, Chan, strayFilter } from "../src/seat/acp.js";
import type { PermissionRequestView, SeatEvent } from "../src/seat/types.js";
import { fakeAcpSeat, fakeCliSeat } from "./fixtures/index.js";

const dirs: string[] = [];
const tmp = (label: string) => {
  const d = mkdtempSync(join(tmpdir(), `room-fake-${label}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function collect(seat: AcpSeat, prompt: string): Promise<{ text: string; events: SeatEvent[]; stop: string }> {
  let text = "";
  let stop = "";
  const events: SeatEvent[] = [];
  for await (const ev of seat.prompt(prompt)) {
    events.push(ev);
    if (ev.type === "text") text += ev.text;
    if (ev.type === "stop") stop = ev.stopReason;
  }
  return { text: text.trim(), events, stop };
}

describe("AcpSeat against the fake agent", () => {
  it("handshakes, advertises modes, switches mode, and streams a reply", async () => {
    const seat = new AcpSeat(fakeAcpSeat("f", ["--modes"]), async () => "cancel");
    const info = await seat.start();
    expect(info.agentName).toBe("fake-agent");
    expect(info.loadSession).toBe(false);
    await seat.newSession(tmp("cwd"));
    expect(seat.modes?.current).toBe("auto");
    expect(seat.modes?.available.map((m) => m.id)).toEqual(["default", "auto", "acceptEdits"]);
    await seat.setMode("default");
    const r = await collect(seat, ">> say hello there");
    expect(r.text).toBe("hello there");
    expect(r.stop).toBe("end_turn");
    await seat.stop();
  }, 20_000);

  it("forwards a permission request with the diff, honors allow and deny", async () => {
    const cwd = tmp("cwd");
    const asked: PermissionRequestView[] = [];
    let answer: "allow" | "reject" = "allow";
    const seat = new AcpSeat(fakeAcpSeat("f"), async (req) => {
      asked.push(req);
      return answer;
    });
    await seat.start();
    await seat.newSession(cwd);
    const a = await collect(seat, ">> edit notes.txt hello world");
    expect(asked.length).toBe(1);
    expect(asked[0].kind).toBe("edit");
    expect(asked[0].content?.[0]).toMatchObject({ type: "diff", newText: "hello world\n" });
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("hello world\n");
    expect(a.text).toBe("edited notes.txt");
    const call = a.events.find((e) => e.type === "tool_call");
    expect(call).toMatchObject({ type: "tool_call", kind: "edit", title: "Edit notes.txt" });
    expect(call && call.type === "tool_call" ? call.content?.[0].type : undefined).toBe("diff");

    answer = "reject";
    const d = await collect(seat, ">> edit notes.txt changed");
    expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("hello world\n");
    expect(d.text).toBe("edit refused");
    expect(d.events.some((e) => e.type === "tool_update" && e.status === "failed")).toBe(true);
    await seat.stop();
  }, 20_000);

  it("boxes command output and breaks paragraphs around a tool call even without message ids", async () => {
    const seat = new AcpSeat(fakeAcpSeat("f", ["--no-ids"]), async () => "cancel");
    await seat.start();
    await seat.newSession(tmp("cwd"));
    const r = await collect(seat, ">> say first\n>> run ls\n>> say second");
    // No message ids: the only break is the one forced by the tool call.
    expect(r.text).toBe("first \n\nran ls second");
    const upd = r.events.find((e) => e.type === "tool_update");
    expect(upd && upd.type === "tool_update" ? upd.content?.[0] : undefined).toEqual({ type: "text", text: "ran: ls\nexit 0" });
    await seat.stop();
  }, 20_000);

  it("keeps the first chunk of every later turn (a leaked waiter once ate it: [pass] became pass])", async () => {
    const seat = new AcpSeat(fakeAcpSeat("f"), async () => "cancel");
    await seat.start();
    await seat.newSession(tmp("cwd"));
    expect((await collect(seat, ">> say first turn")).text).toBe("first turn");
    expect((await collect(seat, ">> pass")).text).toBe("[pass]");
    expect((await collect(seat, ">> say third turn")).text).toBe("third turn");
    await seat.stop();
  }, 20_000);

  it("drops a reply to a request it never made (claude's skills-reload), reports it once, and keeps working", async () => {
    const notices: string[] = [];
    const seat = new AcpSeat(fakeAcpSeat("f", ["--stray-reply", "skills-reload"]), async () => "cancel", (t) => notices.push(t));
    await seat.start();
    await seat.newSession(tmp("cwd"));
    expect((await collect(seat, ">> say one")).text).toBe("one");
    expect((await collect(seat, ">> say two")).text).toBe("two");
    await new Promise((r) => setTimeout(r, 300));
    expect(notices).toEqual(['sent a reply to a request the room never made ("skills-reload"), ignored; shown once']);
    await seat.stop();
  }, 20_000);

  it("cancels a slow turn", async () => {
    const seat = new AcpSeat(fakeAcpSeat("f"), async () => "cancel");
    await seat.start();
    await seat.newSession(tmp("cwd"));
    const turn = collect(seat, ">> sleep 5000");
    await new Promise((r) => setTimeout(r, 300));
    await seat.cancel();
    const r = await turn;
    expect(r.stop).toBe("cancelled");
    expect(r.text).toBe("");
    await seat.stop();
  }, 20_000);

  it("resumes a session in a new process via session/resume, and via session/load with the replay drained", async () => {
    for (const flag of ["--resume", "--load"]) {
      const state = tmp("state");
      const cwd = tmp("cwd");
      const first = new AcpSeat(fakeAcpSeat("f", [flag], state), async () => "cancel");
      await first.start();
      const sid = await first.newSession(cwd);
      expect((await collect(first, ">> remember pelican")).text).toBe("remembered");
      await first.stop();

      const second = new AcpSeat(fakeAcpSeat("f", [flag], state), async () => "cancel");
      await second.start();
      expect(await second.resumeSession(sid, cwd)).toBe(true);
      const r = await collect(second, ">> recall");
      expect(r.text).toBe("pelican");
      // Nothing from the replay leaked into this turn.
      expect(r.events.filter((e) => e.type === "text").map((e) => (e as { text: string }).text).join("")).toBe("pelican ");
      await second.stop();

      const cannot = new AcpSeat(fakeAcpSeat("f", [], state), async () => "cancel");
      await cannot.start();
      expect(await cannot.resumeSession(sid, cwd)).toBe(false);
      await cannot.stop();
    }
  }, 60_000);
});

describe("strayFilter", () => {
  it("passes protocol lines through, split anywhere, and drops strays once each", async () => {
    const notices: string[] = [];
    const f = strayFilter((t) => notices.push(t));
    const out: string[] = [];
    f.on("data", (c: Buffer) => out.push(c.toString()));
    const lines = [
      '{"jsonrpc":"2.0","id":0,"result":{}}',
      '{"jsonrpc":"2.0","id":"skills-reload","result":{}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{}}',
      "npm warn something",
      '{"jsonrpc":"2.0","id":"skills-reload","result":{}}',
      '{"jsonrpc":"2.0","id":"x","method":"session/request_permission","params":{}}',
    ].join("\n") + "\n";
    f.write(lines.slice(0, 50));
    f.write(lines.slice(50));
    f.end();
    await new Promise((r) => f.on("end", r));
    expect(out.join("").trim().split("\n")).toEqual([
      '{"jsonrpc":"2.0","id":0,"result":{}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{}}',
      '{"jsonrpc":"2.0","id":"x","method":"session/request_permission","params":{}}',
    ]);
    expect(notices).toEqual([
      'sent a reply to a request the room never made ("skills-reload"), ignored; shown once',
      "wrote a line that is not protocol, ignored: npm warn something",
    ]);
  });
});

describe("Chan", () => {
  it("withdraws a waiter when the race is lost, so the next item is not swallowed", async () => {
    const c = new Chan<number>();
    expect(await c.nextOr(Promise.resolve())).toBeUndefined();
    c.push(1);
    expect(await c.nextOr(new Promise(() => undefined))).toBe(1);
    const waiting = c.nextOr(new Promise(() => undefined));
    c.push(2);
    expect(await waiting).toBe(2);
  });
});

describe("doctor against fake harnesses", () => {
  it("passes an asking seat, flags an auto-editing one, reports a failed session, and checks a cli seat", async () => {
    const state = tmp("cli-state");
    const report = await runDoctor(
      [
        fakeAcpSeat("asks", ["--modes"]),
        fakeAcpSeat("yolo", ["--auto-edit"]),
        fakeAcpSeat("broken", ["--fail-session", "cannot connect to the sandbox daemon"]),
        fakeAcpSeat("needsauth", ["--fail-session", "auth"]),
        fakeCliSeat("cli", state),
      ],
      { deep: true, timeoutMs: 20_000, promptTimeoutMs: 20_000 },
    );
    const by = Object.fromEntries(report.rows.map((r) => [r.seat, r]));
    expect(by.asks.deep?.forwarding).toBe("ok");
    expect(by.asks.deep?.modes?.current).toBe("default"); // switched from auto to the asking mode
    expect(by.yolo.deep?.forwarding).toBe("edits-without-asking");
    expect(by.broken.started).toBe(true);
    expect(by.broken.deep?.forwarding).toBe("failed");
    expect(by.broken.error).toMatch(/sandbox daemon/);
    expect(by.needsauth.auth).toBe("needed");
    expect(by.needsauth.error).toMatch(/authentication required.*fake login/i);
    expect(by.needsauth.code).toBe(EXIT.AUTH);
    expect(by.cli.started).toBe(true);
    expect(by.cli.loadSession).toBe(true);
    expect(by.cli.hint).toMatch(/never forwards/);
    expect(report.code).toBe(EXIT.PERMISSIONS);
  }, 60_000);
});

describe("Room against fake harnesses", () => {
  function ui(answers: Array<"allow" | "allow_always" | "deny"> = []) {
    const u: RoomUI & { asked: string[]; lines: string[]; text: Record<string, string> } = {
      asked: [],
      lines: [],
      text: {},
      seatEvent(seat, ev) {
        if (ev.type === "text") u.text[seat] = (u.text[seat] ?? "") + ev.text;
      },
      async askHuman(req) {
        u.asked.push(`${req.seat}: ${req.title}`);
        return answers.shift() ?? "deny";
      },
      status(line) {
        u.lines.push(line);
      },
    };
    return u;
  }

  it("runs a discussion, a hand-off, and an approved edit that is committed under the seat's name", async () => {
    const cwd = tmp("repo");
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(cwd, "calc.py"), "return a - b\n");
    git("add", "calc.py");
    git("commit", "-q", "-m", "seed");
    const u = ui(["allow"]);
    const room = await Room.open({
      wake: "all",
      name: "fake",
      cwd,
      seats: [fakeAcpSeat("a", ["--modes"]), fakeAcpSeat("b")],
      human: "Corina",
      ui: u,
    });
    await room.start();
    expect(room.state.modes.a).toBe("default");
    await room.say("@a >> mention b what do you think");
    // a tags b, which wakes b after it.
    expect(room.transcript.entries.filter((e) => e.kind === "message").map((e) => e.from)).toEqual(["Corina", "a", "b"]);
    expect(u.lines).toContain("a → b");

    await room.say("@b >> edit calc.py return a + b\n>> land");
    expect(u.asked).toEqual(["b: Edit calc.py"]);
    expect(readFileSync(join(room.trunkDir, "calc.py"), "utf8")).toBe("return a + b\n");
    expect(git("log", "-1", "--format=%an %s", "room/fake")).toMatch(/^b b: turn/);
    expect(room.transcript.entries.at(-1)).toMatchObject({ kind: "commit", text: expect.stringMatching(/^b landed 1 commit on room\/fake /) });
    await room.stop();
  }, 60_000);

  it("refuses edits in a parallel round without asking, and resumes seats across a restart", async () => {
    const cwd = tmp("cwd");
    const state = tmp("state");
    const u = ui();
    const seats = [fakeAcpSeat("a", ["--resume"], state), fakeAcpSeat("b", ["--load"], state), fakeCliSeat("c", state)];
    let room = await Room.open({ name: "res", cwd, seats, human: "Corina", ui: u, git: false, mode: "parallel", wake: "all" });
    await room.start();
    await room.say(">> edit x.txt nope");
    expect(u.asked).toEqual([]);
    // The two ACP seats asked and were refused by the room. The CLI seat cannot ask, so it wrote,
    // and the room said so up front.
    expect(u.lines.filter((l) => /deny by room/.test(l)).length).toBe(2);
    expect(u.lines).toContain("c is a cli seat: its edits cannot be refused, only asked for in the prompt");
    expect(u.text.a.trim()).toBe("edit refused");
    expect(u.text.b.trim()).toBe("edit refused");
    expect(existsSync(join(cwd, "x.txt"))).toBe(true);
    room.setRoomMode("sequential");
    await room.say(">> remember marmalade");
    const sessions = { ...room.state.sessions };
    await room.stop();

    room = await Room.open({ name: "res", cwd, seats, human: "Corina", ui: ui(), git: false, wake: "all" });
    await room.start();
    expect(room.state.sessions).toEqual(sessions);
    expect(room.opts.ui === u).toBe(false);
    await room.say(">> recall");
    const last = room.transcript.entries.slice(-3);
    expect(last.map((e) => `${e.from}:${e.text}`)).toEqual(["a:marmalade", "b:marmalade", "c:marmalade"]);
    await room.stop();
  }, 60_000);
});
