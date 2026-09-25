# room

A terminal room for one human and several coding agents, over the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP).

The orchestrator is an ACP *client*. Each seat is an ACP agent subprocess
kept alive for the room: the harness holds that seat's memory, tools, and
context window; the room holds only the transcript and the session ids. When
a seat wants to do something gated, its `session/request_permission` is
forwarded to you. Nothing is auto-approved unless a seat's own config says so.

Design doc: *Joint Session CLI Design* (Claude Docs). Phases 0 to 4 are
done: the doctor, a room with a streaming REPL, the CLI fallback adapter,
seats that address each other, pass, and answer in parallel, and the room
served to an editor as an ACP agent, with resume.

## Install

The room is a pnpm package of its own, outside the web app's npm
workspace. It needs Node 22 or newer and pnpm 10 (`corepack enable`, or
`brew install pnpm`). pnpm keeps one content-addressed store per machine,
so the adapters' dependencies take disk space once however many checkouts
use them.

```bash
cd packages/room
pnpm install && pnpm build
pnpm link --global        # `room` on PATH, running this checkout; rebuild after pulling
```

The first global link asks for `pnpm setup` once (it adds `PNPM_HOME` to your
shell profile). For an install that does not follow the checkout, the way a
pip install would not: `pnpm pack`, then `pnpm add -g ./local-room-0.0.1.tgz`.

The claude, codex, and agy adapters ship with the room, so `room` finds
them from anywhere. Seats with their own binaries (grok, hermes, pool) come
from your PATH. agy's adapter is optional: its install script needs bun,
and pnpm does not run it anyway; the room points it at your own `agy`.

## Commands

