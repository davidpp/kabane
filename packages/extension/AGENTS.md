# @cabane/extension

The extension contract: the types an extension and the host exchange, and the helpers every
command, built-in or extension, is written with. It has no runtime of its own.

- `contract.ts`: `Extension` (`name`, `settings`, `looks`, `commands`, `board`, `mcp`, `doctor`),
  and in the `Extension` namespace `Ctx` (what every command runs with), `Command` and `BoardPorts`.
- `doctor.ts`: check sources, findings and repairs; a failed check becomes a finding.
- `host.ts`: API 1: record, store, scope, zod, helpers, harness mode and kabane identity.
- `host-record.ts`: typed wrappers through `callTool`, shared by the CLI and real database tests.
- `host-store.ts`: the storage kit on `host.store`, built from core's exports so an extension's
  module tests run it over a real database. It owns commit, rollback on any `err` and the
  `TASK_UPDATED` notification after commit, and refuses capture on a table the extension's own
  modules do not declare.
- `args.ts`: `parseArgs` and the `flag*` readers.
- `outcome.ts`: `Outcome` and `success`, `conciseSuccess`, `failure`, `usage`.
- `settings.ts`: the `Settings` namespace, which resolves a settings namespace through the
  layers (`default`, `global`, `shared`, `local`, `caller`) behind one `Port`, and describes a
  zod schema's settings for `kabane config` and the settings screen.

## It depends on core alone

Its layer is `extension contract`; its entry in `scripts/layers.ts` (`"@cabane/extension"`)
says what it may list. `ports.ts` owns the activity, dispatch, header, panel, settings field
and copilot shortcut types an extension produces and any client reads. `ActivityQuestion` names
its owning card and optional lane; `ActivitySource.questions` and `answer` keep questions and
answers with their source, without a core session dependency. It imports no board.

Two consumers implement or call the contract: the CLI (`packages/cli/src/context.ts` builds
its `Ctx` as `Extension.Ctx` plus the device config, and every command in
`packages/cli/src/commands/` uses `args` and `outcome`) and the loop (`extensions/loop`).

## What lands here is extension API v1

`ARCHITECTURE.md`, "Extension API v1" and "An extension contributes through six optional
fields", specifies what the contract holds and will hold, including the `Host` type. A field
or member that section does not list comes with a change to it in the same diff (question 6 of
`.agents/skills/dispatch/references/lenses/architecture.md`).

The current contract and loader enforce these boundaries:

- `kabane/extension` publishes generated types only; factories receive values through `host`.
  `record` and `store` become live only after the CLI configures and migrates the runtime and
  one of the host's factories returns. Doctor activates them only when it opens the store.
- The CLI validates the manifest in `package.json` before importing the factory. The modules
  entry (`kabane.modules`, a factory `(host) => KabaneModule[]`) does not live on `Extension`;
  the CLI imports it before configuring the runtime and hands it the host the main entry gets.

Read before writing: `contract.ts`, `settings.ts`, `settings.test.ts`.

## Verify

```bash
bun test packages/extension
bun test packages/cli extensions/loop                       # both consumers of the contract
bun run sandbox init                                        # once per fresh sandbox
bun run sandbox config list                                 # Settings.entries over every namespace
bun run sandbox config set extensions loop --layer global
bun run sandbox loop --help                                 # an extension's command, through the contract
```

## Mistakes that are easy to make here

- Expecting a list setting to add up across layers. Objects merge key by key and anything else
  is replaced, so the highest layer that names `loop.lenses` decides the whole list
  (`settings.ts:8`).
- Building a settings schema with a zod other than the one this package uses. `Settings` walks
  the schema, so schemas must use `host.z`; the loader refuses a foreign copy.
- Giving a setting neither a default nor `.optional()`. Every layer is partial, so the comment
  on `Extension.settings` asks for one or the other on every key.
