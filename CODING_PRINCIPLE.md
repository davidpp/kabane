# Coding Principles — Kabane

The rules this repository holds itself to. Each one is true of the code today; a change that breaks one either fixes the code or changes this file in the same commit.

## Research. Then build.

1.  Understand — restate the task; name assumptions.
2.  Read — the relevant package and its `CLAUDE.md`, not the whole repo.
3.  Prior art — search for the canonical helper, schema, or port before adding one.
4.  Flag unknowns — surface ambiguities and decisions BEFORE code.

## Non-negotiables

- **TypeScript strict.** No `as any`, no non-null `!`, no `@ts-ignore` or `@ts-expect-error`. Narrow with a check or a schema instead.
- **Plain `zod` for domain schemas, `safeParse` only.** External data (MCP inputs, sync payloads, settings files) is `unknown` until a schema accepts it. Schema = type = validation.
- **`Result<T>`, never throw.** Every fallible function returns `Result` (`packages/core/result.ts`). The one sanctioned `throw` is inside a transaction body, to roll it back; the function that opened the transaction returns it as an `err`.
- **Namespaces over classes.** Related types and functions live in a namespace or a plain object of named functions. Classes exist only where a framework demands a subclass: the Worker's Durable Objects and the board's React error boundary. Each says why at its declaration and holds as little logic as the framework allows.
- **Explicit dependencies.** The core reads no environment variables. A host wires a `DbProvider`, tracer, notifier, actor, and settings source through `Runtime.configure`; every port but the provider has a no-op default.
- **Co-located tests.** A test sits beside the code it tests as `*.test.ts`. No `test/` directories.

## Working posture

YAGNI · DRY · boyscout rule · KISS · obvious correctness over cleverness · every abstraction layer must justify its existence · readable diffs · fail fast.

- **Verify before done** — `bun run check`, `bun run typecheck`, and `bun run test` pass before any commit claim.
- **Errors are DX** — say what failed, with which input, and what to do next, in one line.

## Architectural invariants

- **Local SQLite is authoritative on every device.** Sync is off by default, and a device works with no network.
- **The hub is one more device.** The Worker runs the same core on Durable Object SQLite, arms capture under its own device id, and pushes and pulls through the log like any other device. The Worker also hosts that log; the cloud device reaches it through a stub instead of HTTP and gets no other privilege.
- **The oplog is append-only and sync converges by it.** Every write to a replicated table ends with an `Oplog` capture in the storage layer, never a trigger. The log assigns a total order, and `sync/resolve.ts` breaks ties the same way on every device, so any two devices that applied the same ops hold the same rows. Convergence is asserted against the in-process relay (`sync/local-relay.ts`), with no Cloudflare.
- **A private row never enters the oplog.** The filter is the row's `visibility` column, whichever table it lives in.
- **The same core runs in Bun and in Workers.** It talks to storage only through the `Db` port. Runtime-specific calls stay on device-only paths: filesystem and git scope detection is off the barrel (`packages/core/scope`), and the few Bun or Node calls reachable from it (`file:` deref, commit scanning, the device's hostname) are never called by the hub or degrade when absent.
- **Migrations are numbered and append-only.** Version = list index + 1, each applied once in its own transaction. Never edit or reorder a shipped migration; append one. This rule is held by review, not by a check.

## Invariants at construction

A property stated in a comment, a doc, or a call-site guard fails silently the day someone forgets it. A property the code makes true at construction does not.

- **The review question** — if a comment or doc states a property, ask why it is not enforced. If it cannot be, say so beside the claim, so the next reader does not mistake a missing guard for an oversight.
- **The corollary** — a claim about behaviour deserves a test that fails when the claim stops being true. Delete the enforcement and watch the test go red.
- **Sweep the class, not the instance** — before closing a fix, ask what else has this shape.
