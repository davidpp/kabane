# Cabane

Local-first issue tracker and kanban for humans and AI agent runtimes. Every device
keeps an authoritative SQLite; devices converge through an append-only oplog relayed
by a Cloudflare Durable Object. A hub Worker runs the same core on DO SQLite and
serves MCP, so browser-only tools (ChatGPT, Claude.ai) and CLI-capable runtimes
(Claude Code, Hermes, Codex) share one tool surface. Extracted from Jake's planner;
decision record in `~/Projects/jake/docs/ADR/032-cabane-extraction.md`.

| Package | Name | Runtime | Holds |
|---|---|---|---|
| `packages/core` | `@cabane/core` | Bun + Workers | schemas, storage over the Db port, sync, MCP tool definitions |
| `packages/sqlite` | `@cabane/sqlite` | Bun | Db adapter over `bun:sqlite` |
| `packages/cli` | `cabane` | Bun | the device command line |
| `packages/board` | `@cabane/board` | Bun | OpenTUI kanban over ActivitySource and Dispatcher ports |
| `packages/worker` | `cabane-worker` | Workers | sync log DO + cloud device serving MCP |

## Gate

```bash
bun install
bun run check       # biome lint + format
bun run typecheck   # tsc --noEmit per package
bun test            # bun packages; the Worker suite runs under vitest
bun run test        # both runners
```

Lefthook runs `biome check --write` on staged files and `typecheck` when `.ts`
files are staged, on every commit.
