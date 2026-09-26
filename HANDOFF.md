# room: handoff

_Last updated 2026-09-26 (threads, step 1). Branch `feat/cli-room`, based on `feat/cli`._

Design doc (six phases, findings per phase): Claude Docs "Joint Session CLI
Design", https://claude.ai/code/artifact/8624261e-8ed2-45ea-ad01-d8b06166e1e1

## Status

| Phase | State |
| --- | --- |
| 0 spikes, `room doctor` | done |
| 1 sequential room, REPL, commit-per-turn, `/perm`, `/mode` | done |
| 2 CLI fallback adapter, personas, laguna seat | done (codex recipe untested live: usage limit until Sep 30) |
| adversarial pass | done (seats are untrusted; see README) |
| 3 hand-offs, passing, parallel mode | done |
| tool visibility (diffs, command output in the REPL) | done |
| 4 room as an ACP agent + resume | done; works in Zed (2026-09-25) |
| packaging: own pnpm package, `room` command | done; CI job `room` |
| 5 Ink TUI (`--tui`) | first version; REPL stays the default |
| 6 desks: a worktree per seat, landing on the trunk | done, with `[land]`/`/land`, background turns, `/auto` |
| threads step 1: event loop replaces rounds | done: wake rules, `@all`, `@seat!`, queue-at-end tags, `/cap`, `/wake`, echo pause |
| threads step 2: room MCP server (`inbox`, `post`, `status`, `show`, `diff`) | next |
| threads step 3: urgent interrupts polish, posting rate limits | later |

Tests: `pnpm install && pnpm test` in `packages/room`, 113 tests, run
anywhere with Node 22+. The room is no longer in the root's npm workspace:
it has its own `pnpm-lock.yaml` (pnpm 11, build scripts allowed in
`pnpm-workspace.yaml`), its own `vitest.config.ts`, and a `room` job in CI
(typecheck, tests, build). The web app is still npm. Install as a command
with `pnpm add -g link:$PWD`; pnpm 11 dropped `pnpm link --global`.
`test/fake-harness.test.ts` spawns real subprocesses that speak the real
protocol, which covers what the live checks on the owner's Mac cover:
handshake, modes, the permission round trip with diffs, command output,
cancel, resume via `session/resume` and `session/load`, the doctor's
verdicts, and the room end to end with a commit authored by a seat and a
restart that reattaches every seat. `test/acp-server.test.ts` spawns
`room acp` with fake seats and drives it as an editor: streaming,
permissions forwarded to the editor, cancel, session modes, load and
resume in a new process, a seat failing to start.

## Threads (step 1)

`room.ts` no longer runs rounds. `say()` posts at once and starts a
`Thread {queue, answering, wakes, held, hops}`; `pump()` starts turns.
Within a thread seats answer one at a time. Across threads turns run
concurrently only with desks (or in parallel mode); in one shared
directory a single turn runs at a time, so a second message queues behind
the running seat. `route()` applies hand-offs: tag joins the end of the
queue, no double queueing, mid-turn seats are not re-woken, the cap holds
extra wakes (`/cap +n` releases), and short back-and-forth is paused.
The REPL and TUI no longer await `say`; concurrent turns render through
`RoomUI.sideEvent`. Legacy tests opt into `wake: "all"`.

## Emulating the harnesses in the cloud

`test/fixtures/fake-agent.ts` is an ACP agent with switches for the quirks
met on each real harness. `test/fixtures/index.ts` builds seat configs for
it, so any test or a `.room.toml` can use it.

| Switch | Emulates |
| --- | --- |
| `--modes` | claude / hermes: advertises modes, starts in `auto` (auto-approves) until the room sets `default` |
| (none) | grok before the config fix: no modes, asks per edit |
| `--auto-edit` | agy: writes without asking |
| `--no-ids` | grok: no `messageId` on chunks |
| `--resume` / `--load` | reattach via `session/resume`, or `session/load` with a replayed history |
| `--start-delay <ms>` | hermes: slow startup |
| `--fail-session <msg>` | pool without Docker: `session/new` fails with the detail only in error data |
| `--fail-session auth` | a harness wanting a login (JSON-RPC -32000) |
| `--stray-reply <id>` | claude-agent-acp with skills: a reply to a request never made |

