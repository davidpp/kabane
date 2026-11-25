# Coding Principles — Kabane

The rules this repository holds itself to. Each one is true of the code today; a change that breaks one either fixes the code or changes this file in the same commit.

## Non-negotiables

- **TypeScript strict.** No `as any`, no non-null `!`, no `@ts-ignore` or `@ts-expect-error`. Narrow with a check or a schema instead.
- **Plain `zod` for domain schemas, `safeParse` only.** External data (MCP inputs, sync payloads, settings files) is `unknown` until a schema accepts it. Schema = type = validation.
- **`Result<T>`, never throw.** Every fallible function returns `Result` (`packages/core/result.ts`). The one sanctioned `throw` is inside a transaction body, to roll it back; the function that opened the transaction returns it as an `err`. Tests may throw to unwrap a `Result` during setup (`if (!x.ok) throw x.error`): the throw fails the test with the error's message, which is what a broken precondition should do. Code a test asserts on still returns `Result`.
- **Namespaces over classes.** Related types and functions live in a namespace or a plain object of named functions. Classes exist only where a framework demands a subclass: the Worker's Durable Objects and the board's React error boundary. Each says why at its declaration and holds as little logic as the framework allows.
- **Explicit dependencies.** The core reads no environment variables. A host wires a `DbProvider`, tracer, notifier, actor, and settings source through `Runtime.configure`; every port but the provider has a no-op default.
- **Co-located tests.** A test sits beside the code it tests as `*.test.ts`. No `test/` directories.
- **Comments are rare.** Names and types carry intent. Write a comment only for a contract, a rule the code cannot make obvious, or a non-obvious why; never to narrate what the code does or how it got there.

## Working posture

YAGNI · DRY · boyscout rule · KISS · obvious correctness over cleverness · every abstraction layer must justify its existence · readable diffs · fail fast.

- **Errors are DX** — say what failed, with which input, and what to do next, in one line.
- **No code first** — when one option needs no code and another adds some, take the one without, try it for real, and write the code once a real failure asks for it. Pass every choice through this lens; a stated reason can still outweigh it. It weighs most on guardrails: checks, refusals, limits, ownership rules, protective flags. Each is code that can carry its own bug, and a guard written before its failure was seen has broken more here than it prevented. Features are judged on what they let someone do.

## Architectural invariants

- **Local SQLite is authoritative on every device.** Sync is off by default, and a device works with no network.
- **The hub is one more device.** The Worker runs the same core on Durable Object SQLite, arms capture under its own device id, and pushes and pulls through the log like any other device. The Worker also hosts that log; the cloud device reaches it through a stub instead of HTTP and gets no other privilege.
- **The oplog is append-only and sync converges by it.** Every write to a replicated table ends with an `Oplog` capture in the storage layer, never a trigger. The log assigns a total order, and `sync/resolve.ts` breaks ties the same way on every device, so any two devices that applied the same ops hold the same rows. Convergence is asserted against the in-process relay (`sync/local-relay.ts`), with no Cloudflare.
- **A private row never enters the oplog.** The filter is the row's `visibility` column, whichever table it lives in.
- **The same core runs in Bun and in Workers.** It talks to storage only through the `Db` port. The hub's typecheck includes no Bun types and rejects a Bun global reachable from core's production barrel.
- **Migrations are numbered and append-only.** Version = list index + 1, each applied once in its own transaction. Never edit or reorder a shipped migration; append one. This rule is held by review, not by a check.

## Invariants at construction

A property stated in a comment, a doc, or a call-site guard fails silently the day someone forgets it. A property the code makes true at construction does not.

- **The review question** — if a comment or doc states a property, ask why it is not enforced. If it cannot be, say so beside the claim, so the next reader does not mistake a missing guard for an oversight.
- **The corollary** — a claim about behaviour deserves a test that fails when the claim stops being true. Delete the enforcement and watch the test go red.
- **Sweep the class, not the instance** — before closing a fix, ask what else has this shape.