```bash
room start claude grok hermes        # open a room; nothing joins by default
room start --room-file rooms/review.toml
room resume main                     # reopen a saved room with the seats it had
room acp claude grok                 # serve the room to an editor over ACP on stdio
room roster                          # the effective roster and where it came from
room doctor                          # handshake every seat, print a table
room doctor --deep                   # also prove the permission round trip
room doctor grok pool --json
room spike claude "say hello and list the files here"
pnpm dev start claude grok           # from a checkout, without building
pnpm exec tsx scripts/two-seats.ts grok     # do two seats of one harness stay separate?
pnpm exec tsx scripts/smoke.ts claude hermes grok pool --editor grok   # phase 1 acceptance run
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

### Who speaks next

- **Sequential** (default): your message starts a round in roster order.
- **Hand-offs:** a seat that writes `@name` on the first or last line of
  its reply puts that seat next, ahead of the rest of the round. A mention
  in the middle ("as @grok said") is a citation and does nothing, so a seat
  cannot steer the room from inside its prose. `@<you>` is announced and
  does not cut the other seats off. Mentions inside code do not count. At
  most six extra turns per human message, so two seats cannot volley
  forever.
- **Passing:** a seat replying `[pass]` is recorded as a pass. An empty
  line runs another round, skipping any seat that passed and has seen
  nothing new since.
- **Parallel** (`/parallel`, `/sequential`, or `--parallel`): every queued
  seat answers the same snapshot at once, replies are shown one seat at a
  time, and each seat sees the others' replies next round. File edits,
  deletes, moves, and shell commands are refused by the room during a
  parallel round without asking you, because several seats writing one
  working directory at once would collide. Hand-offs from a parallel batch
  run afterwards.

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

### Seats are untrusted

A seat's reply is data. Lines in it that look like `[name]:` labels are
quoted before the next seat sees them, so a seat cannot speak as you or as
the room. Escape sequences and control characters are stripped before
anything reaches your terminal. A seat that commits on its own despite the
preamble is noticed and written into the transcript. Room policy trusts the
harness's classification of a tool call (`edit`, `execute`, ...), which the
harness sets, not the model.

### Personas

A seat can carry an identity on top of its role: `prompt` is inline text,
`promptFile` is a file such as one of the `SOUL.md` files in
`~/Projects/AGENT_JOURNAL/<agent>/`. Both are appended to the preamble on the
seat's first turn. The default roster's `laguna` seat is pool wearing
`AGENT_JOURNAL/laguna/SOUL.md`.

### The CLI fallback adapter

`adapter = "cli"` runs a harness process per turn instead of an ACP session,
resumes by the session id the harness returns, and parses its JSON output.
No streaming, and no forwarded permissions: the recipe's unattended flags
decide what the harness may do, and the room policy never sees a request.
Use it when a seat's ACP route breaks, or for a harness with no ACP route.

| Recipe | Runs | Resume | Unattended with |
| --- | --- | --- | --- |
| claude | `claude -p --output-format json` | `--resume <id>` | `--permission-mode acceptEdits` |
| grok | `grok -p <prompt> --output-format json` | `-r <id>` | `--always-approve`: with ask rules in its config, headless grok silently drops writes under any other setting while still claiming it edited. Unsandboxed, so prefer grok over ACP |
| agy | `agy --print=<prompt> --output-format json` | `--conversation <id>` | `--mode accept-edits`; headless agy never asks anyway |
| codex | `codex exec --json -o <file>` | `codex exec resume <id>` | `--sandbox workspace-write` |

The recipe is picked from `cli = "..."` or the command's basename. `args`
in the roster are appended to the recipe's.

### In an editor (`room acp`)

`room acp <seats...>` is an ACP agent on stdio, so an editor that speaks ACP
hosts the room: Zed, or VS Code with an ACP client extension. The editor is
the client and the room is its agent; the seats are the room's agents in
turn. Each editor thread is its own room, named `acp-<time>-<id>`, with
state in `.room/<that name>/` and, in a repo, its own `room/<that name>`
branch. What changes from the REPL:

- Seats answer inside one agent message, a paragraph each, as `**seat>**`.
  Room status lines are paragraphs starting `[room]`.
- Tool calls show as the editor's own tool cards, titled `seat: ...`.
- A permission the room policy leaves to you is the editor's permission
  prompt: *Allow*, *Always allow <kind> for <seat> (room rule)*, *Deny*.
- The room's sequential and parallel modes are the session's modes, so
  the editor's mode picker switches them. `/parallel` and `/sequential`
  work too, as do `/next`, `/seats`, `/mode`, `/perm`, `/unperm`, `/help`.
- The editor's stop button cancels the round: the running seats are
  cancelled (recorded as passes) and the rest of the round is dropped.
- Reopening a thread (`session/load` replays the history, `session/resume`
  does not) reopens the room and reattaches every seat to its session.
- MCP servers the editor offers are ignored: seats bring their own.

Zed, in `settings.json` (format from Zed's external-agents docs; not yet
over stdio; first tried in Zed on 2026-09-25). Use an absolute path, from
`which room`: Zed may not have your shell's PATH.

```json
"agent_servers": {
  "room": {
    "type": "custom",
    "command": "/Users/you/Library/pnpm/room",
    "args": ["acp", "claude", "grok"],
    "env": {}
  }
}
```

Open a scratch repo, not this one: every thread checks out its own
`room/<name>` branch in the project. `dev: open acp logs` in Zed's command
palette shows the traffic.

The roster is looked up from the directory the editor starts the agent in;
pass `--roster <file>` before `acp` to pin it.

### Resuming

`room resume <name>` reopens `.room/<name>/` with the seats it last had
(or the ones you name), and refuses when there is no saved room. Each seat
reattaches to its session: `session/resume` when the harness advertises
it, else `session/load` with the replay drained, and a CLI seat keeps its
id. A seat that cannot reattach gets a fresh session and catches up from
the whole transcript.

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

## Tests without harnesses

`pnpm test` runs 63 tests with no harness or login. Fifteen of them spawn
`test/fixtures/fake-agent.ts`, a real ACP agent with switches for each
harness quirk (`--modes`, `--auto-edit`, `--no-ids`, `--resume`, `--load`,
`--start-delay`, `--fail-session`), and `test/fixtures/fake-claude`, a CLI
harness in Claude Code's headless shape. They cover the permission round
trip, diffs, cancel, resume across a restart, the doctor's verdicts, and
the room end to end. `test/acp-server.test.ts` spawns `room acp` with fake
seats and drives it as an editor would. Details in HANDOFF.md.

## What phase 0 found

| Seat | ACP route | Round trip | Notes |
| --- | --- | --- | --- |
| claude | `@agentclientprotocol/claude-agent-acp` | ok | Reuses the Claude Code login. Starts in whatever `defaultMode` your Claude settings set (`auto` here), so the room switches it to `default` with `session/set_mode`. |
| codex | `@agentclientprotocol/codex-acp` | blocked | Handshake and sessions work; turns fail with the ChatGPT usage limit. Its ask mode is `read-only` ("Ask for approval"). |
| grok | `grok agent stdio` | ok, with config | Auto-approves unless `~/.grok/config.toml` has both `[ui] permission_mode = "default"` and `[permission] ask = ["Write(*)", "Edit(*)", "Bash(*)"]`. `always-approve` in the config overrides ask rules, and without ask rules grok inherits Claude Code's `defaultMode=auto`. Two seats get separate sessions. |
| hermes | `hermes acp` | ok | Loads every configured MCP server at startup, so it is the slowest to come up. |
| pool | `pool acp --sandbox disabled` | ok | The Docker sandbox fails when the daemon is down, which is what hung the Laguna daemon. |
| agy | `antigravity-acp` (community) | never asks | The adapter always runs agy with `--dangerously-skip-permissions`, and agy's own headless modes write without asking too: it lists `ask_permission` as an agent-side tool, but nothing on the wire carries it. Sandbox-only seat. |
| laguna | `pool acp --sandbox disabled` + `SOUL.md` | ok | pool wearing the Laguna identity from `AGENT_JOURNAL/laguna/SOUL.md`. The old `pool-laguna.sh` launcher had Linux paths; fixed. |

All six advertise `loadSession`, so resume is on the table for every seat.
