# @kabane/dispatch (extensions/dispatch)

The dispatch extension: the dispatch skill template, the setup-dispatch skill that fills a
project's dispatch skill from it, the grill skill that walks the human through open questions,
the `/setup-dispatch` shortcut that runs the setup skill on the board, `kabane dispatch stamp`, and the `kabane doctor` checks that say a
project's copy is behind. `README.md` is what a user reads.

Any change to `templates/dispatch/` other than `PLACEHOLDERS.md` changes `kabane dispatch
stamp`'s output and makes every filled skill behind: that is the point of the stamp.

The loop keeps its own copies of the two shipped lenses (`extensions/loop/lenses/`). Each
extension owns its copy, and the two may drift.

## Verify

```bash
bun test extensions/dispatch                 # the real kabane entry over a temp KABANE_HOME
bun run --cwd extensions/dispatch build      # dist/ is installed as a directory extension
bun run sandbox init                         # once per fresh sandbox; it links this directory
bun run sandbox config set extensions dispatch --layer global
bun run sandbox dispatch stamp
bun run sandbox doctor                       # in the sandbox repo: dispatch/dispatch-skill-missing
```

Filling a skill with the setup-dispatch skill needs a real harness, on the board through
`/setup-dispatch` or in a plain session connected to the sandbox's `kabane mcp`; the scripted
agent does not prove it, so list it as a manual check. A change to the setup skill's text
re-runs the prompts in `evals/setup-dispatch/evals.json` on a real session.

## Mistakes that are easy to make here

- Base kabane text that names this extension or its skills (the copilot's instructions, the
  board's shortcuts, help, the CLI's doctor). What the extension needs said goes here.
- A template edit made for one project. The templates are generic; a project's own conventions go
  into its filled skill.
