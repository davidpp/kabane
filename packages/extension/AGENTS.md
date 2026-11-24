# @kabane/extension

The extension contract: the types an extension and the host exchange, and the helpers every
command, built-in or extension, is written with. It has no runtime of its own.

## What lands here is extension API v1

`ARCHITECTURE.md`, "Extension API v1" and "An extension contributes through six optional
fields", specifies what the contract holds and will hold, including the `Host` type. A field
or member that section does not list comes with a change to it in the same diff (question 6 of
`.agents/skills/dispatch/references/lenses/architecture.md`).

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
  (the header of `settings.ts`).
