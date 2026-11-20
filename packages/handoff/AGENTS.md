# @kabane/handoff

A data module with no table: it declares the timeline entry kind `handoff`, its template, the
`kabane_handoff` tool and one MCP instructions paragraph. A handoff is an entry in core's
`task_comments`, and core renders the brief's `handoff.latest` section from the kind's
declaration in `module.ts`. `README.md` describes the template, the tool, the brief section and
the CLI; read it before changing any of them.

## It depends on core alone and both hosts register it

Its layer is `data module`; its entry in `scripts/layers.ts` (`"@kabane/handoff"`) says what it
may list. The CLI (`MODULES` in `packages/cli/src/context.ts`) and the hub
(`packages/worker/src/hub.ts`) register `handoffModule`. The CLI's `kabane handoff` calls
`handOff`, `findIssue` and `handoffReceipt` (`tools.ts`) and the template (`template.ts`).

How kinds work (the name pattern, `latest` and `discussion` projections, append-only entries,
what `Runtime.configure` refuses) is in `packages/core/AGENTS.md`, "Timeline entries". A change
to how the brief folds a handoff is made in core's fold.

Read before writing: `module.ts`, `template.ts`, `tools.ts`, `tools.test.ts`.

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
  trailing whitespace (`tools.ts:78`), and checks nothing else: a handoff may drop a heading
  or add one.
- Treating a handoff as closing the issue. `kabane_handoff` changes neither state nor the review
  flag.
