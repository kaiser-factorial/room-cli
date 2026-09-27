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

## The menu

`room` on its own opens a menu (also `room menu`). The first time, it
walks you through your defaults; after that it opens on home:

- **Start a room** with your default seats, in the TUI (or the REPL, if
  you chose it).
- **Past rooms**, from this directory and every other place you have run
  one: when, who, how big, the last thing said. Read a transcript, resume
  it, or archive it.
- **Room defaults**: your name; who joins (space); each seat's role (←→,
  the web app's presets) and persona (enter, a sentence or two of who it
  is); what an untagged message wakes; the wake cap; TUI or REPL.
- **Moderator**: auto, you, off, or an OpenRouter model id, and your
  OpenRouter key.
- **Skills & MCP**: every skill and MCP server the harnesses here have set
  up, and what to share.

Defaults live in `~/.config/room/config.toml` (edit it by hand if you
like); the key in `secrets.toml` beside it, readable only by you. An
`OPENROUTER_API_KEY` in the environment wins. `room start` with no seats
uses your defaults; flags still override them.

### Shared skills and MCP servers

The room looks in `~/.claude/skills` (and plugin skills), `~/.codex/skills`,
`~/.gemini/skills`, `~/.hermes/skills`, `~/.agents/skills`, and the
project's `.claude/`, `.codex/`, `.agents/` skill folders; and for MCP
servers in `~/.claude.json`, `.mcp.json`, `~/.codex/config.toml`, and
`~/.gemini/settings.json`.

- Skills are found at any depth (skills nested in skills, plugin folders
  like `.claude/skills` inside a plugin), and plugin commands
  (`commands/*.md`) are offered too; `~/.codex/plugins` and `~/.grok` are
  searched as well.
- **Skills** are shared with every seat by default, through the room's own
  MCP server: `skills` searches them (with no query, a count and a sample:
  a machine can have hundreds), `skill <name>` gives one in full with the
  paths of its files. So a skill set up only for Claude is usable by grok.
- **MCP servers** you tick are handed to every seat at session start, except
  the harness whose config has it (it loads it itself).

### A check before landing

`/check pnpm typecheck && pnpm test` (or `--land-check`, or `landCheck` in
a room file) sets a command that must pass in a seat's desk before its work
lands. If it fails, nothing lands, the transcript keeps the tail of the
output, and the seat gets it at the top of its next turn. `/land <seat>
--force` skips it; `/check off` clears it. A landing that finds the trunk
busy (you mid-merge, or changes of yours in it) is queued and lands by
itself once the trunk is free.

### Quieter rooms

Every seat hears an untagged message, so seats are told most turns should
be a `[pass]`, whatever their role. `/mute <seat>` goes further: untagged
messages and `@all` skip it until `/unmute`, while `@seat` still reaches it.

### Cleaning up: `room prune`

Every room keeps worktrees (its trunk and a desk per seat) until you
archive it. `room prune` archives every idle room here: transcripts
gzipped, worktrees removed, and each seat's uncommitted work committed to
its branch first, so nothing is lost. A room that is open right now is
skipped. `--branches` also deletes branches whose work is already merged
(a desk into its trunk, a trunk into your branch); anything unmerged is
kept and listed. `--dry-run` says what it would do. `room resume <name>`
brings a pruned room back. The menu's Past rooms has the same.

### Desks can build

A desk is a fresh checkout, so it lacks whatever your checkout has that
git ignores: installed dependencies, a virtualenv, env files. The room
links those into each desk from the main checkout, when they exist there
and git ignores them (so a link is never committed): by default
`node_modules`, `.venv`, `venv`, `__pypackages__`, and `.env*`, at the top
and a couple of levels down. A project with none of them gets nothing.
Set your own list with `deskLinks = [...]` in `~/.config/room/config.toml`
(`[]` turns it off).

Anything installed outside the project (global, pyenv, conda, pip
`--user`, Homebrew) needs nothing: seats run on your machine with your
PATH, so imports work as usual. One catch: a package installed editable
(`pip install -e`) or as a workspace link points at the main checkout's
source, not the desk's; seats are told.

### Where rooms are kept, and what they cost

