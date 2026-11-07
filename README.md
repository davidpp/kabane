# Kabane

Local-first issue tracker and kanban for humans and AI agent runtimes. Every device
keeps an authoritative SQLite; devices converge through an append-only oplog relayed
by a Cloudflare Durable Object. A hub Worker runs the same core on DO SQLite and
serves MCP, so browser-only tools (ChatGPT, Claude.ai) and CLI-capable runtimes
(Claude Code, Hermes, Codex) share one tool surface. One machine on local SQLite is a
complete setup; the hub is optional and you host it yourself.

The project was called Cabane until its first public release. Internal names keep the old
one: the `@cabane/*` workspace packages, the `cabane-worker` Worker and its Durable
Objects, and the `cabane://actor/...` URIs stored in every row.

| Package | Name | Runtime | Holds |
|---|---|---|---|
| `packages/core` | `@cabane/core` | Bun + Workers | schemas, storage over the Db port, sync, plan lint, commit linking, MCP tool definitions and servers (stdio, Streamable HTTP) |
| `packages/sqlite` | `@cabane/sqlite` | Bun | Db adapter over `bun:sqlite` |
| `packages/acp` | `@cabane/acp` | Bun | Agent Client Protocol client: harness registry, session runner, the board's copilot |
| `packages/extension` | `@cabane/extension` | Bun | the extension contract, and the argument parsing and outcomes every command is written with |
| `packages/questions` | `@cabane/questions` | Bun + Workers | data module: the decisions agents ask a human on an issue (`kabane_ask`, `kabane_questions`, `kabane_answer`), replicated like tasks |
| `packages/checklist` | `@cabane/checklist` | Bun + Workers | data module: the steps of one issue, ticked as they land (`kabane_checklistAdd`, `kabane_checklistTick`, `kabane_checklistEdit`), replicated like tasks |
| `packages/cli` | `kabane` | Bun | the device command line |
| `packages/board` | `@cabane/board` | Bun | OpenTUI kanban over ActivitySource, Dispatcher and Copilot ports |
| `packages/worker` | `cabane-worker` | Workers | sync log DO + cloud device serving MCP |

## Install

