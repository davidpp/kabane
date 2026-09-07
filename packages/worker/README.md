# cabane-worker

The Cabane hub on Cloudflare Workers: `CabaneLog` (the ordered sync oplog) and
`CabaneHub` (the cloud device that runs the core on DO SQLite and serves MCP).
Both are stubs in this slice; only `GET /health` answers.

```bash
bun run --cwd packages/worker test   # tsc --noEmit && vitest run
bun run --cwd packages/worker dev    # wrangler dev on localhost
```

Deploys are manual and documented in `docs/deploy.md` once it exists. Never run
`wrangler deploy` from an agent.

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
- **Dependencies are pinned exactly.** Bun's `minimum-release-age` install policy
  rejects anything published in the last 5 days, so a `^` range on a daily-release
  package like `wrangler` fails to resolve.
- **`new_sqlite_classes`, not `new_classes`.** Both objects keep their state in DO
  SQLite; that is the storage the whole design rests on.
- **No `workers.dev`, no preview URLs.** Cloudflare Access on `cabane.3pew.ca` is the
  only front door. `bindings.d.ts` is hand-written so secrets, which never appear
  in `wrangler.jsonc`, are not silently dropped from `Env`.
