# @kabane/jobs (extensions/jobs)

The jobs extension: recipes from a project's `.kabane/recipes/`, each naming a project skill or
carrying its own prompt, `kabane run` to start
one in an `hc` (herdr core) terminal, `kabane runs` to list, read, send to, attach to and stop
those runs, and `kabane job` to start one on a schedule. `docs/recipes.md` is what a user reads.

## On the board

A card has no tab and no events (JCAB-483): kabane does not render a harness's terminal. The card
carries the state and `kabane runs attach <id>`; hc shows the session.

## Verify

```bash
bun test extensions/jobs                 # parsing, inputs, the hc mapping, the board ports, the real kabane entry
bun run --cwd extensions/jobs build      # dist/ is installed as a directory extension
bun run sandbox config set extensions jobs --layer global
bun run sandbox config set jobs.harness 'sh,-c,printf "%s\n" "$0"; read line; echo "got: $line"; sleep 600' --layer global
# write a recipe into <repo>/.kabane/recipes/ and its skill into <repo>/.agents/skills/<skill>/SKILL.md;
# the sandbox prints <repo> on its first line
bun run sandbox add "Probe" --kind issue
bun run sandbox run <recipe> --target <id> --input name=value
hc label <terminal> kabane.sandbox=1        # at once: mark it yours
bun run sandbox runs
bun run sandbox runs read <id>
bun run sandbox runs send <id> some text
bun run sandbox runs stop <id>
bun run sandbox runs --ended                # ended
bun run sandbox runs --all                  # every project's
hc rm <terminal>                            # each terminal you started
```

Jobs, with the same shell harness and a recipe that says `target: job` or none:

```bash
bun run sandbox job add <recipe> --title Probe --schedule "* * * * *"
bun run sandbox job list
bun run sandbox job tick                   # after the minute turns: starts a run
hc label <terminal> kabane.sandbox=1        # at once
bun run sandbox job tick                   # skips it while it is live
```

The sandbox sets `KABANE_JOB_TICK=print`, so `job add`'s tick offer and `--fix
jobs/job-tick-missing` print the plist or crontab line they would install and install nothing:
`launchctl bootstrap` and `crontab` act on your real session whatever `HOME` says. Never unset it in
a check. `extension.test.ts` installs through stand-in `launchctl` and `crontab` on PATH.

The board in the sandbox, on your own tmux socket: start a run as above, then
`tmux -L <yours> new-session -d -s board -x 100 -y 30 'bun run sandbox board'`; `enter` on the
issue shows the card with its attach command, `a` on the issue starts a recipe. A recipe the
board starts gets a new terminal: label it at once.

The tests never start a terminal: hc has one core per user, and it holds the human's own
sessions. In a check by hand, label every terminal you start, remove each one when done, and
never kill, remove, send to or attach to one you did not start; never `hc server stop` or
`restart`. A real harness (`claude`) started this way uses the folder's own kabane MCP, which in
a real checkout is the real tracker: only the maintainer runs that.

## Mistakes that are easy to make here

- Calling `hc` from anywhere but `src/runtime-hc.ts`, or reading the run table anywhere but
  `src/runs.ts`.
- Writing a run state kabane decided. A state comes from `HcRuntime.stateOf`; there is no
  `succeeded`.
- Adding flags, MCP entries or a system prompt to the harness command. The harness reads the
  folder's own configuration.
- Sending a skill's instructions in the prompt, or filling values into them. The harness loads
  the skill the prompt names; the skill reads its target and inputs from the lines below that
  sentence. Placeholders are filled only in a recipe's own body.
- `--json` as an input flag: the CLI takes every `--json` as its output flag. The inputs
  object comes with `--inputs` or as the positional after the recipe name.
