# @cabane/extension

The extension contract: the types an extension and the host exchange, and the helpers every
command, built-in or extension, is written with. It has no runtime of its own.

- `contract.ts`: `Extension` (`name`, `settings`, `looks`, `commands`, `board`), and in the
  `Extension` namespace `Ctx` (what every command runs with), `Command` and `BoardPorts`.
- `args.ts`: `parseArgs` and the `flag*` readers.
- `outcome.ts`: `Outcome` and `success`, `conciseSuccess`, `failure`, `usage`.
- `settings.ts`: the `Settings` namespace, which resolves a settings namespace through the
  layers (`default`, `global`, `shared`, `local`, `caller`) behind one `Port`, and turns a zod
  schema into the fields a settings screen and `kabane config` show.

## It depends on core alone, and today it also imports the board

Its layer is `extension contract`; its entry in `scripts/layers.ts` (`"@cabane/extension"`)
says what it may list. That entry carries one exception: `@cabane/board`, because
`contract.ts` and `settings.ts` import the board's port types (`@cabane/board/ports`).
JCAB-320 moves the UI-neutral port types (activity, dispatch, panel and settings field types)
into this package and removes the exception; it will rewrite both files' imports. Never add a
new import from the board in the meantime.

Two consumers implement or call the contract: the CLI (`packages/cli/src/context.ts` builds
its `Ctx` as `Extension.Ctx` plus the device config, and every command in
`packages/cli/src/commands/` uses `args` and `outcome`) and the loop (`extensions/loop`).

## What lands here is extension API v1

`ARCHITECTURE.md`, "Extension API v1" and "An extension contributes through six optional
fields", says what the contract holds and what it will hold. Read it before adding a field,
and answer question 6 of the architecture lens
(`.agents/skills/dispatch/references/lenses/architecture.md`): a field exists because an
extension cannot do the thing correctly without it, and it carries data or functions, never a component a second client could not draw.

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
bun test packages/cli extensions/loop     # both consumers of the contract
bun run sandbox config list               # Settings.fields over every namespace, as the CLI shows it
bun run sandbox loop --help               # an extension's command, through the contract
```

`bun run sandbox loop` needs `extensions` to name the loop in the sandbox's config:
`bun run sandbox config set extensions loop --layer global`.

## Mistakes that are easy to make here

- Building a settings schema with a zod other than the one this package uses. `Settings.fields`
  walks the schema, so a second copy of zod is untested against it.
- Giving a setting neither a default nor `.optional()`. Every layer is partial, so the comment
  on `Extension.settings` asks for one or the other on every key.
- Adding a member one extension needs. The CLI's own commands get the device config through the
  CLI's `Ctx`; an extension gets only what `Extension.Ctx` declares.
