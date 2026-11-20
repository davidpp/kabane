# @kabane/sqlite

The storage adapter: core's `Db` port over `bun:sqlite`, for devices. It is one file,
`index.ts`, exporting `SqliteDb.provider(options)` (a `DbProvider`) and `adapt(db)`. It opens
one database file per unit of work under a base directory, keeps one idle connection per file
so the WAL is not rebuilt on every open, sets WAL, foreign keys and a busy timeout on each open,
and retries `SQLITE_BUSY` with jittered backoff.

## Only a host depends on it at runtime

Its layer is `storage adapter`; its entry in `scripts/layers.ts` (`"@kabane/sqlite"`) says what
it may list, and `bun run layers` fails anything else. Other packages take it as a
`devDependency` for tests; at runtime the CLI picks it (`configureRuntime` in
`packages/cli/src/context.ts`). The hub runs on Durable Object SQLite instead
(`packages/worker/src/db-do.ts`), so nothing that must run in Workers imports this package.

## The port is defined in core, and both adapters pass the same cases

`packages/core/db/port.ts` defines `Db` and `DbProvider`; this package never adds a method the
port lacks. `packages/core/db/conformance.ts` holds the cases every adapter passes:
`conformance.test.ts` here runs them under `bun:test`, and `packages/worker/src/hub.test.ts`
runs them against `DoDb` under vitest. A behaviour storage relies on belongs in those cases.

Read before writing: `index.ts`, `conformance.test.ts`, `hold.test.ts`.

## Verify

```bash
bun test packages/sqlite               # conformance, the held connection, core's end-to-end smoke
bun run --cwd packages/worker test     # the other adapter, when a conformance case changed
bun run sandbox init                   # once per fresh sandbox, then:
bun run sandbox list                   # a command that opens the record, on this adapter
```

Not every command opens the record: `help` and the commands marked `standalone` start with a
context that has no runtime (`bareCtx` in `packages/cli/src/main.ts`).

## Mistakes that are easy to make here

- A side effect inside a `withDb` callback that cannot run twice. A busy retry reruns the whole
  callback, not the statement that failed (the retry loop in `withDb`, `index.ts:165`).
- Keeping a handle across units of work. Storage is written for open-per-unit; the held
  connection exists only to keep the WAL, and it closes after `holdIdleMs`.
- Reordering the pragmas. `busy_timeout` goes first so `journal_mode = WAL` does not throw
  `SQLITE_BUSY` under a concurrent writer (the comment above `applyPragmas`).
