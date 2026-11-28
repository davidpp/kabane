# @kabane/work

A data module with no table: it declares the thread kinds `task`, `issue` and `job` with their
policy (`initialState`, `unlisted`) through `KabaneModule.threadKinds` (ADR 0012), and one MCP
instructions paragraph naming them. `README.md` describes them; keep it aligned with
`module.ts`.

Both standard hosts register it: `MODULES` in `packages/cli/src/context.ts` and the hub's list in
`packages/worker/src/hub.ts`. Core's tests register it through `packages/core/testing.ts`. A host
that forgets it raises no error, so each host has a test through its real entry point that a
default listing leaves a job out and that a task lands in `inbox`.

## Verify

```bash
bun test ./packages/registry ./packages/core/storage/thread-kind-policy.test.ts
bun test packages/cli/cli.test.ts -t "shipped work kinds"
bun run --cwd packages/worker test
bun run sandbox init
bun run sandbox add "x" --kind job --state next
bun run sandbox list --state next          # No tasks found.
bun run sandbox registry kinds --json      # task, issue, job: module:work
```
