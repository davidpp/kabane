# Cabane

Local-first issue tracker and kanban for humans and AI agent runtimes. Extracted from Jake's
planner (`~/Projects/jake/packages/planner`, `packages/tui`, `workers/planner-sync`); Jake
becomes a consumer. Decision record: `~/Projects/jake/docs/ADR/032-cabane-extraction.md`.

## Shape

```
packages/
├── core/      # @cabane/core   — schemas, storage over the Db port, sync (oplog, resolve, apply), MCP tool defs
├── sqlite/    # @cabane/sqlite — Db adapter over bun:sqlite (local devices)
├── acp/       # @cabane/acp    — ACP client over Bun.spawn: harness registry, session runner, own Update union
├── cli/       # cabane         — add, list, show, edit, done, search, link, sync, board, mcp (stdio)
├── board/     # @cabane/board  — OpenTUI kanban; ActivitySource + Dispatcher + Copilot ports, no-op defaults
└── worker/    # cabane-worker  — Cloudflare Worker: sync log DO + cloud device on DO SQLite serving MCP over Streamable HTTP
```

Two runtimes: Bun (devices) and Cloudflare Workers (the hub). The same core runs in both.
Local SQLite is authoritative on every device. The hub is one more device that has a public URL.

## Conventions

See `CODING_PRINCIPLE.md` for the coding rules and the architectural invariants.

## Gate

```bash
bun run check        # oxlint, its type-aware pass, oxfmt --check
bun run typecheck    # tsc --noEmit in every packages/*/
bun test             # bun packages only (core, sqlite, acp, cli, board)
bun run test         # the above plus `bun run --cwd packages/worker test` (tsc + vitest)
```

To run the CLI or the TUI live, use `bun run sandbox [cabane args]` (README, "Try a change
without touching your own device"). It gives cabane a throwaway `CABANE_HOME` and git repo
and keeps setup from registering in the real harness configs. Never run a live check
against `~/.cabane`: on David's machine it is his real tracker.

Root `bun test` must name the bun packages: a bare `bun test` sweeps the Worker's
vitest files it cannot execute. `bun run fix` applies oxlint's fixes and oxfmt.
Lefthook runs oxfmt on staged files, both oxlint passes on staged `.ts`/`.tsx`, and
`typecheck` when `.ts` files are staged.

## Jake

- PRD parent: JCAB-1 (ids use the `JCAB-` prefix).
- scopeUri: `jake://scope/cabane`
- Commits: prefixed with the issue id (`JCAB-12 core: ...`), one concern per commit.
- Worktrees: `wt switch dp-<id>-<slug> --create`, then `bun install` in the worktree.
- Testing constraint: never deploy to Cloudflare from an agent. `wrangler dev` and
  `@cloudflare/vitest-pool-workers` only. Deploys, DNS, and Access changes are manual steps
  written into `docs/deploy.md`.
- Hosting target: `cabane.3pew.ca`, custom domain on the `cabane-worker` Worker, behind the
  `3pew.cloudflareaccess.com` Access team (same pattern as `familyos.3pew.ca` in `~/Projects/familyos/apps/familyos-api`).
