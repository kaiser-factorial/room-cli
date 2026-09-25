/**
 * Desks: each seat in its own git worktree, landing on the room's trunk
 * after its turn. Real fake-agent subprocesses, a real repo.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Room, type RoomUI } from "../src/room.js";
import { fakeAcpSeat } from "./fixtures/index.js";

const dirs: string[] = [];
const tmp = (label: string) => {
  const d = mkdtempSync(join(tmpdir(), `room-desk-${label}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const cwd = tmp("repo");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(cwd, "calc.py"), "return a - b\n");
  git("add", "calc.py");
  git("commit", "-q", "-m", "seed");
  return { cwd, git };
}

function ui() {
  const u: RoomUI & { lines: string[] } = {
    lines: [],
    seatEvent() {},
    async askHuman() {
      return "deny";
    },
    status(line) {
      u.lines.push(line);
    },
  };
  return u;
}

async function open(cwd: string, state: string, extra: { mode?: "parallel" } = {}) {
  const seats = ["a", "b"].map((n) => fakeAcpSeat(n, [], state, { allow: ["edit"] }));
  const u = ui();
  const room = await Room.open({ name: "d", cwd, seats, human: "Corina", ui: u, ...extra });
  await room.start();
  return { room, u };
}

/** What a fake seat was last sent, from its saved session. */
function lastPrompt(state: string, sid: string): string {
  const s = JSON.parse(readFileSync(join(state, `${sid}.json`), "utf8")) as { history: Array<{ role: string; text: string }> };
  return s.history.filter((h) => h.role === "user").at(-1)!.text;
}

describe("desks", () => {
  it("gives each seat a worktree, lands its turn on the trunk, and the next seat builds on it", async () => {
    const { cwd, git } = repo();
    const { room } = await open(cwd, tmp("state"));
    const deskA = room.seatCwd("a");
    expect(deskA).toBe(join(cwd, ".room", "d", "desks", "a"));
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("room/d");
    await room.say("@a >> edit calc.py return a + b");
    // Written in a's desk, then landed on the trunk in the human's tree, as a.
    expect(readFileSync(join(cwd, "calc.py"), "utf8")).toBe("return a + b\n");
    expect(git("log", "-1", "--format=%an")).toBe("a");
    await room.say("@b >> say looking");
    expect(readFileSync(join(room.seatCwd("b"), "calc.py"), "utf8")).toBe("return a + b\n");
    // The human's tree never picked up the desks.
    expect(git("status", "--porcelain")).toBe("");
    await room.stop();
  }, 60_000);

  it("lands a seat's own commits as it made them, under its name", async () => {
    const { cwd, git } = repo();
    const { room } = await open(cwd, tmp("state"));
    await room.say("@a >> edit notes.md first draft\n>> commit notes: first draft, for b to review");
    expect(git("log", "-1", "--format=%an|%s")).toBe("a|notes: first draft, for b to review");
    expect(git("log", "--format=%s")).not.toMatch(/a: turn/);
    await room.stop();
  }, 60_000);

  it("keeps held work on the desk until a turn without [hold], or /land", async () => {
    const { cwd } = repo();
    const { room, u } = await open(cwd, tmp("state"));
    await room.say("@a >> edit wip.txt half done\n>> hold");
    expect(existsSync(join(cwd, "wip.txt"))).toBe(false);
    expect(existsSync(join(room.seatCwd("a"), "wip.txt"))).toBe(true);
    expect([...room.holding]).toEqual(["a"]);
    expect(u.lines.some((l) => /^a is holding its work on desk\/d\/a/.test(l))).toBe(true);
    // Still held after another held turn; nothing was committed for it.
    await room.say("@a >> edit wip.txt three quarters\n>> hold");
    expect(existsSync(join(cwd, "wip.txt"))).toBe(false);
    await room.land("a");
    expect(readFileSync(join(cwd, "wip.txt"), "utf8")).toBe("three quarters\n");
    expect(room.holding.size).toBe(0);
    await room.stop();
  }, 60_000);

  it("lets a parallel round edit, lands in order, and hands a conflict back to the later seat", async () => {
    const { cwd } = repo();
    const state = tmp("state");
    const { room, u } = await open(cwd, state, { mode: "parallel" });
    await room.say(">> edit calc.py return {agent}");
    // Both edited without being refused; a landed first, b's clashes.
    expect(u.lines.filter((l) => /deny by room/.test(l))).toEqual([]);
    expect(readFileSync(join(cwd, "calc.py"), "utf8")).toBe("return a\n");
    expect(u.lines).toContain("b's work conflicts with room/d in calc.py; it stays on desk/d/b until b merges room/d into it");
    expect(readFileSync(join(room.seatCwd("b"), "calc.py"), "utf8")).toBe("return b\n");
    // On b's next turn the room tells it to merge the trunk and resolve.
    room.setRoomMode("sequential");
    await room.say("@b >> say on it");
    expect(lastPrompt(state, room.state.sessions.b)).toContain(
      "[room]: room/d has changes that conflict with your branch in calc.py. Merge it (`git merge room/d`)",
    );
    await room.stop();
  }, 60_000);

  it("reopens a room with its desks and seats' sessions", async () => {
    const { cwd } = repo();
    const state = tmp("state");
    let { room } = await open(cwd, state);
    await room.say("@a >> edit calc.py return a * b");
    const desks = { ...room.state.desks };
    await room.stop();
    ({ room } = await open(cwd, state));
    expect(room.state.desks).toEqual(desks);
    expect(readFileSync(join(room.seatCwd("a"), "calc.py"), "utf8")).toBe("return a * b\n");
    await room.stop();
  }, 60_000);
});
