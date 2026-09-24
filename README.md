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
| `packages/cli` | `kabane` | Bun | the device command line |
| `packages/board` | `@cabane/board` | Bun | OpenTUI kanban over ActivitySource, Dispatcher and Copilot ports |
| `packages/worker` | `cabane-worker` | Workers | sync log DO + cloud device serving MCP |

## Install

Kabane is not on npm yet, so it runs from a clone. It needs [Bun](https://bun.sh) 1.4 or
later.

```bash
git clone https://github.com/davidpp/cabane.git kabane
cd kabane && bun install
cd packages/cli && bun link                      # `kabane` on PATH
kabane --help | head -1
```

`bun link` puts the command in `~/.bun/bin`, pointing at this clone, so pulling the clone
updates it.

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
the subtasks (done or open, and an open one's state) and the curated context refs (kind,
label, ref) under it; the comments (whole, newest first); and the log (work logs with short
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

## Gate

```bash
bun install
bun run check       # oxlint, its type-aware pass, oxfmt --check
bun run typecheck   # tsc --noEmit per package
bun run test        # bun packages, then the Worker suite under vitest
```

`bun run fix` applies oxlint's fixes and oxfmt. Lefthook runs oxfmt on staged
files, both oxlint passes on staged `.ts`/`.tsx`, and `typecheck` when `.ts`
files are staged, on every commit.

## Try a change without touching your own device

```bash
bun run sandbox                # first-run setup, then the board, on a throwaway device
bun run sandbox list           # any kabane command, inside the sandbox's git repo
bun run sandbox --fresh        # start over
bun run sandbox --harnesses    # also let setup install into harness configs under the sandbox
```

The sandbox is its own `KABANE_HOME` plus a seeded git repo in the system temp directory,
one per checkout. By default setup finds no agents, so nothing is registered in your real
Claude Code, Codex or Gemini config. `--harnesses` gives the harnesses a sandbox HOME, so
the install step runs for real, but a harness may not be logged in there: try the copilot
without it.

## License

MIT, see [`LICENSE`](LICENSE).
