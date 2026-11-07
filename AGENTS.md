# Kabane

Local-first issue tracker and kanban for humans and AI agent runtimes. The project was called
Cabane before its first public release; the workspace packages (`@cabane/*`), the
`cabane-worker` Worker and the `cabane://actor/...` URIs keep that name, because rows and
deployed hubs store it.

## Shape

```
packages/
├── core/      # @cabane/core   — schemas, storage over the Db port, sync (oplog, resolve, apply), MCP tool defs
├── sqlite/    # @cabane/sqlite — Db adapter over bun:sqlite (local devices)
├── acp/       # @cabane/acp    — ACP client over Bun.spawn: harness registry, session runner, own Update union
├── extension/ # @cabane/extension — extension contract (Command, Ctx, board ports), args, outcomes
├── questions/ # @cabane/questions — data module: decisions agents ask humans (kabane_ask, kabane_questions, kabane_answer)
├── cli/       # kabane         — add, list, show, edit, done, search, link, sync, board, mcp (stdio)
├── board/     # @cabane/board  — OpenTUI kanban; ActivitySource + Dispatcher + Copilot ports, no-op defaults
└── worker/    # cabane-worker  — Cloudflare Worker: sync log DO + cloud device on DO SQLite serving MCP over Streamable HTTP
extensions/
└── loop/      # @cabane/loop   — drives a parent issue's subtasks through ACP harnesses from a detached runner
```

Two runtimes: Bun (devices) and Cloudflare Workers (the hub). The same core runs in both.
Local SQLite is authoritative on every device. The hub is one more device that has a public URL.

## Conventions

See `CODING_PRINCIPLE.md` for the coding rules and the architectural invariants.

Read the North Stars at the top of `PRODUCT.md` before a product or architecture decision.
They are provisional: when one looks wrong, say so to the maintainer; never work around it
quietly.

For project, code, or pull-request reviews, use
`.agents/skills/review-oss-typescript/SKILL.md` and judge the repository as a
public TypeScript project.

## Gate

```bash
bun run check        # oxlint, its type-aware pass, oxfmt --check, knip, jscpd
bun run typecheck    # tsc --noEmit in every workspace package
bun test             # bun packages only (questions, core, sqlite, acp, extension, cli, board, extensions/*)
bun run test         # the above plus `bun run --cwd packages/worker test` (tsc + vitest)
```

To run the CLI or the TUI live, use `bun run sandbox [kabane args]` (README, "Try a change
without touching your own device"). It gives kabane a throwaway `KABANE_HOME` and git repo
and keeps setup from registering in the real harness configs. Never run a live check
against `~/.kabane`: on a contributor's machine it is their real tracker.

Root `bun test` must name the bun packages: a bare `bun test` sweeps the Worker's
vitest files it cannot execute. `bun run fix` applies oxlint's fixes and oxfmt.
Lefthook runs oxfmt on staged files, both oxlint passes on staged `.ts`/`.tsx`, and
`typecheck` when `.ts` files are staged.

Both oxlint passes deny warnings, in `bun run lint` and in lefthook: a warning fails the
commit and the gate. Fix the cause; never relax a threshold, disable a rule, or add a
suppression to get past one.

## Validating a UI change

Look at a component with the gallery. It prints the frame the render tests capture, at a
size and theme you pick. Add a story to `packages/board/src/stories/index.tsx` when the
state you changed has none, and build it from the fixtures in `stories/fixtures.ts`:

```bash
bun run gallery --list
bun run gallery --print form-described --width 80 --theme dark
bun run gallery --print permission --width 40 --theme light --ansi   # with its colors
```

Drive a flow in the real board under tmux, on its own socket and at fixed dimensions,
with the copilot on the scripted agent (keywords in `packages/acp/scripts/scripted-agent.ts`):

```bash
tmux -L ui new-session -d -s board -x 100 -y 30 'bun run sandbox --scripted board'
sleep 4
tmux -L ui send-keys -t board Tab
tmux -L ui send-keys -t board -l 'ask form'
tmux -L ui send-keys -t board Enter
sleep 2
tmux -L ui capture-pane -p -t board      # the form, as the human sees it
tmux -L ui send-keys -t board 2          # answer it the way a human would
tmux -L ui send-keys -t board Enter      # and leave its optional Other box empty
sleep 1
tmux -L ui capture-pane -p -t board      # the copilot's row says what the agent received
tmux -L ui send-keys -t board q          # quit the board, which ends the session
```

`o` on the board opens the copilot's transcript, with every turn and what the agent
received. Send `Escape` on its own and wait before the next key: an escape followed at once
by a key arrives as alt and that key. Use your own `-L` socket and never `kill-server`
without one: the default server holds the human's sessions. Mouse clicks are out of reach here; list them as a manual check.
A scripted ask does not prove a real harness sends that shape, so a change to how asks
arrive still needs a run against a real one.

## Constraints for agents

- One concern per commit.
- Never deploy to Cloudflare from an agent. `wrangler dev`, `wrangler deploy --dry-run` and
  `@cloudflare/vitest-pool-workers` only. Deploys, DNS, and Access changes are manual steps
  written into `docs/deploy.md`.
- Machine-local instructions (a maintainer's own tracker scope, issue ids, worktree habits,
  hub) belong in a gitignored `CLAUDE.local.md`, never in this file. A clean clone has none.
  Claude Code reads `CLAUDE.local.md` after these instructions. Codex has no per-project
  local file: an `AGENTS.override.md` replaces `AGENTS.md` in its directory, so one at the
  root would hide everything here. Codex's personal instructions are global, for every
  project: `$CODEX_HOME/AGENTS.md` (default `~/.codex/AGENTS.md`), which an
  `AGENTS.override.md` beside it replaces.
