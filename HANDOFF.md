# room: handoff

_Last updated 2026-09-25. Branch `feat/cli-room`, based on `feat/cli`._

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
| tool visibility (diffs, command output in the REPL) | done, committed with this note |
| 4 room as an ACP agent + resume | **next**; resume half done (see below) |
| 5 Ink TUI | optional |
| 6 parallel edits with worktrees | later |

Tests: `npm test` in `packages/room`, 53 tests, run anywhere with Node.
45 use in-process fake seats. 8 (`test/fake-harness.test.ts`) spawn real
subprocesses that speak the real protocol, which covers what the live
checks on the owner's Mac cover: handshake, modes, the permission round
trip with diffs, command output, cancel, resume via `session/resume` and
`session/load`, the doctor's verdicts, and the room end to end with a
commit authored by a seat and a restart that reattaches every seat.

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

Phase 4's ACP server can be tested here by spawning `room acp` with a
roster of fake agents and driving it with `AcpSeat`, the same way
`fake-harness.test.ts` drives seats.

## Phase 4 plan

1. `src/server/acp.ts`, command `room acp [seats...] [--room-file f]`.
   `acp.agent({name:"room"})` over `ndJsonStream(process.stdout, process.stdin)`.
   All logging to stderr; stdout is the wire.
   - `initialize` → `{protocolVersion, agentInfo:{name:"room"}, agentCapabilities:{loadSession:false}, authMethods:[]}`
   - `session/new` → `Room.open({cwd: params.cwd, seats, ui: AcpServerUI})`, `start()`, return `sessionId`.
   - `session/prompt` → join text blocks; `/parallel` `/sequential` handled; else `room.say(text)`; return `{stopReason:"end_turn"}`.
   - `session/cancel` → cancel the active seat (Room needs `cancelActive()`; track the seat whose turn is running).
   - `AcpServerUI`: `seatEvent` text → `session/update` `agent_message_chunk` with a `seat> ` prefix at the first chunk of each turn; `tool_call`/`tool_update` forwarded with `toolCallId` namespaced `${seat}:${id}`; `status` → a chunk `\n[room] ...\n`; `askHuman` → `session/request_permission` to the client with options `allow_once`, `allow_always`, `reject_once`, mapped back to `HumanChoice`.
2. Resume: `Room.start` already reattaches seats via `Seat.resumeSession`
   (ACP: `session/resume` if advertised, else `session/load` with the
   replay drained; CLI: keeps the id). Seats that cannot get a fresh
   session and a full transcript replay (cursor cleared). Untested live.
   Add `room resume <name>` as an alias of `start` that refuses to open a
   room whose state dir does not exist.
3. Register in Zed (`agent_servers` in settings) and VS Code's ACP Client
   extension: command `npx tsx /path/to/packages/room/bin/room.ts acp claude grok`.

## Known warts

- In the REPL, a seat's `[pass]` reply once printed as `pass]` (hermes,
  2026-09-25). Not reproduced in isolation; check `sanitizeForTerminal`
  and the readline redraw. Cosmetic.
- grok sends no `messageId`; a tool call between text runs now forces a
  paragraph break. Verified once.
- Codex recipe (`seat/cli-recipes.ts`) is unit-tested against sample
  output only.

## Owner-side facts that matter

- `~/.grok/config.toml` was changed on 2026-09-24 (backup beside it):
  `permission_mode = "default"` plus a `[permission] ask` table. Without
  both, grok auto-approves under ACP and drops writes silently under `-p`.
- `~/Projects/AGENT_JOURNAL/laguna/pool-laguna.sh` paths fixed (backup beside it).
- Every agent has a persona at `~/Projects/AGENT_JOURNAL/<agent>/SOUL.md`;
  seats take one via `promptFile`.