Directives in a prompt drive it (`>> say`, `>> edit <path> <text>`,
`>> run`, `>> remember` / `>> recall`, `>> sleep`, `>> pass`,
`>> mention <seat>`), and it understands the doctor's real prompt.
`test/fixtures/fake-claude` is a CLI harness in Claude Code's headless
argument and JSON shape, with resume, for the `cli` adapter.

A finding from building it: the SDK turns a plain thrown `Error` into a
bare "Internal error" on the wire, which is what pool and codex showed
earlier. Detail travels only as `RequestError` data; `describeError` in
`seat/acp.ts` folds it into messages now.

Real harnesses in the cloud: the two Zed adapters install from npm and the
Claude one runs on `ANTHROPIC_API_KEY` if present. grok, hermes, pool, agy:
Mac only.

Phase 4's ACP server is tested that way: `acp-server.test.ts` spawns
`room acp` with a roster of fake agents and drives it with a plain ACP
client. For a live check with the Claude seat, pin it to Sonnet to spare
the API key (`args = ["--model", ...]` or the adapter's env).

## Phase 4: what was built

- `src/server/acp.ts`, `room acp [seats...]`. Each editor session is a
  room named `acp-<time>-<id>`; that name is the ACP session id, so
  `session/load` (history replayed as user and agent chunks) and
  `session/resume` reopen `.room/<name>/` and reattach seats. Advertises
  `loadSession`, `sessionCapabilities.resume` and `close`.
- Seat text streams into one agent message, a paragraph per speaker
  (`**seat>** `); status lines are `[room] ...` paragraphs. Tool calls are
  forwarded with ids `${seat}:${turn}:${id}`, since harnesses reuse ids
  across turns. Permission requests go to the editor with allow, always
  (a room rule), deny; a cancelled answer cancels the turn.
- Status lines from `session/new` are held until just after the response,
  since the editor drops updates for a session id it does not know yet.
- Room modes (sequential, parallel) are the session's modes; `/parallel`
  and `/sequential` send `current_mode_update`. Slash commands are shared
  with the REPL (`src/commands.ts`) and advertised via
  `available_commands_update`.
- `Room.cancel()` cancels every running seat, drops the queue, and skips
  hand-offs; `say` and `continueRound` report `{ cancelled }`.
- `room resume <name> [seats...]`: refuses without `.room/<name>/state.json`;
  with no seats named, reopens the lineup saved in `state.seats`.

Tried in Zed on 2026-09-25 with claude and grok: startup lines, per-seat
paragraphs, and a hand-off to the human all rendered. VS Code's ACP
client is untried. The Zed settings shape in the README follows Zed's
external-agents docs (`"type": "custom"`).

## Feedback from the first live rooms (2026-09-25)

From grok, in a room with a rate-limited claude:
1. Skip a seat that keeps failing: done (benching, see README).
2. Show the next seat what the last turn did: done. Each turn's tool calls
   (`src/activity.ts`) reach the other seats from the room before its
   reply, and commit notes list files. Full diffs to other seats: open,
   with phase 6.
3. Scratch turns the room does not commit: open.
4. Wake the seat that started a background job when it finishes: open.

From Corina:
- Seats must be able to build on each other's changes (debugging one file
  together), so phase 6's worktrees need a way back to a shared tree, not
  only isolation for parallel rounds.
- Blank lines and colour between speakers: done.
- Watching a seat's loop live: done. The REPL used to drop thought chunks,
  so a thinking seat (grok) looked silent and then answered all at once;
  thoughts are shown, dimmed: one short line per stretch by default,
  `/thoughts full` to stream them. Tool calls are one line each (`/show n`
  for one in full, `/verbose` for everything).
- `room start` always opens a new room; a reopened room announces lineup
  changes (seats kept addressing hermes after it left).
- Seeing that someone is typing, and a richer layout: phase 5 (TUI).

## Phase 6: desks

