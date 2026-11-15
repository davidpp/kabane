# @cabane/sqlite

The storage adapter: core's `Db` port over `bun:sqlite`, for devices. It is one file,
`index.ts`, exporting `SqliteDb.provider(options)` (a `DbProvider`) and `adapt(db)`. It opens
one database file per unit of work under a base directory, keeps one idle connection per file
so the WAL is not rebuilt on every open, sets WAL, foreign keys and a busy timeout on each open,
and retries `SQLITE_BUSY` with jittered backoff.

## It depends on core alone, and only a host depends on it at runtime

Its layer is `storage adapter`; what it and every other package may list is its entry in
`scripts/layers.ts` (`"@cabane/sqlite"`), and `bun run layers` fails anything else. Other
packages take it only as a `devDependency` for their tests; at runtime the CLI picks it
(`packages/cli/src/context.ts`, `configureRuntime`). The hub runs on Durable Object SQLite
instead (`packages/worker/src/db-do.ts`), so nothing that must run in Workers may import this
package.

## The port is defined in core, and both adapters must pass the same cases

- `packages/core/db/port.ts` defines `Db` and `DbProvider`. This package implements them; it
  never adds a method the port lacks. A change to the port is a core change, made there first.
- `packages/core/db/conformance.ts` holds the cases every adapter must pass.
  `conformance.test.ts` here runs them under `bun:test`; `packages/worker/src/hub.test.ts`
  runs the same cases against `DoDb` under vitest. A behaviour storage relies on belongs in
  those cases, so the two engines cannot drift.

Read before writing: `index.ts`, `conformance.test.ts`, `hold.test.ts`.

## Verify

```bash
bun test packages/sqlite          # conformance, the held connection, the end-to-end smoke
bun run --cwd packages/worker test   # the other adapter, when a conformance case changed
```

`smoke.test.ts` is core's end-to-end smoke over this adapter. Every CLI command runs on this
package, so `bun run sandbox list` after a change is the real path in one line.

## Mistakes that are easy to make here

- Keeping a handle across units of work, or sharing one between processes. Storage is written
  for open-per-unit; the held connection exists only to keep the WAL, and it closes after
  `holdIdleMs`.
- Reordering the pragmas. `busy_timeout` goes first so `journal_mode = WAL` does not throw
  `SQLITE_BUSY` under a concurrent writer (the comment above `applyPragmas`).
- Retrying an error that is not `SQLITE_BUSY`, which turns a real failure into a slow one.
