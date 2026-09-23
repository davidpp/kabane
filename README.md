# Cabane

Local-first issue tracker and kanban for humans and AI agent runtimes. Every device
keeps an authoritative SQLite; devices converge through an append-only oplog relayed
by a Cloudflare Durable Object. A hub Worker runs the same core on DO SQLite and
serves MCP, so browser-only tools (ChatGPT, Claude.ai) and CLI-capable runtimes
(Claude Code, Hermes, Codex) share one tool surface. Extracted from Jake's planner;
decision record in `~/Projects/jake/docs/ADR/032-cabane-extraction.md`.

| Package | Name | Runtime | Holds |
|---|---|---|---|
| `packages/core` | `@cabane/core` | Bun + Workers | schemas, storage over the Db port, sync, plan lint, commit linking, MCP tool definitions and servers (stdio, Streamable HTTP) |
| `packages/sqlite` | `@cabane/sqlite` | Bun | Db adapter over `bun:sqlite` |
| `packages/acp` | `@cabane/acp` | Bun | Agent Client Protocol client: harness registry, session runner, the board's copilot |
| `packages/cli` | `cabane` | Bun | the device command line |
| `packages/board` | `@cabane/board` | Bun | OpenTUI kanban over ActivitySource, Dispatcher and Copilot ports |
| `packages/worker` | `cabane-worker` | Workers | sync log DO + cloud device serving MCP |

## Quick start

New to cabane? Follow [`docs/getting-started.md`](docs/getting-started.md): install, run
`cabane`, wire your agents, one machine on local SQLite.

```bash
cd packages/cli && bun link                      # `cabane` on PATH
cabane
```

The first run shows three short cards on what cabane is, then a setup screen: your name,
this machine's name, and the coding harnesses found on it that get a `cabane` MCP entry.
Enter writes the config (one machine, local SQLite) and opens the board; every later
`cabane` opens the board directly. Scripts and agents that run `cabane` without a terminal
still get the help text, and `cabane init --actor … --device …` remains the flag form.

Multi-device sync and the hosted hub (Cloudflare Worker behind Access at
`cabane.3pew.ca`) are set up by following [`docs/deploy.md`](docs/deploy.md): Cloudflare,
first device, more devices, each client (Claude Code, Hermes, Codex, Claude.ai, ChatGPT),
and day-two operations. The auth decision is in [`docs/auth.md`](docs/auth.md).

## Board

`cabane board` opens the kanban on the scope the working directory resolves to; `?` lists
every key. Two of them are the copilot: `m` marks rows into a working set, and `A` opens a
one-line prompt that carries what you are looking at — the scope, the section, the filters,
the selected row, the marked set and their briefs — to a coding harness running on your
machine as you.

```
 cabane · cabane                                          · 3 marked
 next
   ● JCAB-37  Copilot over ACP: instruction block, slash shortcuts, …
   ● JCAB-38  Wire the copilot into `cabane board`
     JCAB-39  Agent writes: attribution, needsReview policy, triage tool

 JCAB-31 · 3 marked · next
 > verify which of these are still real todos, someday or next
 ─────────────────────────────────────────────────────────────────────
 ⠹ copilot · cabane_edit
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

Every write the copilot makes goes through `cabane mcp` into this device's database, stamped
`cabane://actor/agent/<harness>`, and the board reloads as each one lands. The harness is
Claude Code on Sonnet unless `~/.cabane/config.json` says otherwise — `copilot.harness`
picks `codex` or `gemini`, `copilot.model` runs the harness as something else — and
`cabane board --copilot <harness>` overrides that for one run; it has to be installed and
logged in on this machine ([`docs/deploy.md`](docs/deploy.md) part 4.7).

## Set up one of David's devices (for AI agents)

This section is David's own setup: his 1Password vault, his hub at `cabane.3pew.ca`, his
actor. Trying cabane on your own machine? Follow
[`docs/getting-started.md`](docs/getting-started.md) instead.

For AI agents: paste this section to the agent. It needs `op` (1Password CLI) signed in
to `botpress.1password.com` and Bun installed. Every credential is read from 1Password,
vault `Employee`, items tagged `cabane`; nothing is typed by a human. Run the steps in
order; each shows the line that means success. Background: [`docs/deploy.md`](docs/deploy.md)
parts 2 to 4.

1. **Check 1Password.** `op whoami` prints the account URL and email. If it errors, stop and
   ask the human to run `op signin`, then continue.

2. **Install the CLI.**

   ```bash
   git clone git@github.com:davidpp/cabane.git ~/Projects/cabane
   cd ~/Projects/cabane && bun install && cd packages/cli && bun link
   cabane --help | head -1
   ```

   Expected: `cabane — local-first tracker for humans and agent runtimes`. Use `bun link`,
   not `bun install -g`; that is the verified route and the schedule templates assume
   `~/.bun/bin/cabane`.

