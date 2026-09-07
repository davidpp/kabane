# cabane-worker

The Cabane hub on Cloudflare Workers, two SQLite-backed Durable Objects:

- **`CabaneLog`** is the ordered sync oplog every device pushes to and pulls
  from. Two tables, opaque JSON payloads, no planner schema. Moved verbatim
  from Jake's `workers/planner-sync` apart from names.
- **`CabaneHub`** is the cloud device: the `@cabane/core` storage running on
  this object's SQLite through the `Db` port. This slice boots the schema and
  proves storage works; the MCP surface, Cloudflare Access verification, and
  the sync loop against `CabaneLog` arrive with JCAB-7.

```bash
bun run --cwd packages/worker test   # tsc --noEmit && vitest run
bun run --cwd packages/worker dev    # wrangler dev on localhost
```

Deploys are manual and documented in `docs/deploy.md` once it exists. Never run
`wrangler deploy` from an agent.

## Routes

`GET /health` is open. Everything else needs `Authorization: Bearer <SYNC_TOKEN>`
before a stub is obtained, so an unauthenticated request never wakes an object.
Both log routes are `POST`:

| Route | Request | Response |
|---|---|---|
| `/push` | `{ deviceId, name?, ops: [{ opId, deviceId, ...opaque }] }` | `{ accepted, duplicates, head }` |
| `/pull` | `{ deviceId, sinceSeq, limit }` | `{ ops: [{ serverSeq, payload }], throughSeq, hasMore }` |

Measured against `wrangler dev`: a duplicate `opId` counts in `duplicates` and
still burns an `AUTOINCREMENT` value (after one duplicate the next op landed at
`server_seq` 4, not 3); a device pulling its own ops gets `ops: []` with
`throughSeq` advanced and `hasMore: true`. Only monotonicity of `server_seq` is
promised, and `throughSeq` is the cursor, never `ops.at(-1)`.

## The Db port over Durable Object SQLite (`src/db-do.ts`)

`DoDb.provider(ctx.storage)` adapts one object's `SqlStorage` to the core's
`DbProvider`. `basePath` is ignored: one object owns one database. Three
platform facts shape it:

- `BEGIN` and `SAVEPOINT` are refused, so `transaction` is `transactionSync`
  and `atomic` (awaits allowed between statements) is `storage.transaction`.
- At most 100 bound parameters per statement. Bulk inserts pass one JSON
  parameter and unpack with `json_each`; the adapter does not paper over the cap.
- `rowsWritten` counts index writes, so `changes` comes from `SELECT changes()`.

`PRAGMA user_version` is unsupported; the log keeps its version in
`_sql_schema_migrations`. `CREATE TRIGGER` works on this engine: the core's FTS
triggers apply and the conformance suite asserts they exist.

## Tests

`src/hub.test.ts` runs the core's **Db port conformance suite**
(`conformanceCases()` from `@cabane/core`, the same cases `packages/sqlite`
runs under `bun:test`) against `DoDb`, then a storage smoke over the hub: add,
link, FTS search, agent session with activity, comment, `assembleContext`.

The core's own 21 storage and sync test files do not run here: every one
imports `bun:test`, and 18 open scratch databases through `bun:sqlite` and
`node:fs` temp dirs. The smoke covers the same entry points on DO SQLite.

## Notes for whoever touches this next

- **Vitest, not `bun test`.** The suite uses `@cloudflare/vitest-pool-workers`, which
  only runs under vitest. The root `test` script invokes it after the bun packages.
- **Tests do not get isolated storage.** pool-workers >= 0.18 (the vitest 4 line)
  dropped the `isolatedStorage` option, and rows persist between tests even though
  the upstream README still advertises isolation. Give each test its own DO name,
  or assert relative to what a write returned.
- **`defineWorkersConfig` is gone** since 0.18. The pool is a Vite plugin now:
  `cloudflareTest()` from `@cloudflare/vitest-pool-workers`, inside `plugins: []`.
  Every tutorial online still shows the old shape.
- **`/types` is where `cloudflare:test` is declared.** `tsconfig.json` lists
  `@cloudflare/vitest-pool-workers/types`, not the package root.
- **`bun` is in the worker's `types`** only because `@cabane/core`'s commit-linker,
  lint collectors and file-ref deref reference Bun globals and `tsc` walks the
  imported sources. The hub never calls those paths.
- **`nodejs_compat` is on.** Two core files reach for `node:fs/promises`,
  `node:path` and `node:os` (session defaults, device name).
- **Dependencies are pinned exactly.** Bun's `minimum-release-age` install policy
  rejects anything published in the last 5 days, so a `^` range on a daily-release
  package like `wrangler` fails to resolve.
- **`new_sqlite_classes`, not `new_classes`.** Both objects keep their state in DO
  SQLite; that is the storage the whole design rests on.
- **No `workers.dev`, no preview URLs.** Cloudflare Access on `cabane.3pew.ca` is the
  only front door. `bindings.d.ts` is hand-written so secrets, which never appear
  in `wrangler.jsonc`, are not silently dropped from `Env`.
- **Keep a push batch under ~1.5 MB.** The batch crosses as one bound parameter and
  parameter values are capped at 2 MB. One op over 2 MB poisons every retry that
  includes it; the device-side quarantine exists for exactly that.
