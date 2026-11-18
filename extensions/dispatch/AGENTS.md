# @cabane/dispatch (extensions/dispatch)

The dispatch extension: the dispatch and grill skill templates, the copilot procedures that fill
a project's dispatch skill from them and grill the human through open questions, the
`/setup-dispatch` shortcut, `kabane dispatch stamp`, and the `kabane doctor` checks that say a
project's copy is behind. `README.md` is what a user reads.

| Where | What it holds |
|---|---|
| `src/extension.ts` | the `(host) => Extension` factory: the `dispatch` command (`stamp`) and the doctor checks |
| `src/templates.ts` | `Templates.hashDir` and `Templates.stamp`, read from this directory's `templates/` |
| `src/doctor.ts` | `dispatch-skill-missing`, `-location`, `-unstamped`, `-behind`, `-unlinked`, `dispatch-template-unavailable`, `grill-skill-behind`, `-unlinked` |
| `copilot/procedures/*.md`, `copilot/shortcuts/*.md` | the copilot's text, `{{extension}}` filled by the host |
| `templates/dispatch/**`, `templates/grill/SKILL.md` | what a procedure tells the copilot to copy into a project |

## It takes types from kabane and no value

Its layer is `extension`; its entry in `scripts/layers.ts` (`"@cabane/dispatch"`) allows no
runtime dependency. Scope detection, zod, outcomes and the result helpers arrive on `host`; the
factory binds the result helpers through `src/result.ts` before anything else runs. Core and the
contract are development dependencies for types and for the tests' own result helpers.

A procedure file computes nothing: the stamp a filled skill records is `kabane dispatch stamp`'s
output, which `setup-dispatch.md` tells the copilot to run. The stamp is sha256 over the
template's relative paths and bytes, `PLACEHOLDERS.md` excluded, so a skill base kabane stamped
before the template moved here still compares equal. Any change to `templates/dispatch/` other
than `PLACEHOLDERS.md` makes every filled skill behind: that is the point of the stamp.

The loop keeps its own copies of the two shipped lenses (`extensions/loop/lenses/`). Each
extension owns its copy, and the two may drift.

Read before writing: `src/extension.ts`, `src/doctor.ts`, and `src/extension.test.ts`.

## Verify

```bash
bun test extensions/dispatch                 # the real kabane entry over a temp KABANE_HOME
bun run --cwd extensions/dispatch build      # dist/ is installed as a directory extension
bun run sandbox init                         # once per fresh sandbox; it links this directory
bun run sandbox config set extensions dispatch --layer global
bun run sandbox dispatch stamp
bun run sandbox doctor                       # in the sandbox repo: dispatch/dispatch-skill-missing
```

Filling a skill with `/setup-dispatch` needs a real copilot harness; the scripted agent does
not prove it, so list it as a manual check.

## Mistakes that are easy to make here

- Base kabane text that names this extension or its skills (the copilot's instructions, the
  board's shortcuts, help, the CLI's doctor). What the extension needs said goes here.
- A template edit made for one project. The templates are generic; a project's own conventions go
  into its filled skill.
