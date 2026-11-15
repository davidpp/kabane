# cabane-worker (packages/worker)

The hub: a Cloudflare Worker with two SQLite-backed Durable Objects behind Cloudflare Access.
`CabaneLog` (`src/log.ts`) is the ordered sync log every device pushes to and pulls from.
`CabaneHub` (`src/hub.ts`) is the cloud device: core's storage on the object's SQLite through
`DoDb` (`src/db-do.ts`), serving MCP over Streamable HTTP and syncing with the log as device
`cloud`. `src/index.ts` is the edge: Access verification, then routing. `README.md` holds the
routes, the Access mapping, the configuration and a list of platform facts under "Notes for
whoever touches this next"; read that list before changing anything here.

## It depends on core and the data modules alone, because it runs in Workers

Its layer is `hub`; its entry in `scripts/layers.ts` (`cabane-worker`) says what it may list,
and `bun run layers` fails anything else. Workers cannot run `@cabane/sqlite`, `@cabane/acp`,
the board or an extension, so the hub never serves an extension's tools or registers an
extension's modules; ops for a module it lacks are parked like any device's.

The hub registers the data modules in `src/hub.ts` (`modules: [questionsModule, handoffModule,
checklistModule]`), the same list and order as `MODULES` in `packages/cli/src/context.ts`. A
module added on one host and not the other gives the hub a different tool list and brief.

`tsconfig.json` lists `bun` in `types` only because core's lint collectors and its `file:`
deref reference Bun globals. JCAB-326 (lint) and JCAB-328 (a file reader port on
`Runtime.configure`) remove that reason, and `bun` then leaves this `tsconfig.json`. JCAB-328
also moves `handleHttpRequest` from `packages/core/mcp/server.ts` into this package.
JCAB-331 is moving `src/concise-mcp.test.ts`'s fixture import now.

Read before writing: `src/hub.ts`, `src/db-do.ts`, `src/hub-mcp.test.ts`.

## Verify

```bash
bun run --cwd packages/worker test    # tsc --noEmit, then vitest in the Workers pool
bun run --cwd packages/worker dev     # wrangler dev on localhost; needs a .dev.vars
```

`bun test` cannot run these tests: they need `@cloudflare/vitest-pool-workers`. Sync
convergence between devices is asserted in core against the in-process relay
(`packages/core/sync/local-relay.ts`), with no Cloudflare. A change to the Db port runs core's
conformance cases here (`src/hub.test.ts`) and in `packages/sqlite`. Never deploy from an
agent; `wrangler deploy --dry-run` is the furthest a check goes, and deploys are written into
`docs/deploy.md` for a human.

## Mistakes that are easy to make here

- Assuming storage is isolated between tests. Rows persist across tests in pool-workers 0.18
  and later; give each test its own Durable Object name.
- More than 100 bound parameters in one statement, or a `BEGIN` or `SAVEPOINT`: the engine
  refuses both (README, "The Db port over Durable Object SQLite").
- A `^` range on a dependency. Everything is pinned exactly, because the install policy refuses
  a package published in the last five days.
- Putting a secret or an Access identity in `wrangler.jsonc`. Secrets go through
  `wrangler secret put`, and `ACCESS_DEV_UNVERIFIED` never leaves `.dev.vars` and the vitest
  config.
- Importing a Bun or Node API the hub cannot run. The README names the two Node modules the
  hub uses under `nodejs_compat` (`node:os`, `node:async_hooks`); a new one needs the vitest
  suite to run it in the Workers pool before it is relied on.
