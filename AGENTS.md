# Kabane

Local-first issue tracker and kanban for humans and AI agent runtimes.

## Shape

```
packages/
├── core/      # @kabane/core   — schemas, storage over the Db port, sync, MCP tool defs
├── sqlite/    # @kabane/sqlite — Db adapter over bun:sqlite (local devices)
├── acp/       # @kabane/acp    — ACP client that drives coding harnesses
├── extension/ # @kabane/extension — the extension contract and its helpers
├── questions/ # @kabane/questions — data module: decisions agents ask humans
├── checklist/ # @kabane/checklist — data module: the steps of one issue
├── outcome/   # @kabane/outcome — data module: session outcomes on the issue timeline
├── handoff/   # @kabane/handoff — data module: the handoff entry kind
├── cli/       # kabane         — the device host: commands, `kabane mcp` (stdio)
├── board/     # @kabane/board  — OpenTUI kanban and ACP copilot
└── worker/    # kabane-worker  — the hub: Cloudflare Worker, sync log and cloud device
extensions/
├── loop/      # @kabane/loop   — drives an issue or its subtasks through harnesses
├── dispatch/  # @kabane/dispatch — the dispatch skill template and its doctor checks
└── jobs/      # @kabane/jobs   — recipes, `kabane run`, `runs` and `job` over hc terminals
```

Two runtimes: Bun (devices) and Cloudflare Workers (the hub). The same core runs in both.
Local SQLite is authoritative on every device. The hub is one more device that has a public URL.

## Conventions

See `CODING_PRINCIPLE.md` for the coding rules and the architectural invariants.

Read `ARCHITECTURE.md` before you add a package, a dependency between packages, anything to
`packages/core` or a field to the extension contract: it says what each layer owns and what an
extension gets from kabane.

`docs/` and the READMEs are for people who use kabane: usage, behaviour, configuration.
Internal notes such as plans, design records and research go in `wiki/`, never in `docs/`.

A lasting trade-off that someone will ask "why" about later gets an ADR in `wiki/adr/`: one
page, numbered, from `wiki/adr/0000-template.md`. `wiki/adr/README.md` says when to write one. An
issue that relies on an ADR attaches it with `kabane_contextAdd` (kind `ADR`, a `file:`
reference), so it lands in the implementer's brief.

Read the North Stars at the top of `PRODUCT.md` before a product or architecture decision.
They are provisional: when one looks wrong, say so to the maintainer; never work around it
quietly.

For project, code, or pull-request reviews, use
`.agents/skills/review-oss-typescript/SKILL.md` and judge the repository as a
public TypeScript project.

Before implementing a change, whatever its size, use `.agents/skills/dispatch/SKILL.md`.

## Gate

```bash
bun run check        # layers, oxlint, its type-aware pass, oxfmt --check, knip, jscpd
bun run typecheck    # tsc --noEmit in every workspace package
bun run test:bun     # every bun package; a bare `bun test` also sweeps the Worker's vitest files
bun run test         # the above plus `bun run --cwd packages/worker test` (tsc + vitest)
```

To run the CLI or the TUI live, use `bun run sandbox [kabane args]` (README, "Try a change
without touching your own device"). It gives kabane a throwaway `KABANE_HOME` and git repo
and keeps setup from registering in the real harness configs. Never run a live check
against `~/.kabane`: on a contributor's machine it is their real tracker.

`bun run fix` applies oxlint's fixes and oxfmt. A lint warning fails the commit and the gate:
fix the cause; never relax a threshold, disable a rule, or add a suppression to get past one.

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
  the Worker's vitest tests only. Deploys, DNS, and Access changes are manual steps written
  into `docs/deploy.md`.
- Machine-local instructions (a maintainer's own tracker scope, issue ids, worktree habits,
  hub) belong in a gitignored `CLAUDE.local.md`, never in this file. Not in an
  `AGENTS.override.md` either: Codex reads one instead of the `AGENTS.md` beside it.

## Tracker

Work is tracked in kabane (MCP server `kabane`). Your assignee name is your harness: `claude`, `codex` or `gemini`.
- Before starting, `kabane_list` with `assignee` set to your name, `state: "next"`, and `responseFormat: "concise"`. If no suitable task is on the page and `hasMore` is true, follow `nextCursor` with the same filters; only assert no work remains after `hasMore` is false. Read the chosen task with `kabane_context` and `responseFormat: "concise"`; consume every preceding chunk and continue with `nextCursor` until `selectedComplete`, `descriptionComplete`, and `humanSteeringComplete` are true before starting work. Use the same id/options; request any omitted required sections.
- Set the task `in_progress` with `kabane_edit` and `responseFormat: "concise"` before touching code. Never take a task that is already in progress.
- When finished, hand the task off with `kabane_handoff`: what landed, the evidence of what you checked, and what you did not verify. `kabane_comment` is for notes along the way. Check write results for errors before `kabane_done` with `responseFormat: "concise"`.
- File new work you find with `kabane_add` and `responseFormat: "concise"` instead of doing it unasked. Use `kabane_get` for full own fields.
