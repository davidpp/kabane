# @kabane/registry

A data module: the vocabulary one exact scope publishes as data. It owns two tables,
`registry_declarations` (attribute keys and their choices) and `registry_thread_kinds` (thread
kinds: a name, a label, a description), both `row-lww` on a `publication` ULID, their two
migrations, the tools `kabane_registryPublish`, `kabane_registry`, `kabane_threadKinds` and
`kabane_attributeSet`, and the `Registry` functions the CLI's `kabane registry` and the board
call. `README.md` describes the declarations and the tools; read it before changing one. The
name is this package's; core's own "module registry" (`Runtime.modules()`) is another thing.

## Verify

```bash
bun test packages/registry
bun test packages/board/src/data-thread-kinds.test.ts   # the board's labels come from here
bun run --cwd packages/worker test                      # the hub registers this module too
bun run sandbox init
echo '{"name":"signal","label":"Monitor signal"}' > /tmp/signal.json
bun run sandbox registry publish /tmp/signal.json
bun run sandbox registry kinds                          # core's, the modules', then the scope's
bun run sandbox add "Error rate doubled" --kind signal
bun run gallery --print board-threads --width 40
```

## Mistakes that are easy to make here

- Updating a declaration. A declaration is immutable: publishing the same one again is a
  no-op, and a different one under the same key or name is refused. A changed vocabulary takes
  a new key or name.
- Letting a scope kind replace a code declaration. `publish` refuses a name core or a
  registered module declares, and `kinds` lists a synced one under `shadowed`, never in place
  of the code's.
- Failing a read on a row this build cannot parse. A peer on a later build can sync a document
  with a field this one does not know; `kinds` and `list` leave such a row out. A declaration
  decorates a record that reads without it (ADR 0010).
- Writing an attribute outside core. `set` stores the value through core's
  `setCustomAttribute` (key `custom.<key>`), never as raw SQL on `attributes`. It reads the
  thread's scope from the `tasks` view with raw SQL, which is the one read it makes past core's
  exports.
