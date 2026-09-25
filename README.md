# room

A terminal room for one human and several coding agents, over the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP).

The orchestrator is an ACP *client*. Each seat is an ACP agent subprocess
kept alive for the room: the harness holds that seat's memory, tools, and
context window; the room holds only the transcript and the session ids. When
a seat wants to do something gated, its `session/request_permission` is
forwarded to you. Nothing is auto-approved unless a seat's own config says so.

Design doc: *Joint Session CLI Design* (Claude Docs). Phases 0 and 1 are
done: the doctor, and a sequential room with a streaming REPL.

## Commands

```bash
npm run dev -- start claude grok hermes        # open a room; nothing joins by default
npm run dev -- start --room-file rooms/review.toml
npm run dev -- roster                 # the effective roster and where it came from
npm run dev -- doctor                 # handshake every seat, print a table
npm run dev -- doctor --deep          # also prove the permission round trip
npm run dev -- doctor grok pool --json
npm run dev -- spike claude "say hello and list the files here"
npx tsx scripts/two-seats.ts grok     # do two seats of one harness stay separate?
npx tsx scripts/smoke.ts claude hermes grok pool --editor grok   # phase 1 acceptance run
```

## In the room

Each seat is one ACP session kept alive for the room. On its turn a seat gets
only what was said since its last turn, labeled `[name]: text`, plus the room
preamble on its first turn. Your message starts a round in roster order; a
leading `@seat` sends it to that seat only; an empty line runs another round
with nothing new. A seat replying `[pass]` is recorded as a pass. When the
working directory is a git repo the room checks out `room/<name>` and commits
after every turn that changed files, with the seat as author, so `git log`
and `git blame` say who did what. State lives in `.room/<name>/`
(transcript.jsonl, state.json), which the room keeps out of git.

```
Corina> look at hello.py and tell me what is wrong
  · claude: Read File [read]
claude> `hello.py:5` indexes names[i + 1] ...
grok> Same read: off-by-one on line 5.
Corina> @grok fix it
  · grok: search_replace
? grok wants: Edit `hello.py` [edit]
  [a] allow  [A] always (room rule)  [d] deny  [c] cancel turn > a
grok> Changed names[i + 1] to names[i].
  [room] grok committed 60c2ccf: 1 file changed, 1 insertion(+), 1 deletion(-)
```

### Permissions, two levers

**Room policy** works for every seat, because it sits in the orchestrator.
Rules match a tool call's kind (`read`, `edit`, `execute`, ...) or its title
with `*` wildcards. Deny beats ask beats allow; anything unmatched asks you.
Answering `A` at a prompt adds an allow rule for that kind. Rules persist in
the room's `state.json`, and can be pinned in the roster or a room file.

```
/perm grok                       show
/perm grok allow read            never ask grok before reads
/perm grok deny "Bash rm *"      never allow this, do not even ask
/unperm grok read
```

**Harness modes** are the seat's own permission setting, changed over ACP.
claude, hermes, and codex advertise them; the room switches each to its
asking mode at start (`default`, `default`, `read-only`), or to `mode` from
the config. grok and pool advertise none, so their config files are the lever.

```
/mode claude                     list modes, current marked
/mode claude acceptEdits
```

### Room file

```toml
seats = ["claude", "grok", "hermes"]

[modes]
claude = "default"

[roles]
grok = "critic"          # a preset from the web app's roles.ts

[policy.claude]
allow = ["read"]
[policy.grok]
deny = ["Bash rm *"]
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
role = "critic"                 # a preset from the web app's roles.ts
mode = "default"                # session mode to set at start, if advertised
allow = ["read"]                # room policy: kinds or title globs
ask = []
deny = ["Bash rm *"]

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
