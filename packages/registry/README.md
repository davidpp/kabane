# @kabane/registry

The vocabulary an exact scope publishes as data, with no code: the attributes its threads can
carry and the thread kinds that can be filed there. It is a data module, registered with
`Runtime.configure({ modules: [registryModule] })`. The CLI and the hub register it; a host that
does not reads the same threads by their stored kinds and values.

## Declarations

An attribute declaration is a `key`, a `description` and 1–50 `choices`, each a `value`, a
`label` and an optional `description`. A thread kind is a `name`, a `label` and an optional
`description` (core's `ThreadKindSchema`). Each is stored for one exact scope URI, branch and
package qualifiers included, and is immutable: publishing it again is safe, a different one
under the same key or name is refused. A kind core or a registered module declares cannot be
published.

## MCP tools

- `kabane_registryPublish` publishes one declaration (`scopeUri`, `declaration`).
- `kabane_registry` lists a scope's attribute declarations.
- `kabane_threadKinds` lists the kinds a scope can file: core's, the registered modules', then
  the scope's own, each with `name`, `label` and `source` (`core`, `module:<name>`, `scope`). A
  synced scope kind whose name code declares is listed under `shadowed`.
- `kabane_attributeSet` sets one declared attribute on a thread to one of its choices, or
  clears it with `null`. The thread's scope supplies the vocabulary.

The CLI's `kabane registry list | kinds | publish <file.json> | set <id> <key> <value> | clear
<id> <key>` does the same. docs/getting-started.md walks through both.

## Sync and export

Both tables replicate as `row-lww` rows ordered by their `publication` ULID, so two offline
devices that publish competing declarations under one name converge on the same one. They
travel with `kabane export` and rebuild with `kabane import`. A stored document this build
cannot read, such as one a later build wrote, is left out of `kinds` and `list`, and the rest
still list.

## Exports

`registryModule` to register; `Registry.publish`, `Registry.list`, `Registry.kinds` and
`Registry.set` over a store path.
