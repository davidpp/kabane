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
├── cli/       # kabane         — add, list, show, edit, done, search, link, sync, board, mcp (stdio)
├── board/     # @cabane/board  — OpenTUI kanban; ActivitySource + Dispatcher + Copilot ports, no-op defaults
└── worker/    # cabane-worker  — Cloudflare Worker: sync log DO + cloud device on DO SQLite serving MCP over Streamable HTTP
```

Two runtimes: Bun (devices) and Cloudflare Workers (the hub). The same core runs in both.
Local SQLite is authoritative on every device. The hub is one more device that has a public URL.

## Conventions

See `CODING_PRINCIPLE.md` for the coding rules and the architectural invariants.

## Gate

```bash
bun run check        # biome check .
bun run typecheck    # tsc --noEmit in every packages/*/
bun test             # bun packages only (core, sqlite, acp, cli, board)
bun run test         # the above plus `bun run --cwd packages/worker test` (tsc + vitest)
```

To run the CLI or the TUI live, use `bun run sandbox [kabane args]` (README, "Try a change
without touching your own device"). It gives kabane a throwaway `KABANE_HOME` and git repo
and keeps setup from registering in the real harness configs. Never run a live check
against `~/.kabane`: on a contributor's machine it is their real tracker.

Root `bun test` must name the bun packages: a bare `bun test` sweeps the Worker's
vitest files it cannot execute. Lefthook runs `biome check --write` on staged files
and `typecheck` when `.ts` files are staged.

## Constraints for agents

- One concern per commit.
- Never deploy to Cloudflare from an agent. `wrangler dev`, `wrangler deploy --dry-run` and
  `@cloudflare/vitest-pool-workers` only. Deploys, DNS, and Access changes are manual steps
  written into `docs/deploy.md`.
- Machine-local instructions (a maintainer's own tracker scope, issue ids, worktree habits,
  hub) belong in a gitignored `CLAUDE.local.md`, never in this file. A clean clone has none.
