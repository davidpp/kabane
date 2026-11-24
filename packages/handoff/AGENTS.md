# @kabane/handoff

A data module with no table: it declares the timeline entry kind `handoff`, its template, the
`kabane_handoff` tool and one MCP instructions paragraph. A handoff is an entry in core's
`entries`, and core renders the brief's `handoff.latest` section from the kind's
declaration in `module.ts`. `README.md` describes the template, the tool, the brief section and
the CLI; read it before changing any of them.

## Verify

```bash
bun test packages/handoff
bun run --cwd packages/worker test      # the hub serves kabane_handoff too
bun run sandbox init                    # once per fresh sandbox
bun run sandbox add "hand me off" --kind issue
bun run sandbox handoff --template
printf '### Summary\n\nx\n' | bun run sandbox handoff <id> --from -
bun run sandbox context <id>            # the brief shows it as handoff.latest
bun run gallery --print detail-handoff --width 40
```

## Mistakes that are easy to make here

- Editing the template in `template.ts` and leaving the README's copy of it behind. The tool's
  description and `kabane handoff --template` show the template itself; the README quotes it.
- Checking a body against the template's headings. `handOff` refuses a blank body and trims
  trailing whitespace, and checks nothing else: a handoff may drop a heading or add one.
