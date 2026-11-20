# kabane-worker (packages/worker)

The hub: a Cloudflare Worker with two SQLite-backed Durable Objects behind Cloudflare Access.
`KabaneLog` (`src/log.ts`) is the ordered sync log every device pushes to and pulls from.
`KabaneHub` (`src/hub.ts`) is the cloud device: core's storage on the object's SQLite through
`DoDb` (`src/db-do.ts`), serving MCP over Streamable HTTP and syncing with the log as device
`cloud`. `src/index.ts` is the edge: Access verification, then routing. `README.md` holds the
routes, the Access mapping, the configuration and a list of platform facts under "Notes for
whoever touches this next"; read that list before changing anything here.

## It depends on core and the data modules alone, because it runs in Workers

Its layer is `hub`; its entry in `scripts/layers.ts` (`kabane-worker`) says what it may list.
Workers cannot run `@kabane/sqlite`, `@kabane/acp`, the board or an extension, so the hub never
serves an extension's tools or registers an extension's modules; ops for a module it lacks are
parked like any device's.

The hub registers the first-party data modules in `src/hub.ts`, the same list and order as
`MODULES` in `packages/cli/src/context.ts`. A module added on one host and not the other gives
the hub a different tool list and brief.

`tsconfig.json` includes no Bun types: the hub's typecheck rejects Bun globals reachable from
core's production barrel. Core's file reader defaults to a pointer; the hub wires none.
`src/mcp-http.ts` owns `handleHttpRequest`, connecting core's server to stateless Streamable HTTP.

Read before writing: `src/hub.ts`, `src/db-do.ts`, `src/hub-mcp.test.ts`.

## Verify

```bash
bun run --cwd packages/worker test    # tsc --noEmit, then vitest in the Workers pool
bun run --cwd packages/worker dev     # wrangler dev on localhost; needs a .dev.vars
```

`bun test` cannot run these tests: they need `@cloudflare/vitest-plugin`. Sync
convergence between devices is asserted in core against the in-process relay
(`packages/core/sync/local-relay.ts`). A change to the Db port runs core's conformance cases
here (`src/hub.test.ts`) and in `packages/sqlite`. Deploys follow the root `AGENTS.md`.

## Mistakes that are easy to make here

- Reading the actor from anything but the request. Each request's actor runs in
  `actorStore.run`, so concurrent requests in one object never see each other's identity, and
  `humanActor` is set only when Access authenticated a human, never for a service token
  (`src/hub.ts:127`).
- Assuming storage is isolated between tests. Rows persist across tests under the Workers vitest
  plugin; give each test its own Durable Object name.
- More than 100 bound parameters in one statement, or a `BEGIN` or `SAVEPOINT`: the engine
  refuses both (README, "The Db port over Durable Object SQLite").
- Putting a secret or an Access identity in `wrangler.jsonc`. Secrets go through
  `wrangler secret put`, and `ACCESS_DEV_UNVERIFIED` never leaves `.dev.vars` and the vitest
  config.
