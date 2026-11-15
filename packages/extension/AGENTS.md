# @cabane/extension

The extension contract: the types an extension and the host exchange, and the helpers every
command, built-in or extension, is written with. It has no runtime of its own.

- `contract.ts`: `Extension` (`name`, `settings`, `looks`, `commands`, `board`), and in the
  `Extension` namespace `Ctx` (what every command runs with), `Command` and `BoardPorts`.
- `args.ts`: `parseArgs` and the `flag*` readers.
- `outcome.ts`: `Outcome` and `success`, `conciseSuccess`, `failure`, `usage`.
- `settings.ts`: the `Settings` namespace, which resolves a settings namespace through the
  layers (`default`, `global`, `shared`, `local`, `caller`) behind one `Port`, and describes a
  zod schema's settings for `kabane config` and the settings screen.

## It depends on core alone, and today it also imports the board

Its layer is `extension contract`; its entry in `scripts/layers.ts` (`"@cabane/extension"`)
says what it may list. That entry carries one exception, `@cabane/board`, because
`contract.ts` and `settings.ts` import the board's port types (`@cabane/board/ports`).
JCAB-320 moves those types here and removes the exception (`ARCHITECTURE.md`, "Ports", says
which). Never add a new import from the board in the meantime.

Two consumers implement or call the contract: the CLI (`packages/cli/src/context.ts` builds
its `Ctx` as `Extension.Ctx` plus the device config, and every command in
`packages/cli/src/commands/` uses `args` and `outcome`) and the loop (`extensions/loop`).

## What lands here is extension API v1

`ARCHITECTURE.md`, "Extension API v1" and "An extension contributes through six optional
fields", specifies what the contract holds and will hold, including the `Host` type. A field
or member that section does not list comes with a change to it in the same diff (question 6 of
`.agents/skills/dispatch/references/lenses/architecture.md`).

Work on this package is in flight on other branches. Rebase onto main before you start, and
expect these to land around you:

- JCAB-275: an `mcp` field on `Extension` (tools and instructions served by `kabane mcp`).
- JCAB-263 (JCAB-266 on its branch): a `doctor` field.
- JCAB-322: the `Host` type and the published import path `kabane/extension`.
- JCAB-321 and JCAB-323: the manifest and the modules entry, which live in `package.json`
  rather than on `Extension`.

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
  the schema, so a second copy of zod is untested against it.
- Giving a setting neither a default nor `.optional()`. Every layer is partial, so the comment
  on `Extension.settings` asks for one or the other on every key.
