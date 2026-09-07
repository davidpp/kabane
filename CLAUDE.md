# Cabane

Local-first issue tracker and kanban for humans and AI agent runtimes. Extracted from Jake's
planner (`~/Projects/jake/packages/planner`, `packages/tui`, `workers/planner-sync`); Jake
becomes a consumer. Decision record: `~/Projects/jake/docs/ADR/032-cabane-extraction.md`.

## Shape

```
packages/
├── core/      # @cabane/core   — schemas, storage over the Db port, sync (oplog, resolve, apply), MCP tool defs
├── sqlite/    # @cabane/sqlite — Db adapter over bun:sqlite (local devices)
├── cli/       # cabane         — add, list, show, edit, done, search, link, sync, board, mcp (stdio)
├── board/     # @cabane/board  — OpenTUI kanban; ActivitySource + Dispatcher ports, no-op defaults
└── worker/    # cabane-worker  — Cloudflare Worker: sync log DO + cloud device on DO SQLite serving MCP over Streamable HTTP
```

Two runtimes: Bun (devices) and Cloudflare Workers (the hub). The same core runs in both.
Local SQLite is authoritative on every device. The hub is one more device that has a public URL.

## Conventions

Inherited verbatim from Jake's `CONVENTIONS.md`: namespaces over classes (a `DurableObject`
subclass is the one framework-imposed exception), `Result<T>` never throw, explicit
dependencies, co-located `*.test.ts`, `safeParse` only, no `as any`, no `!`, no `@ts-ignore`.
Plain `zod` for domain schemas. Biome for lint and format.

Gate: `bun run check && bun run typecheck && bun test` at the root; the Worker suite runs
under vitest via `bun run --cwd packages/worker test` and is invoked by the root `test` script.

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
