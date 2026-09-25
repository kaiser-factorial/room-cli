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

Tests: `npm test` in `packages/room`, 45 tests, all fake-seat based, run
anywhere with Node. The live checks (`scripts/smoke*.ts`, `room doctor
--deep`) need the harness CLIs and their logins, which exist only on the
owner's Mac.

## What the cloud can and cannot test

- Unit tests: yes.
- `room doctor` shallow: only for harnesses installed there. The two Zed
  adapters (`@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`)
  install from npm; the Claude one runs on `ANTHROPIC_API_KEY` if present.
  grok, hermes, pool, agy: Mac only.
- Phase 4's ACP server: testable anywhere once there is a fake ACP agent
  fixture. Build one with the SDK's `acp.agent()` (see
  `node_modules/@agentclientprotocol/sdk/dist/examples/agent.js`) that
  replies from a script and asks permission on demand; then a test can
  spawn `room acp` with a roster of fake agents and drive it with `AcpSeat`.

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