Each seat works in a git worktree (`.room/<room>/desks/<seat>`, branch
`desk/<room>/<seat>`) and owns git there; the human's tree holds the trunk
`room/<room>`. `Room.syncDesk` merges the trunk into a desk before the
seat's turn; `Room.landDesk` commits leftovers as the seat and merges the
desk into the trunk after it, one trunk merge at a time (`withTrunk`). A
conflict is aborted and handed back to the seat as a note in its next
prompt. Every turn is committed on the desk as the seat (`closeTurn`);
nothing merges into the trunk until the seat's reply says `[land]` or the
human runs `/land` (`mergeDesk`). Parallel rounds may edit with desks. Seats
get `GIT_AUTHOR_*` and `GIT_COMMITTER_*` set to their name. A room opened
before desks starts its seats in fresh sessions in their desks.
`--no-desks` keeps the shared-directory mode, and its tests use it.

Decided with Corina: seats commit for themselves and the room commits
what they leave; auto-merging after every turn felt wrong (grok: "publish
is the default"), so seats land their own work with `[land]`.
Auto mode (`/auto`, `--auto`): unmatched tool calls are allowed without
asking; deny and ask rules still apply.

Background turns (`Room.startBackground`): from `/bg <seat> <task>` or a
seat's `[background] <task>` line. The seat leaves the rotation, its
events go to `RoomUI.backgroundEvent` (the REPL prints whole lines behind
a coloured gutter), its reply is recorded when it finishes and its desk
lands; a stopped or failed one is held. `LineSource` stacks prompts so a
background seat's permission question can sit over the human's prompt;
`ReplUI.askHuman` asks one question at a time. `stopBackground` keeps
cancelling until the turn ends, since a stop can arrive while the desk is
still syncing, before the seat has the prompt.

## Phase 5: the TUI

`src/ui/tui/`: `store.ts` turns room events into blocks (finished ones for
Ink's <Static>, so they go to real scrollback; live ones per seat, `seat` or
`seat#bg`), a per-seat "doing" line, and a queue of permission questions.
`app.tsx` renders it: live seat boxes showing their last 14 lines, a status
bar, and the input or a question bar. `run.tsx` connects a Room (TuiUI is
its RoomUI) and handles input, commands, and Ctrl+C. Tests render frames
with ink-testing-library; `pyte` in a pty was used to check real screens.
Not yet: input history, markdown rendering, a way to page through a long
live reply, and seats' prompts to one another shown as typing.

## Known warts

- Fixed: a failed turn's streamed text was recorded as the seat's message
  (claude's "You've hit your session limit" became a claude message grok
  quoted). A failed turn is now a room note, `a's turn failed: ...`, with
  anything the seat wrote before a real failure quoted inside it.
- Fixed: `Got response to unknown request skills-reload` over the prompt.
  claude-agent-acp, on a machine with skills, writes a reply to a request
  the room never made; the ACP library printed it raw, and it left the
  cursor on an empty line with no prompt until a key was pressed.
  `strayFilter` in `seat/acp.ts` drops such replies and non-JSON lines and
  reports each once as `[room] claude (claude-agent-acp) sent a reply ...`.
  Any line printed while the prompt is up now redraws the prompt with what
  was typed (`LineSource.write`). The fake agent's `--stray-reply <id>`
  reproduces it.

- Fixed: a seat's `[pass]` printed as `pass]` (hermes, 2026-09-25). Not
  cosmetic: `AcpSeat.prompt` raced `updates.next()` against the turn's end
  and left the losing waiter queued, so it swallowed the first update of
  the seat's next turn. With `[` gone, the reply was recorded as a message
  instead of a pass. `Chan.nextOr` withdraws the waiter; regression tests
  in `fake-harness.test.ts`.
- grok sends no `messageId`; a tool call between text runs now forces a
  paragraph break. Verified once.
- Codex recipe (`seat/cli-recipes.ts`) is unit-tested against sample
  output only.

## Owner-side facts that matter

- `~/.grok/config.toml` was changed on 2026-09-24 (backup beside it):
  `permission_mode = "default"` plus a `[permission] ask` table. Without
  both, grok auto-approves under ACP and drops writes silently under `-p`.
- `~/Projects/AGENT_JOURNAL/laguna/pool-laguna.sh` paths fixed (backup beside it).
- `antigravity-acp` (the agy seat's adapter) is an optional dependency: its
  postinstall needs bun, so an install without bun (CI) skips it rather
  than failing. The Mac has bun, so it installs there as before.
- Every agent has a persona at `~/Projects/AGENT_JOURNAL/<agent>/SOUL.md`;
  seats take one via `promptFile`.