Each room is `.room/<name>/` in the directory it ran in: `state.json`,
`transcript.jsonl`, and with git, `desks/` (a worktree per seat).
`~/.config/room/rooms.jsonl` indexes them so the menu can list them all.

A transcript is small: text only, a few KB a turn, since tool calls are
kept as one-line steps and never their output. The desks are what grow,
each a checkout of the repo. **Archive** (in Past rooms) gzips the
transcript (text compresses ~10×) and removes the desk worktrees; their
branches stay in git, so no seat's work is lost, and `room resume` unpacks
the transcript and recreates the desks.

Seats' replies are rendered as markdown, in the REPL and the TUI alike:
bold, italics, headings, bullets, quotes, links, `code`, file paths, and
function names in a colour of their own, and fenced code blocks drawn as
code. In the REPL a line appears once it is complete. `NO_COLOR` (or a
pipe) keeps the raw text.

## The TUI

`room start claude grok --tui` (also on `resume`) opens the room in a
terminal UI built with Ink:

- Finished turns print into the terminal's own scrollback, so scrolling,
  search, and copy work as usual.
- Above the input, each seat mid-turn has a live box showing its latest
  lines; a background seat's box has a bar in its colour.
- A status bar shows what every seat is doing: `● claude writing…`,
  `● grok (bg) · Execute pnpm test`, `○ agy idle`, benched seats in grey,
  and flags like `auto` and `parallel`.
- The input stays open while seats work; lines are sent in the order typed.
  A permission question replaces it with a boxed bar showing the change,
  answered with one key (a, A, d, c); more waiting are counted.
- Ctrl+C cancels the running round; a second Ctrl+C quits.
- Same commands as the REPL, including `/show`, `/verbose`, `/thoughts`.

## Commands

```bash
room start claude grok hermes        # open a room; nothing joins by default
room start claude grok --tui         # the same, in the terminal UI
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

`room start` always opens a new room: `main`, or `main-2`, `main-3`, ... when
that name is taken. `room resume <name>` continues one; a room reopened with
a different lineup tells its seats who joined and who left.

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
```

Your message posts at once, even while seats are working. An untagged
message wakes every seat; `@a @b` wakes those seats, one after
another; `@all` wakes everyone; an empty line runs everyone again with
nothing new. A seat replying `[pass]` is recorded as a pass. In a git
repo, each seat works in its own desk (below) and its work lands on the
room's branch, so `git log` and `git blame` say who did what. State lives
in `.room/<name>/` (transcript.jsonl, state.json, desks/), which the room
keeps out of git.

### Desks

In a git repo the room never switches your checkout. It keeps a **trunk**,
`room/<name>`, in its own worktree at `.room/<name>/trunk`, cut from the
branch you were on (your **base**), and gives every seat a **desk**: a git
worktree at `.room/<name>/desks/<seat>` on its own branch,
`desk/<name>/<seat>`.

- **Your branch flows in.** Whenever you commit on your base, the room
  brings it into the trunk before the next turn (a fast-forward or a clean
  merge), and seats are told. A conflict, or a base you rebased, is left to
  you with the command to run; nothing is forced.
- **Landed work flows out when you say.** After a landing the room says how
  far the trunk is ahead of your branch; `/sync` fast-forwards your branch
  to it. If you have both moved, it tells you to `git merge room/<name>`.
- **Uncommitted work of yours is never taken.** The room names the files
  and reminds you seats only see what you commit.
- **Resuming** a room brings your branch in the same way, so a room left
  for a week picks up what you did since. A resumed seat whose instructions
  have changed (a new version of the room, a new role) gets the new ones.
- **The room's own code.** `pnpm build` stamps the commit it was built
  from; a room opened on this repo says when its trunk lacks that commit.

- A seat owns git in its desk: it edits, runs, and commits there, with its
  own messages. Its commits carry its name (the room sets `GIT_AUTHOR_NAME`
  for it), not yours.
- Nothing changes a desk but its seat. When the trunk has new work, the
  seat is told at the top of its next turn (who landed what, and
  `git merge room/<name>` to take it) and merges when it is ready. Work it
  leaves uncommitted stays that way between turns; landing (`[land]` or
  `/land`) commits what is left, as the seat, before merging.
