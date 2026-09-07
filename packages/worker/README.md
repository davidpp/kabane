# cabane-worker

The Cabane hub on Cloudflare Workers, two SQLite-backed Durable Objects behind
Cloudflare Access at `cabane.3pew.ca`:

- **`CabaneLog`** is the ordered sync oplog every device pushes to and pulls
  from. Two tables, opaque JSON payloads, no planner schema. Moved verbatim
  from Jake's `workers/planner-sync` apart from names.
- **`CabaneHub`** is the cloud device: the `@cabane/core` storage running on
  this object's SQLite through the `Db` port, serving MCP over Streamable HTTP,
  and syncing with `CabaneLog` under the device identity `cloud`.

```bash
bun run --cwd packages/worker test   # tsc --noEmit && vitest run
bun run --cwd packages/worker dev    # wrangler dev on localhost, needs .dev.vars
```

Deploys are manual and documented in [`docs/deploy.md`](../../docs/deploy.md) (part 1
builds the hub, part 5 operates it). Never run `wrangler deploy` from an agent.

## Access on every route

Every request, `/health` included, must carry a `Cf-Access-Jwt-Assertion` that
verifies against the team (`ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`) and names
someone the Worker knows (`src/access.ts`, same shape as FamilyOS):

| Assertion carries | Admitted when | Actor stamped on writes |
|---|---|---|
| `common_name` (a service token) | its client id is a key in `SERVICE_ACTORS` | the mapped URI, e.g. `cabane://actor/agent/hermes` |
| `email` (a human) | it equals `HUMAN_EMAIL` | `cabane://actor/human/<local part>` |

Anything else is `401`, before any stub is obtained. Empty `HUMAN_EMAIL` and
`SERVICE_ACTORS` mean nobody is admitted, which is the state a fresh deploy is
in until the runbook fills them. Browser connectors (ChatGPT, Claude.ai) reach
this through Access Managed OAuth, which ends in the same assertion; the Worker
holds no OAuth code (`docs/auth.md`).

`ACCESS_DEV_UNVERIFIED=true` trusts the assertion payload without checking its
signature. It exists for `wrangler dev` and the vitest suite (unsigned tokens
built by `src/test-access.ts`); it must never appear in `wrangler.jsonc`.

## Routes

| Route | Auth beyond Access | Request | Response |
|---|---|---|---|
| `GET /health` | none | | `{ ok, service, actor }` |
| `POST /push` | `Authorization: Bearer <SYNC_TOKEN>` | `{ deviceId, name?, ops: [{ opId, deviceId, ...opaque }] }` | `{ accepted, duplicates, head }` |
| `POST /pull` | `Authorization: Bearer <SYNC_TOKEN>` | `{ deviceId, sinceSeq, limit }` | `{ ops: [{ serverSeq, payload }], throughSeq, hasMore }` |
| `POST /mcp` | none | Streamable HTTP MCP, stateless, JSON responses | |

The log routes keep their own bearer check so a device presents two things: the
Access service token (its identity) and the log secret. A device configures
both through `sync.url`, `sync.token`, and `sync.headers` in `@cabane/core`'s
`SyncConfig`; the CLI's `config.json` carries them under `sync`. `GET /mcp`
(the SSE stream) is refused with `405`; each POST is a fresh server and
transport, so the object holds no MCP session state.

Measured against `wrangler dev`: a duplicate `opId` counts in `duplicates` and
still burns an `AUTOINCREMENT` value (after one duplicate the next op landed at
`server_seq` 4, not 3); a device pulling its own ops gets `ops: []` with
`throughSeq` advanced and `hasMore: true`. Only monotonicity of `server_seq` is
promised, and `throughSeq` is the cursor, never `ops.at(-1)`.

## The hub as a sync device (`src/hub.ts`)

On boot the hub arms capture as device `cloud` (`SyncDevice.arm`), so every
MCP write lands in its oplog like a CLI write does on a laptop. It reaches the
log through the `CabaneLog` stub (`src/log-transport.ts`), never HTTP, and:

- **after every MCP write** pushes in `waitUntil`, off the response path;
- **on an alarm every `SYNC_INTERVAL_MINUTES`** (default 5) pulls, applies,
  and pushes, then reschedules. The alarm never throws: a transient log failure
  waits for the next interval rather than triggering platform retries.

The actor for a request comes from the `X-Cabane-Actor` header the edge sets
after Access verification, read through an `AsyncLocalStorage` so concurrent
requests in one object cannot see each other's identity. Writes at the hub
require `scopeUri` (there is no working directory to detect one from); the
`cabane_scopeList` tool exists for that.

Verified live against `wrangler dev` with a CLI device: a task added on the
device and backfilled appeared in `cabane_list` at the hub after the alarm; a
task added at the hub as the Hermes service token appeared on the device after
`cabane sync pull`, and the short-id collision both sides produced (`JCAB-1`)
was repaired to the same label on both.

## Configure (what the runbook fills in)

| Where | Key | Value |
|---|---|---|
| `wrangler.jsonc` vars | `ACCESS_TEAM_DOMAIN` | `https://3pew.cloudflareaccess.com` |
| | `ACCESS_AUD` | the Access application's AUD tag |
| | `HUMAN_EMAIL` | the one human allowed in |
| | `SERVICE_ACTORS` | JSON, service-token client id → `cabane://actor/agent/<runtime>` |
| | `SYNC_INTERVAL_MINUTES` | scheduled pass interval, default `5` |
| `wrangler secret put` | `SYNC_TOKEN` | the log bearer secret every device carries |
| `.dev.vars` (local only) | all of the above plus `ACCESS_DEV_UNVERIFIED=true` | |

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

`src/access.test.ts` covers the principal mapping; `src/hub-mcp.test.ts` drives
the edge end to end (initialize, tools/list, every tool once, 401 and 405, actor
stamping for human and service, and both sync directions through the log,
including `runDurableObjectAlarm`). `src/hub.test.ts` runs the core's **Db port
conformance suite**
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
  `node:path` and `node:os` (session defaults, device name), and the hub uses
  `node:async_hooks` for the per-request actor.
- **The MCP SDK bundles fine.** `@modelcontextprotocol/sdk`'s low-level `Server`
  plus `WebStandardStreamableHTTPServerTransport` run under workerd; the
  high-level `McpServer` was avoided in core for a tsc reason (see
  `packages/core/mcp/server.ts`), not a runtime one.
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
