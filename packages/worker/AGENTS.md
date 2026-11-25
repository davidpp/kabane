# kabane-worker (packages/worker)

The hub: a Cloudflare Worker with two SQLite-backed Durable Objects behind Cloudflare Access.
`KabaneLog` (`src/log.ts`) is the ordered sync log every device pushes to and pulls from.
`KabaneHub` (`src/hub.ts`) is the cloud device: core's storage on the object's SQLite through
`DoDb` (`src/db-do.ts`), serving MCP over Streamable HTTP and syncing with the log as device
`cloud`. `README.md` holds the
routes, the Access mapping, the configuration and a list of platform facts under "Notes for
whoever touches this next"; read that list before changing anything here.

## It depends on core and the data modules alone, because it runs in Workers

Workers cannot run `@kabane/sqlite`, `@kabane/acp`, the board or an extension, so the hub never
serves an extension's tools or registers an extension's modules; ops for a module it lacks are
parked like any device's.

The hub registers the first-party data modules in `src/hub.ts`, the same list and order as
`MODULES` in `packages/cli/src/context.ts`. A module added on one host and not the other gives
the hub a different tool list and brief.

## Verify

```bash
bun run --cwd packages/worker test    # tsc --noEmit, then vitest in the Workers pool
bun run --cwd packages/worker dev     # wrangler dev on localhost; needs a .dev.vars
```

`bun test` cannot run these tests: they need `@cloudflare/vitest-plugin`. Deploys follow the
root `AGENTS.md`.

## Mistakes that are easy to make here

- Reading the actor from anything but the request. Each request's actor runs in
  `actorStore.run`, so concurrent requests in one object never see each other's identity, and
  `humanActor` is set only when Access authenticated a human, never for a service token.
- Assuming storage is isolated between tests. Rows persist across tests under the Workers vitest
  plugin; give each test its own Durable Object name.
- More than 100 bound parameters in one statement, or a `BEGIN` or `SAVEPOINT`: the engine
  refuses both (README, "The Db port over Durable Object SQLite").
- Putting a secret or an Access identity in `wrangler.jsonc`. Secrets go through
  `wrangler secret put`, and `ACCESS_DEV_UNVERIFIED` never leaves `.dev.vars` and the vitest
  config.