- Nothing reaches the trunk until the seat says so: a reply ending `[land]`
  merges its branch into the trunk. `/land <seat>` does it for a seat;
  `/seats` shows how many commits each desk has not landed.
- A merge that conflicts is aborted, the work stays on the desk, and the
  seat is told on its next turn to merge the trunk and resolve it.
- **Background work.** `/bg grok build the parser`, or a seat ending its
  reply with `[background] <what it will do>`, sends that seat on working
  in its desk while the room goes on: it leaves the rotation (hand-offs to
  it are skipped, `@grok` says it is busy), its progress streams live
  behind a gutter in its colour, `▌ grok (bg)`, whole lines only so it
  never splits the active reply, and its permission questions come to you
  one at a time, over your prompt, which comes back afterwards with what
  you had typed. When it finishes its reply is posted and its work lands.
  `/stop grok` cancels; what it did stays on its desk for `/land`.
  Background turns may run an hour.
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

Tool calls are one dim line each, with a short result and a number:
`· grok: Edit calc.py (+2 -1) #3`, `` · grok: Execute `pnpm test` #4 `` then
`↳ 88 passed`. `/show 4` prints a call in full (`/show grok` for a seat's
latest), and `/verbose` streams everything. Thinking is one short line per
stretch (`/thoughts full` streams it, `/thoughts off` hides it). Seats read
each other's full work through git: every desk's branch is visible from
every other desk.

Each speaker gets its own block and colour, by harness: grok white, claude
orange, codex purple, agy green, pool light blue (so laguna too), hermes
amber. `colour = "teal"` (or a 256-colour index) in a roster entry
overrides it; room lines, tool activity,
and seats' thinking are dimmed, so a seat's loop (think, run, think,
reply) reads live without drowning the replies. Colour is off when stdout is not a terminal or `NO_COLOR` is
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

- **Threads, not rounds.** Each message you send starts a thread. It
  posts at once, and you can interject at any time. Who it wakes:
  - untagged: every idle seat (`/wake last` or `--wake last` makes it
    whoever spoke last);
  - `@a @b` (anywhere in your message): those seats, one at a time, each
    seeing the replies before it;
  - `@all`: every idle seat;
  - `@grok!`: interrupts grok now, even mid-turn or in the background.
    What it had written stays in the transcript, marked `(interrupted by
    you)`, and its tags wake nobody. It answers your message before any
    other thread goes on, told that you cut it short.
  A seat that is mid-turn is not woken again; your message is waiting in
  what it reads next.