3. **Initialize the device** with the shared log secret and the `cabane-cron` Access
   service token (the identity of a machine; writes are still stamped with `--actor`).

   ```bash
   V=Employee
   cabane init \
     --actor cabane://actor/human/david \
     --device "$(hostname -s)" \
     --sync-url https://cabane.3pew.ca \
     --sync-token "$(op item get 'Cabane hub SYNC_TOKEN (planner log bearer)' --vault $V --fields credential --reveal)" \
     --access-client-id "$(op item get 'Cabane Access service token: cabane-cron' --vault $V --fields username)" \
     --access-client-secret "$(op item get 'Cabane Access service token: cabane-cron' --vault $V --fields credential --reveal)"
   ```

   Expected: `✓ Initialized ~/.cabane`, then `sync:   https://cabane.3pew.ca` and
   `access: service token headers set`. Secrets land only in `~/.cabane/config.json`.

4. **Pull the tracker.** A fresh device replays the whole log; do not run `backfill`
   here, there is nothing to seed.

   ```bash
   cabane sync pull
   cabane sync status
   cabane list --limit 5
   ```

   Expected: `⬇️  Pulled N ops, applied N, renamed 0 (...)`, then `Sync: armed as device
   <hostname>` with `pending ops: 0` and `quarantined: 0`, then five tasks.

5. **Schedule the pull** (push is opportunistic, pull writes rows and is never implicit).

   macOS:

   ```bash
   sed "s|__HOME__|$HOME|g" ~/Projects/cabane/docs/schedule/com.cabane.sync-pull.plist \
     > ~/Library/LaunchAgents/com.cabane.sync-pull.plist
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cabane.sync-pull.plist
   launchctl print gui/$(id -u)/com.cabane.sync-pull | grep -E "state|interval"
   ```

   Expected: `state = waiting`, `interval = 300`. Linux:

   ```bash
   crontab -l 2>/dev/null | cat - ~/Projects/cabane/docs/schedule/cabane-sync-pull.cron | crontab -
   crontab -l | grep cabane
   ```

6. **Give yourself MCP access.** Local device, no network, sessions included. This
   registers `cabane` at user scope in every harness on PATH (Claude Code, Codex, Gemini
   CLI), each serving as its own actor (`cabane://actor/agent/<harness>`):

   ```bash
   cabane mcp install
   claude mcp list | grep cabane
   ```

   Expected: one `✓ <harness> installed` line per harness found, then
   `cabane: ... mcp --as cabane://actor/agent/claude - ✔ Connected`. The entry spawns an
   absolute bun and this clone's `packages/cli/index.ts`, so a harness's own PATH does not
   matter; after upgrading bun or moving the clone, run `cabane mcp install --force`.
   `--harness <id>` narrows it, `--print` prints paste-ready config for each harness and
   for any other MCP client instead of installing.

   Or the hub directly, with the runtime's own token (`cabane-claude-code`, `cabane-codex`,
   `cabane-hermes` follow the same item-title pattern):

   ```bash
   claude mcp add --transport http -s user cabane https://cabane.3pew.ca/mcp \
     --header "CF-Access-Client-Id: $(op item get 'Cabane Access service token: cabane-claude-code' --vault $V --fields username)" \
     --header "CF-Access-Client-Secret: $(op item get 'Cabane Access service token: cabane-claude-code' --vault $V --fields credential --reveal)"
   claude mcp list
   ```

   Expected: `cabane: https://cabane.3pew.ca/mcp (HTTP) - ✔ Connected`. Hub wiring for
   Codex and Hermes is in [`docs/deploy.md`](docs/deploy.md) 4.2 and 4.3.

7. **Pick up work.** After a pull, an agent runtime lists what is assigned to it, claims it,
   reads the brief, works, and closes:

   ```bash
   cabane list --assignee claude --state next
   cabane edit <id> --state in_progress
   cabane context <id>
   cabane comment <id> "what landed" --as cabane://actor/agent/claude
   cabane done <id>
   ```

   The assignee is the runtime's plain name (`claude`, `codex`, `hermes`), matched exactly;
   the actor URI goes on `--as`. The claim is `in_progress`; a runtime must not take a task
   another one already holds.
   Push happens after each write; pull is the schedule from step 5.

## Gate

```bash
bun install
bun run check       # biome lint + format
bun run typecheck   # tsc --noEmit per package
bun run test        # bun packages, then the Worker suite under vitest
```

Lefthook runs `biome check --write` on staged files and `typecheck` when `.ts`
files are staged, on every commit.

## Try a change without touching your own device

```bash
bun run sandbox                # first-run setup, then the board, on a throwaway device
bun run sandbox list           # any cabane command, inside the sandbox's git repo
bun run sandbox --fresh        # start over
bun run sandbox --harnesses    # also let setup install into harness configs under the sandbox
```

The sandbox is its own `CABANE_HOME` plus a seeded git repo in the system temp directory,
one per checkout. By default setup finds no agents, so nothing is registered in your real
Claude Code, Codex or Gemini config. `--harnesses` gives the harnesses a sandbox HOME, so
the install step runs for real, but a harness may not be logged in there: try the copilot
without it.
