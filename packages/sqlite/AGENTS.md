# @kabane/sqlite

The storage adapter: core's `Db` port over `bun:sqlite`, for devices. The hub runs on Durable
Object SQLite instead (`packages/worker/src/db-do.ts`).

## The port is defined in core, and both adapters pass the same cases

`packages/core/db/port.ts` defines `Db` and `DbProvider`; this package never adds a method the
port lacks. `packages/core/db/conformance.ts` holds the cases every adapter passes:
`conformance.test.ts` here runs them under `bun:test`, and `packages/worker/src/hub.test.ts`
runs them against `DoDb` under vitest. A behaviour storage relies on belongs in those cases.

## Verify

```bash
bun test packages/sqlite               # conformance, the held connection, core's end-to-end smoke
bun run --cwd packages/worker test     # the other adapter, when a conformance case changed
bun run sandbox init                   # once per fresh sandbox, then:
bun run sandbox list                   # a command that opens the record, on this adapter
```

## Mistakes that are easy to make here

- A side effect inside a `withDb` callback that cannot run twice. A busy retry reruns the whole
  callback, not the statement that failed (the retry loop in `withDb`).
- Keeping a handle across units of work. Storage is written for open-per-unit; the held
  connection exists only to keep the WAL, and it closes after `holdIdleMs`.
