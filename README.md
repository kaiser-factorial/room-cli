# room

A terminal room for one human and several coding agents, over the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP).

The orchestrator is an ACP *client*. Each seat is an ACP agent subprocess
kept alive for the room: the harness holds that seat's memory, tools, and
context window; the room holds only the transcript and the session ids. When
a seat wants to do something gated, its `session/request_permission` is
forwarded to you. Nothing is auto-approved unless a seat's own config says so.

Design doc: *Joint Session CLI Design* (Claude Docs). This package is phase 0:
the spikes and the scaffold.

## Commands

```bash
npm run dev -- roster                 # the effective roster and where it came from
npm run dev -- doctor                 # handshake every seat, print a table
npm run dev -- doctor --deep          # also prove the permission round trip
npm run dev -- doctor grok pool --json
npm run dev -- spike claude "say hello and list the files here"
npx tsx scripts/two-seats.ts grok     # do two seats of one harness stay separate?
```

`doctor --deep` opens a session per seat in a scratch directory and asks it
to create one file, twice. The first turn is answered *allow* and must create
the file. The second, in a fresh session, is answered *deny* and must not.
A seat that writes without asking is reported as `edits-without-asking`.

Exit codes follow the ledger house style: `0` ok, `10` config, `20` a seat
failed to start, `30` auth needed, `40` protocol or turn failure, `50`
permission forwarding failed. The worst row wins.

## Roster

The roster is every seat you have set up. A room is the subset you name when
starting one; nothing joins by default. Search order: `--roster <file>`,
`.room.toml` in the working directory, `~/.config/room/roster.toml`, then the
built-in defaults for the six harnesses on this machine.

```toml
[[seats]]
name = "claude"
adapter = "acp"                 # "acp" (default) or "cli" (phase 2 fallback)
command = "claude-agent-acp"    # resolved on PATH plus the workspace .bin dirs
args = []
role = "critic"                 # a preset from the web app's roles.ts (phase 1)
allowAlways = []                # tool titles this seat may run without asking

[[seats]]
name = "pool"
command = "pool"
args = ["acp", "--sandbox", "disabled"]

[[seats]]
name = "agy"
command = "antigravity-acp"
[seats.env]
AGY_BIN = "/opt/homebrew/bin/agy"
```

## What phase 0 found

| Seat | ACP route | Round trip | Notes |
| --- | --- | --- | --- |
| claude | `@agentclientprotocol/claude-agent-acp` | ok | Reuses the Claude Code login. Starts in whatever `defaultMode` your Claude settings set (`auto` here), so the room switches it to `default` with `session/set_mode`. |
| codex | `@agentclientprotocol/codex-acp` | blocked | Handshake and sessions work; turns fail with the ChatGPT usage limit. Its ask mode is `read-only` ("Ask for approval"). |
| grok | `grok agent stdio` | ok, with config | Auto-approves unless `~/.grok/config.toml` has both `[ui] permission_mode = "default"` and `[permission] ask = ["Write(*)", "Edit(*)", "Bash(*)"]`. `always-approve` in the config overrides ask rules, and without ask rules grok inherits Claude Code's `defaultMode=auto`. Two seats get separate sessions. |
| hermes | `hermes acp` | ok | Loads every configured MCP server at startup, so it is the slowest to come up. |
| pool | `pool acp --sandbox disabled` | ok | The Docker sandbox fails when the daemon is down, which is what hung the Laguna daemon. |
| agy | `antigravity-acp` (community) | never asks | The adapter always runs agy with `--dangerously-skip-permissions`. Sandbox-only seat until agy grows a headless permission channel. |

All six advertise `loadSession`, so resume is on the table for every seat.