Install the npm package with [Bun](https://bun.sh) 1.4 or later (not Node):

```bash
bun add -g kabane           # `kabane` on PATH, in ~/.bun/bin
kabane --version
```

`bun add -g kabane@beta` installs the current beta instead.

`bunx kabane` runs it once without installing. Install it globally before you let setup
wire your coding agents: their MCP entries point at the installed file.

Standalone binaries will be available starting with the first release that ships binary assets
on [GitHub Releases](https://github.com/davidpp/kabane/releases), for macOS (`darwin-arm64`,
`darwin-x64`) and Linux (`linux-x64`, `linux-arm64`). From such a release, download its
`kabane-<os>-<arch>.tar.gz` and `SHA256SUMS` from the same release. Verify the archive with
`sha256sum --check --ignore-missing SHA256SUMS` on Linux, or
`shasum -a 256 --check --ignore-missing SHA256SUMS` on macOS, then extract with
`tar -xzf kabane-<os>-<arch>.tar.gz`. Keep the whole extracted `kabane/` directory together:
`templates/` must stay beside the executable. Put that directory on PATH or symlink its
`kabane` executable into a directory already on PATH. Run `kabane --version` to check.
The binary includes Bun; git is still used for project scopes, and coding harness adapters
still need their own runtime (currently Node/npx). Windows and notarization are not provided.
`kabane update` replaces the executable and `templates/` in place with a verified newer
release; a binary under a mise installs directory is left to `mise up kabane`.

To work on kabane itself, run it from a clone instead:

```bash
git clone https://github.com/davidpp/kabane.git
cd kabane && bun install
cd packages/cli && bun link                      # `kabane` on PATH, pointing at the clone
```

For a human-run local release, use `bun run release:local prepare` to infer and bump the
version (or select `--bump patch|minor|major`, or `--version X.Y.Z-beta.N` for a beta on npm
`beta`), then authenticate to npm and resume with `bun run release:local publish`. Publication reuses the selected version and original bytes.
See [`docs/release.md`](docs/release.md) for retained artifacts, recovery and the optional Actions route.
For a standalone binary, `kabane update --check` reports a candidate from npm's dist-tags,
and `kabane update` downloads that release's archive for your platform, verifies it against
its `SHA256SUMS`, checks that the new executable prints the candidate version, then renames it
and `templates/` over the real executable (symlinks followed); any failure before that leaves
the old install as it was. For a positively verified hoisted Bun global registry install,
`kabane update --check` reports a candidate (installation policy is unverified), and
`kabane update` explicitly checks Bun policy and verifies an exact installation. A stable
install follows npm `latest`; a beta install takes the higher of `beta` and `latest`. Updates
stay within major, or minor for `0.x`; source links, local tarballs and unknown/missing-bin
layouts refuse replacement. The board shows `kabane <version> is out` when that candidate
exists, with what your install runs to take it: `kabane update`, or `mise up kabane`. It reads npm's dist-tags at most once a day and installs nothing;
`kabane config set updates.check false` turns it off. `kabane mcp` and other commands never
check, and `kabane update` opens no tracker DB and rewires no MCP entry.
See [updating and data compatibility](docs/getting-started.md#updating).

## Quick start

New to kabane? Follow [`docs/getting-started.md`](docs/getting-started.md): install, run
`kabane`, wire your agents, one machine on local SQLite.

```bash
kabane
```

The first run shows one card on what kabane is, then a setup screen: your name and the
coding harnesses found on this machine that get a `kabane` MCP entry. Enter writes the
config (one machine, local SQLite), files a first issue that has your agent add kabane to
the project's `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`, and opens the board; every later
`kabane` opens the board directly. Scripts and agents that run `kabane` without a terminal
still get the help text, and `kabane init --actor … --device …` remains the flag form.

Multi-device sync and the hub (a Cloudflare Worker behind Cloudflare Access, on a domain
and account of your own) are set up by following [`docs/deploy.md`](docs/deploy.md):
Cloudflare, first device, more devices, each client (Claude Code, Hermes, Codex, Claude.ai,
ChatGPT), and day-two operations. The auth decision is in [`docs/auth.md`](docs/auth.md).

## Board

`kabane board` opens the kanban on the scope the working directory resolves to. The footer
shows the everyday keys of where you are, and `?` opens a sheet along the bottom with every key
of the view you are in, then the ones that work everywhere; a key that does nothing right now
(no row selected, say) shows faint. Two of them are the copilot: `m` marks rows into a working set, and `A` opens a
one-line prompt that carries what you are looking at — the scope, the section, the filters,
the selected row, the marked set and their briefs — to a coding harness running on your
machine as you.

```
 kabane · myapp                                           · 3 marked
 next · 3
   JMYA-37  ● Checkout: retry a declined card once, then …
   JMYA-38  ● Wire the retry into the payment form
   JMYA-39    Receipts: attach the order id to every email

 copilot · claude · JMYA-31 · 3 marked · next
 ▸ verify which of these are still real todos, someday or next
```

`enter` sends it. The turn runs in the background, the board stays interactive, and the
footer carries `⠹ copilot · <last tool call>` while it goes, then `✓ copilot · <the agent's
last line>` until the next keypress. `o` opens the transcript — the session's last few turns,
each under the prompt that started it — and `x` there stops a running one.
Typing `/` first lists the shortcuts (`/triage`, `/refine`, `/split`, `/duplicates`,
`/reparent`, `/check-plan`, `/linear`, `/github`), which expand into the window so you read what will be sent.
`/setup-dispatch` is the one that writes a file: it reads the project's CLAUDE.md/AGENTS.md,
gate and `.claude/agents/`, and writes a dispatch skill under `.claude/skills/dispatch/` for
coding sessions to turn asks into issues here, showing each file before it lands.

Every write the copilot makes goes through `kabane mcp` into this device's database, stamped
`cabane://actor/agent/<harness>`, and the board reloads as each one lands. The harness is
Claude Code on Sonnet unless `~/.kabane/config.json` says otherwise — `copilot.harness`
picks `codex` or `gemini`, `copilot.model` runs the harness as something else — and
`kabane board --copilot <harness>` overrides that for one run; it has to be installed and
logged in on this machine ([`docs/deploy.md`](docs/deploy.md) part 4.7).

`enter` on a row opens its detail view. Pinned on top: the title, the task at a glance
(state, priority, kind, assignee), what is running on it, its parent, how many subtasks it
has and how many are done, what blocks it and what it blocks, the issue it links to, and any
question an agent is waiting on. Under it, three tabs, one at a time: the description, with
the decisions made on the issue, the subtasks (done or open, and an open one's state) and the
curated context refs (kind, label, ref) under it; the comments (whole, newest first); and the log (work logs with short
shas and session activity, one line each). `1`-`3` jump to a tab,
`h`/`l` step through them, and a click picks one. The view draws the task's records, not the
agent brief; `y` still copies the brief for pasting into a chat.

```
 JMYA-89 · Retry a declined card once    [copy]
 in progress · issue · @claude
 parent JMYA-1 Checkout rework
 subtasks 3 · 1 done
 blocked by JMYA-84 done · Payment errors…

 description  comments 2  log 9

 A declined card fails the order today…
```

## Agent reads

Select efficient output explicitly: `kabane list --assignee codex --state next
--format concise`, `kabane search license --format concise`, and `kabane edit
JCAB-12 --state in_progress --format concise`. MCP uses `responseFormat:
"concise"` on list/search/today/add/edit/done/context. Use `kabane context <id>
--format concise` for lossless bounded context; consume all preceding chunks and
finish required description/human steering before starting work. Follow page
continuations; read full fields with `kabane_get` / `kabane show <id> --json`.
Defaults and explicit full keep legacy records and complete context briefs
(with the complete subtask rollup, including deferred and closed children). [Contracts and examples](docs/concise-reads.md)
cover byte bounds, preview markers and stale cursors.

## Gate

```bash
bun install
bun run check       # oxlint, its type-aware pass, oxfmt --check, knip, jscpd
bun run typecheck   # tsc --noEmit per package
bun run test        # bun packages, then the Worker suite under vitest
```

`bun run fix` applies oxlint's fixes and oxfmt. Lefthook runs oxfmt on staged
files, both oxlint passes on staged `.ts`/`.tsx`, and `typecheck` when `.ts`
files are staged, on every commit.

Both oxlint passes deny warnings, in `bun run lint` and in lefthook, so a warning fails
the commit and the gate.

## Try a change without touching your own device

```bash
bun run sandbox                # first-run setup, then the board, on a throwaway device
bun run sandbox list           # any kabane command, inside the sandbox's git repo
bun run sandbox --fresh        # start over
bun run sandbox --harnesses    # also let setup install into harness configs under the sandbox
bun run sandbox --scripted board  # the board, its copilot on a scripted agent instead of a harness
```

The sandbox is its own `KABANE_HOME` plus a seeded git repo in the system temp directory,
one per checkout. By default setup finds no agents, so nothing is registered in your real
Claude Code, Codex or Gemini config. `--harnesses` gives the harnesses a sandbox HOME, so
the install step runs for real, but a harness may not be logged in there: try the copilot
without it.

`--scripted` points the sandbox's copilot at `packages/acp/scripts/scripted-agent.ts`, an
ACP agent that needs no login and answers on cue. Open the copilot with `tab` and send
`ask form`, `ask multi`, `ask text` or `ask permission` to get each kind of ask, then answer
it and read what the agent received. `plan`, `tools` and `long` stream a plan, tool calls
and a long reply; anything else is echoed. The next run without the flag puts the copilot
back on a real harness.

To look at one surface without running anything, the gallery draws each of the board's
states from made-up props (`packages/board/src/stories`):

```bash
bun run gallery                           # a TUI: j/k the story, t the theme, w the width
bun run gallery --list                    # the stories
bun run gallery --print form-described    # one story's frame as text; --ansi for its colors
```

## License

MIT, see [`LICENSE`](LICENSE).