- **Hand-offs:** a seat that writes `@name` on the first or last line of
  its reply adds that seat to the END of its thread's queue, so `@claude
  @grok` then claude tagging `@agy` runs grok, then agy. Nobody is queued
  twice. A mention in the middle ("as @grok said") is a citation. `@<you>`
  is announced. Mentions inside code do not count.
- **Limits:** a thread allows 6 seat-to-seat wakes, then holds the rest;
  `/cap +10` releases them, `/cap 20` or `/cap off` changes the limit
  (`--cap` at start). Two seats trading short replies are paused; `@`
  either to go on. `/seats` shows who is next and both settings.
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

### Room tools (MCP)

Every ACP seat gets an MCP server named `room`, so it can take part while
it works instead of only when its turn ends:

| Tool | What it does |
| --- | --- |
| `inbox` | What others posted since the seat last read. Read messages are not repeated in its next turn. |
| `post` | Posts a message now, mid-turn, shown as `grok (post): …`. A tag on its first or last line wakes that seat, as a reply's would. |
| `status` | Who is answering, queued, in the background, or benched; mode, wake, cap. |
| `show` | A transcript entry in full with its tool calls (`id`), or the last few (`last`, `from`). |
| `diff` | A seat's work not landed yet: its desk branch against the trunk, plus uncommitted work. Without desks, the shared directory's uncommitted changes. |

`post` is rate limited so a seat cannot flood the room: 3 posts a turn,
one every 5 seconds, no repeats (`postLimit`, `postGapMs` in
`Room.open`). A refused post tells the seat why.

The server listens on 127.0.0.1 with a secret URL per seat, which is how
it knows who is calling. Harnesses that take HTTP MCP servers (Claude)
get the URL; others get a small stdio bridge (`src/server/mcp-bridge.ts`)
that forwards to it. CLI seats do not get the tools yet. `tools: false` in
`Room.open` turns it off.

### The moderator

The limits above are blunt, and plenty of long exchanges are real work. So
when one trips (the wake cap, the echo pause, or a seat's post limit), the
room asks a moderator instead of just stopping:

- **A model on OpenRouter** when `OPENROUTER_API_KEY` is set: by default
  `anthropic/claude-haiku-4.5` (`ROOM_MODERATOR_MODEL` or `--moderator
  <model id>` picks another). It sees the last few messages and answers
  allow, hold, or nudge (let it through, and tell the seats what would
  make the next turn worth it).
- **You**, when there is no key or the model cannot answer: a
  `let it through? [y/n]` question, like a permission prompt.

Allowed, the thread gets three more wakes (or a fresh echo count) before
the moderator is asked again, and never more than three times the cap.
Every decision is a line in the transcript:
`moderator (anthropic/claude-haiku-4.5): allow grok → claude: converging on the parser fix`.
`/mod off|you|auto|<model>` switches it (`--moderator` at start). In an
editor (`room acp`) there is no one to ask, so without a key limits hold.

### Permissions, two levers

**Auto mode** (`/auto on`, or `--auto` at start): a tool call that no rule
matches runs without asking you. Deny rules still block and ask rules
still ask, so `/perm grok deny "Bash rm *"` and `/perm grok ask "Write *.env"`
are how you fence it. Auto approvals print nothing extra: the tool call
itself is already on screen. The setting is saved with the room.

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

### Roles

The web app's panel roles (`neutral`, `brainstormer`, `critic`,
`researcher`, `synthesizer`, `implementer`) apply to seats three ways:

- For one room: `room start claude grok --role grok=critic claude=implementer`
  (put `--role` after the seats, or repeat it).
- Mid-session: `/role grok critic`, `/role grok none`, and `/role` alone to
  list the roles and who has which. The seat is told in the room, since its
  first-turn instructions are already sent; the role is saved with the room.
- Always: `role = "critic"` in the roster, or `[roles]` in a room file.

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

## Hosted rooms: bring sessions you already have

`room start` launches its seats. `room host` is the other way round: sessions
already running elsewhere (a Claude Code session on one project, a Grok
session on another) join a room, talk, and go back to their own work.
Nobody's context is copied; a session shares only what it posts.

```sh
room setup claude     # once: registers `room mcp` (user scope) and three hooks in ~/.claude/settings.json (backed up)
room host harness     # in a terminal of yours: the room; type to post, @name to tag, /who, /quit
```

Then tell each session "join the room harness". Its `room` MCP server gives it
`rooms`, `join`, `post`, `inbox`, `wait`, `who`, `leave`.

Nobody is interrupted. A session that posts a question goes back to its work.
When something new arrives, a Claude Code hook adds one quiet line beside its
next tool result ("[room harness] 1 new message from grok … read it with
inbox when you reach a good stopping point"), once per message. A turn about
to end with a message that tags the session unread is held once, so it can
answer before going idle. `wait` blocks for an answer, for when a session
really cannot go on without one. An idle session cannot be woken from
outside: nudge it yourself.

Grok, Codex, Hermes: `room setup grok` (or codex, hermes) registers the
server through the harness's own `mcp add`, or prints the command to run. Without
hooks they see "(n unread)" on their room tool results, not a ping.

## Context: seeing it, compacting it, bringing a session in

`/context` shows each seat's context use as its harness reports it (Claude's
does; others may not). `/compact <seat> [what to keep]` sends the seat its
own `/compact` between turns, e.g. `/compact claude keep the adapter
findings`: no room message, no preamble, and a before/after. `/cmd <seat>
/<command>` runs any command the seat advertises; `/cmd <seat>` lists them.

`--session claude=<id>` opens a seat on a session made outside the room,
say last week's work, with all its history. It is a copy (ACP
`session/fork`) so the original is never written to; `--in-place` opens the
session itself (close it anywhere else first). A harness that cannot copy
falls back to opening it in place, and says so. Session ids: `claude -r`
lists Claude's, `grok sessions list` Grok's, `codex resume` Codex's.

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
