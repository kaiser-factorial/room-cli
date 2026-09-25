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
workspace. It needs Node 22 or newer and pnpm 11 (`brew install pnpm`, or
`corepack enable`; `packageManager` pins the version). pnpm keeps one content-addressed store per machine,
so the adapters' dependencies take disk space once however many checkouts
use them.

```bash
cd packages/room
pnpm install && pnpm build
pnpm add -g link:$PWD     # `room` on PATH, running this checkout; rebuild after pulling
```

pnpm 11 puts global commands in `$PNPM_HOME/bin` (pnpm 10 used
`$PNPM_HOME`), and `pnpm link --global` is gone in favour of the `link:`
protocol above. If `pnpm add -g` says the global bin directory is not in
PATH, add `export PATH="$PNPM_HOME/bin:$PATH"` to your shell profile.
For an install that does not follow the checkout, the way a pip install
would not: `pnpm pack`, then `pnpm add -g ./local-room-0.0.1.tgz`.

Dependency install scripts run only where `pnpm-workspace.yaml` allows
them (`allowBuilds`), and pnpm 11 will not install a release younger than
a day, so a freshly published compromised version cannot land here.

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
preamble on its first turn. Another seat's turn reads in the order it
happened: each tool call is a room line with how it ended, and what the
seat said between calls keeps its label, so a seat can build on the work
and not only on its summary:

```
[room]: grok tool: Execute `pytest -q` → 1 failed, 3 passed
[grok]: One failure, in calc. Fixing the sign.
[room]: grok tool: Edit calc.py (+1 -1)
[grok]: Fixed. Re-running.
``` Your message starts a round in roster order; a
leading `@seat` sends it to that seat only; an empty line runs another round
with nothing new. A seat replying `[pass]` is recorded as a pass. In a git
repo, each seat works in its own desk (below) and its work lands on the
room's branch, so `git log` and `git blame` say who did what. State lives
in `.room/<name>/` (transcript.jsonl, state.json, desks/), which the room
keeps out of git.

### Desks

In a git repo the room checks out `room/<name>`, the **trunk**, in your
working directory, and gives every seat a **desk**: a git worktree at
`.room/<name>/desks/<seat>` on its own branch, `desk/<name>/<seat>`.

- A seat owns git in its desk: it edits, runs, and commits there, with its
  own messages. Its commits carry its name (the room sets `GIT_AUTHOR_NAME`
  for it), not yours.
- Before each of its turns the room merges the trunk into its desk, so it
  builds on everyone's work. After the turn it commits whatever the seat
  left uncommitted, as the seat, and merges the desk into the trunk. Your
  own edits in the trunk are committed as you first.
- Not ready to share? A seat ending its reply with `[hold]` keeps the
  turn's work on its desk, uncommitted and unmerged, until a turn it ends
  without it. `/land <seat>` lands held work yourself; `/seats` shows who
  is holding.
- A merge that conflicts is aborted, the work stays on the desk, and the
  seat is told on its next turn to merge the trunk and resolve it.
- `--no-desks` goes back to one shared directory, where the room commits
  after each turn and seats are told not to touch git.

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

Each speaker gets its own block and colour, by harness: grok white, claude
orange, codex purple, agy green, pool light blue (so laguna too), hermes
amber. `colour = "teal"` (or a 256-colour index) in a roster entry
overrides it; room lines, tool activity,
and seats' thinking are dimmed. Thinking streams as it comes, so a seat's
loop (think, run, think, reply) is visible live; `/thoughts off` folds each
run of it to one line. Colour is off when stdout is not a terminal or `NO_COLOR` is
set. A commit note lists the files the turn changed.

### When a seat fails

A failed turn is the room's note (`[room] claude (claude-agent-acp) turn
failed: ...`), never the seat's words, so the other seats read it from the
room. A seat is **benched**, skipped in rounds and hand-offs, at once when
its harness reports a rate limit, a usage limit, or a login, and after
the same error twice otherwise. `@seat` or `/unbench seat` brings it back;
`/seats` shows who is benched. Protocol oddities from a seat (a reply to a
request the room never made, a non-JSON line) are shown once each, named.

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
  time, and each seat sees the others' replies next round. With desks,
  every seat edits its own copy and the batch lands in roster order; a
  later seat that touched the same lines gets the conflict back. Without
  desks, file edits, deletes, moves, and shell commands are refused during
  a parallel round without asking you, since several seats would be
  writing one directory. Hand-offs from a parallel batch run afterwards.

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
    "command": "/Users/you/Library/pnpm/bin/room",
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
