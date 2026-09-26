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
  const room = await Room.open({ name: "d", cwd, seats, human: "Corina", ui: u, wake: "all", ...extra });
  await room.start();
  return { room, u };
}

/** What a fake seat was last sent, from its saved session. */
function lastPrompt(state: string, sid: string): string {
  const s = JSON.parse(readFileSync(join(state, `${sid}.json`), "utf8")) as { history: Array<{ role: string; text: string }> };
  return s.history.filter((h) => h.role === "user").at(-1)!.text;
}

describe("desks", () => {
  it("gives each seat a worktree, lands its work when it says [land], and the next seat builds on it", async () => {
    const { cwd, git } = repo();
    const { room } = await open(cwd, tmp("state"));
    const deskA = room.seatCwd("a");
    expect(deskA).toBe(join(cwd, ".room", "d", "desks", "a"));
    // Your checkout stays on your branch; the trunk has its own worktree.
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(room.trunkDir).toBe(join(cwd, ".room", "d", "trunk"));
    await room.say("@a >> edit calc.py return a + b\n>> land");
    // Written in a's desk, then landed on the trunk in the human's tree, as a.
    expect(readFileSync(join(room.trunkDir, "calc.py"), "utf8")).toBe("return a + b\n");
    expect(git("log", "-1", "--format=%an", "room/d")).toBe("a");
    expect(readFileSync(join(cwd, "calc.py"), "utf8")).toBe("return a - b\n");
    // b's desk is not touched: it is told, and merges when it is ready.
    await room.say("@b >> say looking");
    const showB = (ref: string) => execFileSync("git", ["show", `${ref}:calc.py`], { cwd: room.seatCwd("b"), encoding: "utf8" });
    expect(showB("HEAD")).toBe("return a - b\n");
    execFileSync("git", ["checkout", "-q", "--", "."], { cwd: room.seatCwd("b") });
    execFileSync("git", ["merge", "-q", "room/d"], { cwd: room.seatCwd("b"), env: { ...process.env, GIT_AUTHOR_NAME: "b", GIT_AUTHOR_EMAIL: "b@room", GIT_COMMITTER_NAME: "b", GIT_COMMITTER_EMAIL: "b@room" } });
    expect(showB("HEAD")).toBe("return a + b\n");
    // The human's tree never picked up the desks.
    expect(git("status", "--porcelain")).toBe("");
    await room.stop();
  }, 60_000);

  it("lands a seat's own commits as it made them, under its name", async () => {
    const { cwd, git } = repo();
    const { room } = await open(cwd, tmp("state"));
    await room.say("@a >> edit notes.md first draft\n>> commit notes: first draft, for b to review\n>> land");
    expect(git("log", "-1", "--format=%an|%s", "room/d")).toBe("a|notes: first draft, for b to review");
    expect(git("log", "--format=%s", "room/d")).not.toMatch(/a: turn/);
    await room.stop();
  }, 60_000);

  it("leaves a turn's work on the desk as it was, and lands nothing until [land] or /land", async () => {
    const { cwd, git } = repo();
    const { room } = await open(cwd, tmp("state"));
    await room.say("@a >> edit wip.txt half done");
    // Nothing committed for the seat: its work in progress stays in progress.
    expect(existsSync(join(cwd, "wip.txt"))).toBe(false);
    expect(readFileSync(join(room.seatCwd("a"), "wip.txt"), "utf8")).toBe("half done\n");
    expect(git("log", "-1", "--format=%s", "desk/d/a")).toBe("seed");
    await room.say("@a >> edit wip.txt three quarters");
    expect(existsSync(join(cwd, "wip.txt"))).toBe(false);
    // /land commits what is left, as a, and merges it.
    await room.land("a");
    expect(readFileSync(join(room.trunkDir, "wip.txt"), "utf8")).toBe("three quarters\n");
    expect(git("log", "-2", "--format=%an|%s", "desk/d/a").split("\n")[0]).toMatch(/^a\|a: uncommitted work/);
    expect(await room.unlanded("a")).toBe(0);
    await room.stop();
  }, 60_000);

  it("never merges the trunk into a desk: the seat is told what is new", async () => {
    const { cwd } = repo();
    const state = tmp("state");
    const { room } = await open(cwd, state);
    await room.say("@a >> edit calc.py return a * b\n>> land");
    await room.say("@b >> say hi");
    expect(execFileSync("git", ["show", "HEAD:calc.py"], { cwd: room.seatCwd("b"), encoding: "utf8" })).toBe("return a - b\n");
    const p = lastPrompt(state, room.state.sessions.b);
    expect(p).toMatch(/\[room\]: room\/d has \d+ commits? your branch does not:/);
    expect(p).toContain("- a: a: turn");
    expect(p).toContain("`git merge room/d` when you are ready");
    await room.stop();
  }, 60_000);

  it("lets a parallel round edit, lands in order, and hands a conflict back to the later seat", async () => {
    const { cwd } = repo();
    const state = tmp("state");
    const { room, u } = await open(cwd, state, { mode: "parallel" });
    await room.say(">> edit calc.py return {agent}\n>> land");
    // Both edited without being refused; a landed first, b's clashes.
    expect(u.lines.filter((l) => /deny by room/.test(l))).toEqual([]);
    expect(readFileSync(join(room.trunkDir, "calc.py"), "utf8")).toBe("return a\n");
    expect(u.lines).toContain("b's work conflicts with room/d in calc.py; it stays on desk/d/b until b merges room/d into it");
    expect(readFileSync(join(room.seatCwd("b"), "calc.py"), "utf8")).toBe("return b\n");
    // On b's next turn the room tells it what the trunk has; merging and resolving is b's.
    room.setRoomMode("sequential");
    await room.say("@b >> say on it");
    expect(lastPrompt(state, room.state.sessions.b)).toContain("`git merge room/d` when you are ready");
    await room.stop();
  }, 60_000);

  it("brings your branch into the trunk as you commit, and /sync brings landed work back", async () => {
    const { cwd, git } = repo();
    const { room, u } = await open(cwd, tmp("state"));
    // You commit on your own branch while the room is open; the next turn starts from a trunk that has it.
    writeFileSync(join(cwd, "notes.md"), "mine\n");
    git("add", "notes.md");
    git("commit", "-q", "-m", "human: notes");
    await room.say("@a >> edit calc.py return a + b\n>> land");
    expect(u.lines.some((l) => /^Corina's main came into room\/d: 1 commit/.test(l))).toBe(true);
    expect(readFileSync(join(room.trunkDir, "notes.md"), "utf8")).toBe("mine\n");
    expect(u.lines).toContain("room/d is 2 commits ahead of your main; /sync brings them into it");
    // Uncommitted work of yours is named, and never taken.
    writeFileSync(join(cwd, "scratch.txt"), "draft");
    await room.say("@a >> say ok");
    expect(u.lines.some((l) => /your checkout has uncommitted changes \(scratch\.txt\)/.test(l))).toBe(true);
    expect(await room.syncOut()).toBe("main now has the room's work: 2 commits from room/d");
    expect(readFileSync(join(cwd, "calc.py"), "utf8")).toBe("return a + b\n");
    expect(git("rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    await room.stop();
  }, 60_000);

  it("leaves a conflict between your branch and the trunk to you", async () => {
    const { cwd, git } = repo();
    const { room, u } = await open(cwd, tmp("state"));
    await room.say("@a >> edit calc.py return a + b\n>> land");
    writeFileSync(join(cwd, "calc.py"), "return a * b\n");
    git("commit", "-qam", "human: multiply");
    await room.say("@b >> say ok");
    expect(u.lines.some((l) => /^Corina's main conflicts with room\/d in calc\.py, so the room did not bring it in\. To resolve: cd .*trunk && git merge main$/.test(l))).toBe(true);
    expect(readFileSync(join(room.trunkDir, "calc.py"), "utf8")).toBe("return a + b\n");
    await room.stop();
  }, 60_000);

  it("reopens a room with its desks and seats' sessions", async () => {
    const { cwd } = repo();
    const state = tmp("state");
    let { room } = await open(cwd, state);
    await room.say("@a >> edit calc.py return a * b\n>> land");
    const desks = { ...room.state.desks };
    await room.stop();
    ({ room } = await open(cwd, state));
    expect(room.state.desks).toEqual(desks);
    expect(readFileSync(join(room.seatCwd("a"), "calc.py"), "utf8")).toBe("return a * b\n");
    await room.stop();
  }, 60_000);
});
