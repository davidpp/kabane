# Recipes

A recipe is a procedure you run again and again: a file in your project that says what it works
on and what it asks for, with the procedure in a project skill or, for a small one, in the file
itself. `kabane run` starts your coding harness on it in a background terminal and returns at
once;
`kabane runs` shows what each run is doing and lets you read it, send to it, take it over or
stop it. `kabane job` runs a recipe on a schedule.

Recipes are the `recipes` extension. Without it, kabane has no `run`, `runs` or `job` command,
and the board shows no run and offers no recipe.

## Install

Build it from a kabane checkout and install it as [Extensions](extensions.md) shows for the
loop and dispatch:

```bash
bun run --cwd extensions/recipes build
mkdir -p "${KABANE_HOME:-$HOME/.kabane}/extensions/recipes"
cp -R extensions/recipes/dist/. "${KABANE_HOME:-$HOME/.kabane}/extensions/recipes/"
kabane config set extensions loop,dispatch,recipes --layer global   # the ones you use
```

Runs start in terminals of `hc` (herdr core), which must be on your `PATH`. Without it,
`kabane run` stops with one line naming it and `kabane doctor` reports
`recipes/hc-missing`.

## Write a recipe

A recipe file holds everything kabane needs to start a run. The procedure the run follows is in
one of two places: a project skill the file names, or the file's own body. Use a skill for a
procedure worth keeping, which you also run by hand or share between recipes; it is the
preferred form. Use a body for a small recipe, where a skill would be more than the prompt
needs.

### With a skill

The skill is an [Agent Skill](https://agentskills.io/specification) in your project:
`.agents/skills/<skill>/SKILL.md`, with `name` and `description` in its frontmatter and the
instructions below it. Codex reads skills from `.agents/skills/` and Claude Code from
`.claude/skills/`, so make `.claude/skills/<skill>` a symlink to `../../.agents/skills/<skill>`
and both harnesses find the one file. A skill only in `.claude/skills/` works too, for Claude
Code alone. Kabane does not send the skill's instructions: it names the skill to the harness,
and the harness loads it.

The recipe file is `.kabane/recipes/<name>.md` at your project's root: the folder that already
holds `.kabane/`, or the repository's root when there is none yet. The file name is the
recipe's name (lowercase letters, digits, `-` and `_`). For a skill, it is frontmatter only:
what the recipe works on, what it asks for, which harness it is written for and which skill it
runs.

Keep it there, even for a recipe about one package. A `.kabane/` folder marks a project's
root, so creating one in a subfolder makes that subfolder a separate project: every command
run inside it, `kabane run` included, files into its own scope, and a scope you pinned with
`kabane init --scope` stops applying there. When `kabane run` finds no recipes, it names the
root it looked in.

This repository's own `.kabane/recipes/preliminary-research.md` runs the skill in
`.agents/skills/preliminary-research/`:

```markdown
---
description: Research an issue before work starts and rewrite it into the brief an implementer can work from
target: issue
inputs:
  depth:
    options: [quick, medium, thorough]
    default: medium
    hint: quick reads the brief and the files it names; thorough also reads prior issues and the docs around them
---
```

| Field | Meaning |
|---|---|
| `description` | one line, shown when `kabane run` lists the recipes |
| `skill` | the project skill the run uses; without it, the skill with the recipe's own name, unless the file has a body, which is then the prompt. Several recipes can name one skill |
| `target` | `issue`: the run works on an issue given with `--target`; `job`: it runs for a scheduled job (see [Jobs](#jobs)); `none` (the default): it takes none |
| `inputs` | by name: `type` (`string`, the default, `number` or `boolean`), `required`, `default`, `options` (strings only), `label`, `hint` |
| `harness` | the command this recipe starts, as a list (`[codex, exec]`), or one word (`codex`); the prompt is added as its last argument. Without it, `recipes.harness` (see [Which harness a run starts](#which-harness-a-run-starts)) |

Kabane looks for the skill in `.agents/skills/<skill>/SKILL.md`, then in
`.claude/skills/<skill>/SKILL.md`, under the project's root. A skill in neither, or a field or
an input the frontmatter does not allow, is an error naming the file: kabane never skips a
broken recipe.

The skill does not get its values filled in. Write it to read them from what the run gives it
(below): "the target issue you were given", "the depth: quick, medium or thorough; medium if
none was given". Do not set Claude Code's `disable-model-invocation: true` on it: that stops
the model from loading the skill, and kabane relies on the model loading it from the sentence it
sends.

### With its own prompt

A recipe file with text below its frontmatter, and no `skill`, uses that text as its prompt, and
kabane looks for no skill. The frontmatter is the same as above, without `skill`. The body can
use `{{inputs.<name>}}` and, with `target: issue` or `target: job`, `{{target.id}}`,
`{{target.shortId}}` and `{{target.title}}`, which kabane fills in before it sends the prompt.
An optional input left out with no default reads as nothing. A placeholder the recipe cannot
fill is an error naming the file. A file with no frontmatter at all is a body with no target and
no inputs.

A recipe with both a `skill` and a body is an error that says to pick one.

## Run one

From your project's folder, or any folder inside it:

```bash
kabane run                                        # the recipes here, their skill or own prompt, harness and inputs
kabane run preliminary-research --target JCAB-12 --input depth=quick
kabane run preliminary-research --target JCAB-12 --inputs '{"depth": "thorough"}'
kabane run preliminary-research --target JCAB-12 --harness codex,exec
```

Inputs come from `--input name=value` (repeat it), a JSON object given with `--inputs` or
bare after the recipe name, and then their defaults. `--input` wins over the JSON object. At
a terminal, kabane asks for each required input still missing, numbering the options;
anywhere else a missing required input is an error that names it. Each value is checked
against its type and options. `--json` is the output flag every kabane command takes: it
prints the command's own output as JSON and supplies no inputs.

The harness gets one prompt: a short preamble, then a plain sentence that names the skill, the
target and one line for each input that has a value:

```text
[kabane run <run id>, recipe "preliminary-research"]
You were started in the background. Nobody is watching this terminal.
When a decision belongs to the human, file it with kabane_ask on <issue> (the choices, your recommendation and why), then stop.
Write your result as a comment on <issue> with kabane_comment.

Use the preliminary-research skill.
Target: <issue> ("<its title>")
depth: medium
```

The preamble says the run's id, that nobody is watching the terminal, that a decision for you
is filed with `kabane_ask` on the target issue before the agent stops, and that the result goes
on the issue as a comment. With `target: none` there is no issue to file on, so the preamble
asks the agent to write its question or its result as its last message, which `kabane runs
read` shows. A job's run gets its own preamble; see [Jobs](#jobs). The sentence uses no `/` or `$`, which differ between harnesses: Claude Code and
Codex each start the skill it names. A recipe with its own prompt gets the same preamble, then
its body with the placeholders filled in, in place of the sentence. `kabane run` records the
run, starts the harness in a new terminal in the current folder, logs a `run:<id>` reference
on the target issue, prints the run's id and terminal, and returns.

The harness reads its own configuration from that folder (its MCP servers, permissions and
instructions); kabane adds nothing to it.

### Which harness a run starts

The most specific of these, first found wins:

1. what you set when you start it: `kabane run --harness a,b,c`, or the harness row of the
   board's form;
2. a job's own `--harness`, for a job's runs;
3. the recipe's `harness`;
4. the `recipes.harness` setting;
5. `claude`.

`kabane run` with no recipe, `kabane job list` and `kabane job show` print the command each
recipe or job would start and where it comes from (`from the recipe`, `from recipes.harness`);
`kabane run` prints the one it started. `--harness` splits on commas, as `config set` does.

## Follow your runs

```bash
kabane runs                 # this project's runs that have not ended, newest first
kabane runs --ended         # ended ones too
kabane runs --all           # every project's, from any folder, with a PROJECT column
kabane runs read <id>       # print the terminal's screen
kabane runs send <id> yes   # type an answer into it and press enter
kabane runs attach <id>     # take the terminal over; ctrl+\ gives it back
kabane runs stop <id>       # end its program
```

`--all` and `--ended` go together: `kabane runs --all --ended` lists every run this device
knows. `<id>` is the run's whole id, or its last few characters; the terminal's name ends with
the id's last six. Kabane looks for it in the current project first, then in every project on
this device, so a command printed for one project works from any folder, or from none. When
the characters you gave end the ids of two runs, the error lists both with their project; give
more of the id. A run's state is what its program last reported
to its terminal, read each time runs are listed. Programs report through OSC 7501, herdr's
Program Status Protocol; kabane never guesses a state from the screen:

| State | The terminal |
|---|---|
| `live` | the program is open and has reported no status: a shell, or a harness that does not speak OSC 7501 |
| `running` | the agent is working |
| `waiting` | the agent is blocked on you: a permission or a question in the terminal. Answer it with `runs send <id> <text>`, or `runs attach <id>` to see it first |
| `idle` | the agent's turn ended and the program is still open |
| `ended` | the program exited, or the terminal is gone |

Any program can report its own state, a script set as `recipes.harness` included: it runs
`printf '\033]7501;state=working:app=my-agent\033\\'`, with `state` one of `working`, `blocked`,
`idle`, `done` or `error`. `blocked` shows `waiting`; `idle`, `done` and `error` show `idle`.

**A Claude Code run that stays `live`.** Claude Code reports OSC 7501 itself, but only when the
terminal answers its startup probe within 2 seconds. When its startup keeps it busy longer than
that (MCP servers connecting, a prompt given on the command line), it reports nothing for the
whole session; about one prompted run in three did so on a laptop with a few MCP servers. Such
a run reads `live` until it exits, so its job never fires again while it is there and
`recipes.onAttention` never hears about it. Upstream:
[anthropics/claude-code#105534](https://github.com/anthropics/claude-code/issues/105534) and
[#103022](https://github.com/anthropics/claude-code/issues/103022).

Until that is fixed, [`hooks/claude-program-status.sh`](hooks/claude-program-status.sh) reports
the state from Claude Code's own hook events: `working` when a prompt is sent and after each
tool, `blocked` on a permission prompt or a question (Claude Code sends its `permission_prompt`
notification for both), `idle` when its turn ends, and `error` when it ends on an API error.
Add it to your user settings, `~/.claude/settings.json`, so every session gets it, with the path
to your clone, merging these keys into the `hooks` you already have:

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "\"<your clone>/docs/hooks/claude-program-status.sh\" working" }] }],
    "PostToolUse": [{ "hooks": [{ "type": "command", "command": "\"<your clone>/docs/hooks/claude-program-status.sh\" working" }] }],
    "Notification": [{ "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "\"<your clone>/docs/hooks/claude-program-status.sh\" blocked permission" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "\"<your clone>/docs/hooks/claude-program-status.sh\" idle" }] }],
    "StopFailure": [{ "hooks": [{ "type": "command", "command": "\"<your clone>/docs/hooks/claude-program-status.sh\" error" }] }]
  }
}
```

A session whose own report works gets both, and kabane reads the same state from either.
Remove the hooks once Claude Code fixes the probe.

Kabane never says a run succeeded. `idle` means the agent stopped; what it did is what it
wrote on the issue. A run started on another machine shows the state last recorded there and
that machine's name, and `read`, `send`, `attach` and `stop` refuse it. A run in a runtime
this kabane does not have is treated the same way, and `read`, `send` and `attach` on a runtime
with no terminal fail with one line naming it. A run whose start was interrupted
stays `live` with no terminal (an empty TERMINAL column), and every verb on it fails with
"This run has no terminal: its start never recorded one".

`kabane runs` ends each row with the harness the run started, as a command line without the
prompt; a run recorded before kabane kept it shows `-`.

With `--json`, `kabane run` prints `run` (the id), `session`, `harness` (`{ argv, source }`) and
`attach` (the command that attaches to it), plus `warnings` when there are any. `kabane runs --json` prints `runs`, a list
of runs with these fields:

| Field | Meaning |
|---|---|
| `id` | the run's id |
| `recipe` | `{ name, hash }`: the recipe and a hash of its file, and of its skill's `SKILL.md` when it uses one, as the run started |
| `target` | `{ kind, id }`: what the run works on, absent when the recipe takes none: kind `issue` or `job`, and the item's full id |
| `scope`, `dir`, `cwd` | the scope's URI, the folder relative to its root (`""` at the root), and that folder's full path |
| `machine` | the host name of the machine the run started on |
| `runtime` | what started the run: `hc` |
| `session` | the runtime's own handle for it: for `hc`, the terminal's name |
| `inputs` | the input values the run started with |
| `harness` | the command the run started, as a list, without the prompt; absent on a run recorded before kabane kept it |
| `state` | `live`, `running`, `waiting`, `idle` or `ended` |
| `startedAt`, `endedAt` | ISO timestamps; `endedAt` once the run has ended |

## On the board

A run that works on an issue is a card on that issue, for the board's project. The board reads
each state from the terminal, as `kabane runs` does, and draws it this way:

| State | On the board |
|---|---|
| `running` | in flight, with a spinner: the issue's row shows the recipe's name and the state, and its header also shows the run's inputs, its machine and `kabane runs attach <id>` to copy |
| `live` | in flight with no status reported, since the program has said neither that it works nor that it waits: no spinner and no pause. The issue's row shows `◌ <recipe> · no status reported · live`, and its header also shows the run's inputs, its machine and `kabane runs attach <id>` to copy |
| `waiting` | paused, with no spinner: the issue's row shows `⏸ <recipe> · paused` and the state, and its header also shows the run's inputs, its machine and `kabane runs attach <id>` to copy. The agent waits on you: answer it with `kabane runs attach <id>` |
| `idle`, `ended` | finished: no badge on the row or line in the header. `kabane runs --ended` says which of the two it is |

Every run in flight (`live`, `running` or `waiting`) is listed, and the newest finished ones (`idle` or
`ended`) up to ten runs in all. A run with no target is not on the board: `kabane runs` lists
it. A job's run is on the board's Jobs tab, under its job (below).

A run's card has no tab: the board does not show the terminal. To see or answer the session,
run `kabane runs attach <id>`, which opens it in hc; `kabane runs read <id>` prints its screen
and `kabane runs stop <id>` stops it. `X` on the issue's detail stops it too (the footer says
`X stop <recipe>`). Nothing is answered from the board.

`a` on an issue offers every recipe of the project whose frontmatter says `target: issue`,
with its description. `enter` on one opens its form, which names the skill the run uses and its
file, or says the recipe has its own prompt and names the recipe's file, and lists every value the run will get before anything starts: the harness first, as the command line it will start, with where
it comes from under it (`from the recipe`, `from recipes.harness`), then each input with its
default and hint. Every row can be changed. `h/l` move a choice, a number or a boolean; any
other row is typed: type to add, `backspace` to delete, and `↑↓` leave it, since `j/k` are
letters it takes. The harness row is a shell command line: quote a word with a space in it
(`sh -c 'echo hi'`). `enter` starts the run with what the form shows, and the footer names the
new run and its harness; a required row left empty takes the cursor instead. A recipe file
that does not parse is listed with its error and does not start.

## Jobs

A job runs a recipe, or its own request, on a schedule, in its project's folder. It is an item of kind `job`: its
title names it, its description is the standing request the agent reads each time, and its
comments are what each run reported. Lists that name no kind leave jobs out; `kabane list
--kind job` shows them.

```bash
kabane job add wiki-maintenance --title "Keep the wiki current" --schedule "0 7 * * *" \
  --request "Fold this week's notes into the wiki pages they belong to"
kabane job add --title "Check the nightly build" --schedule "0 8 * * *" \
  --request "Check last night's build and comment what broke"   # no recipe
kabane job add --title "Tidy the inbox" --schedule "0 9 * * 1" \
  --request "Triage the inbox" --project ~/Projects/notes   # from any folder
kabane job edit JCAB-600 --schedule "0 9 * * *" --harness codex
kabane job edit JCAB-600 --check 'test -n "$(git status --porcelain)"'   # only when there is something to do
kabane job list                 # this project's jobs; --all for every project's
kabane job show JCAB-600        # the request, the inputs and the last runs
kabane job pause JCAB-600       # resume JCAB-600 starts it again
kabane job run JCAB-600         # fire it now
kabane job tick                 # fire every job that is due; what launchd or cron calls
```

`job add` makes the job in the project of the folder it runs in, or of the folder `--project`
names, from wherever you are (`~` and relative paths work as in a shell); a folder in no project
is an error. The recipe is read from that project's `.kabane/recipes/`, and the folder is
recorded as the one `tick` starts the job's runs in. The recipe must say `target: job` or take no target. Its inputs
come from `--input name=value` and `--inputs '{…}'` as with `kabane run`, are checked now, and
are never asked for: a required input that is missing is an error. `--schedule` is a cron
expression (`minute hour day month weekday`, or `@daily` and the other nicknames), read in this
machine's time zone. `--harness claude,--model,opus` gives this job its own command instead of
the recipe's `harness` and `recipes.harness`. `--session keep` makes the job keep one session between fires (below); the
default, `--session fresh`, starts a new one on each fire. `--check "<shell>"` makes each due
fire start the run only when that command exits 0 ([Fire only when there is something to
do](#fire-only-when-there-is-something-to-do)).

`job edit <id>` changes a job from any folder, only in the fields you give, and says what it
changed and when the job fires next: `--title` and `--request` (the item's title and
description, as `kabane edit` would change them), `--schedule`, `--harness`, `--session`, `--check`, and the
inputs, checked against the recipe as `job add` checks them: `--inputs '{…}'` replaces them,
each `--input name=value` sets one. `--harness none` drops the job's own command, so the
recipe's `harness` or `recipes.harness` applies again, and `--check none` drops the job's check. A new schedule counts from the job's last
fire, or from when it was added, as a tick does. A job's project does not change: to move one,
close it and add it again.

With no recipe name, `--request` is required and is the prompt: each fire gives the agent the
job preamble (below), then the request as the job's description reads at that moment, so an
edit to the description takes effect at the next fire. It is not a template: `{{…}}` in it
stays as written, and such a job takes no `--input`. Its runs are listed with `request` as their
recipe.

`job list` shows each job's id, whether it is active or paused, its schedule, the next time it
fires, its recipe (`-` for none), its session mode, the state of its latest run, its title, and
the harness its next run starts with where that comes from. `pause` sets the job
`someday` and `resume` sets it `next`. A job ends when you close it with `kabane done`; there is
no delete.

`job tick` fires every active job whose schedule has come round since it last fired, or since
it was added. A tick that comes late fires a job once, however many times it was missed. A fire,
like `job run`:

1. reads the job's runs on this machine from their terminals;
2. skips the job when one is `live`, `running` or `waiting`, and says so; the job stays due for
   the next tick;
3. on a fire `job tick` makes, runs the job's check when it has one, and when the check fails,
   starts nothing ([below](#fire-only-when-there-is-something-to-do)); `job run` skips this step;
4. on a `fresh` job, stops each `idle` one, because a harness stays at its prompt after its
   turn, then starts the recipe at the project's root, as `kabane run` would, with the job as
   its target;
5. on a `keep` job, types the run's prompt into the newest `idle` run's terminal, as `kabane
   runs send` would, and stops and starts nothing. The harness answers it in the same
   conversation, so it remembers the earlier fires and keeps its prompt cache. When no terminal
   is left (its run `ended`, or hc no longer has it), it starts one as a `fresh` job does.

A woken run stays one row in `kabane runs`, with the time it first started. `job show` reports
when the job last fired; `job list` shows its next fire and the state of its latest run. Kabane adds no harness
flag to resume a session: a kept session lasts as long as its terminal, so a reboot or `kabane
runs stop` ends it and the next fire starts a new one.

The run's preamble tells the agent it is a scheduled background run of the job, to read the job
with `kabane_context` for the request and what earlier runs reported, to write its result as one
comment on the job. It also says you are not watching but are notified when the run waits for
you: a decision for you is asked in the run's own session, with the choices and a recommendation,
and the agent waits there for your answer. `recipes.onAttention` tells you ([Hear when a run needs you](#hear-when-a-run-needs-you)), and you answer with
`kabane runs attach` or `kabane runs send`. Kabane does not store that question. A decision about
a specific issue that can wait goes on that issue with `kabane_ask` instead. `tick` prints one
line for each job it fired or skipped and exits 0 unless kabane itself failed.

`tick` runs with no project, so it needs each project's folder on this machine: every `kabane
job` command run inside a project records it, and so does `job add --project`. A job whose project has no folder recorded is
skipped with a line that says to run `kabane job list` inside it. Jobs sync with your other
items; the folders do not, so each machine that ticks needs one `kabane job` command in each
project.

### Fire only when there is something to do

A job with a check spends no session when it has nothing to do. The check is a shell command
that a due fire runs with `sh -c` in the job's folder, after the job's own run in flight has had
its say (a job skipped for a run still going does not run its check), with `KABANE_JOB` (the
job's id) and `KABANE_JOB_TITLE` in its environment.

- It exits 0: the fire goes on, and the run starts or the kept session wakes.
- Any other exit: nothing starts, and `tick` prints `<id>: check exited <code>, skipped`, followed
  by the last line the check wrote to stderr when it wrote one, so a `kabane job tick` you run by
  hand says why.

A failed check still counts as that slot's fire: the job next fires at its schedule's following
time, so a check that fails runs once per scheduled time, not on every tick. A skip is not
recorded anywhere else; `job show` reports it as the last fire. `kabane job run` fires the job
without running its check, because you asked for the run. Kabane puts no timeout on the check:
keep it quick, since `tick` waits for it before it fires the next job.

```bash
kabane job add --title "Triage the inbox" --schedule "0 9 * * 1-5" \
  --request "Triage inbox.md into the tracker" --check 'test -s inbox.md'   # only when it has lines
kabane job edit JCAB-600 --check none     # every due fire starts its run again
```

### Ask any harness to make a job

The recipes extension ships a `job` skill that teaches a harness the commands above, so you can
say "make a job in ~/Projects/notes that tidies the inbox every Monday at 9" or "pause that job"
from any harness, in any folder. It turns the prompt into one `kabane job add` or `kabane job
edit` (the folder checked with `kabane scope`, the schedule as cron, a recipe and its inputs when
one fits, a harness only when you named one), then reads the job back with `kabane job show` and
tells you when it fires next, in which folder, with which harness. It asks only for what the prompt
leaves open, such as the time of day.

The skill is installed for your user, not for one project: `kabane doctor` reports
`recipes/job-skill-missing` while `~/.agents/skills/job/SKILL.md` is absent, and

```bash
kabane doctor --fix recipes/job-skill-missing
```

writes it there, where Codex, Gemini and other harnesses read it, and links
`~/.claude/skills/job` to it for Claude Code. An existing `~/.claude/skills/job` that is not a link
is left as it is, and the fix says so. When a later kabane ships a different skill, `doctor` reports
`recipes/job-skill-behind`, and `--fix recipes/job-skill-behind` copies the new one over yours,
replacing any edits.

### Hear when a run needs you

`recipes.onAttention` is a shell command that `job tick` runs when a job's run needs you: once
when it starts waiting on you (a permission, a question, a trust dialog), and once when it
finishes (`idle` or `ended`). A run still waiting at the next tick does not run it again; one
that waits again after it went back to work does. Only the newest run of each job on this
machine counts, paused jobs included. Unset, the default, nothing runs.

The command runs with `sh -c` in the run's folder, with these environment variables:

| Variable | Holds |
|---|---|
| `KABANE_JOB` | the job's short id (`JCAB-600`) |
| `KABANE_JOB_TITLE` | the job's title |
| `KABANE_RUN` | the run's id |
| `KABANE_RUN_STATE` | `waiting`, `idle` or `ended` |
| `KABANE_ATTENTION` | `waiting`, or `finished` for `idle` and `ended` |
| `KABANE_FOLDER` | the folder the run started in |
| `KABANE_ATTACH` | the command that opens its session: `kabane runs attach <run id>` |

```bash
kabane config set recipes.onAttention \
  'terminal-notifier -title "$KABANE_JOB $KABANE_ATTENTION" -message "$KABANE_JOB_TITLE: $KABANE_ATTACH"' \
  --layer global
```

A hook that exits nonzero is reported on the tick's output with its last line of stderr, and
changes nothing else: it is not retried. The tick runs it with the `PATH` it was installed with
([Tick on a schedule](#tick-on-a-schedule)).

### Jobs on the board

With the recipes extension enabled, the board has a Jobs tab after the tracker (tab 2; `2`, `{`
and `}` reach it, or click it), from before the first job. Until there is one, the tab says what a
job is and that you make one by asking your agent, or by pressing `A` and asking the copilot. It
lists the jobs of every project on this device, not only the board's, one section per project
named after its folder. Each row shows the state of the
job's latest run, its id and title, then as much as fits of: `? waiting` when that run waits on
you, `paused`, when it fires next, its schedule, its recipe and its harness. A waiting run is
in the accent color, and the tab counts them (`jobs ?1`), so you see from any tab that a job
needs you.

| Key | On the Jobs tab |
|---|---|
| `enter` | the job's detail: its request and comments as an issue's, with its schedule, next fire, recipe, inputs, harness, session mode, folder and latest runs at the top of each section, scrolling with it |
| `a` | `run now`, which fires it as `kabane job run` does, in its own project's folder |
| `s`, `n` | pause it (`someday`) and resume it (`next`) |
| `esc` | back to the tracker |

Each run in the detail shows its state, when it started and `kabane runs attach <id>`, which
opens its session in hc; the board does not show the session. A board without the recipes
extension shows the tab only while this device has a job, and lists the jobs with only their id,
title, project and whether they are paused.

### Tick on a schedule

A job fires only when something runs `kabane job tick`. When nothing does on this machine,
`kabane job add` at a terminal asks whether to install it: on macOS a launchd agent,
`~/Library/LaunchAgents/com.kabane.job-tick.plist`, and on Linux a crontab line, each running the
tick every minute. Run elsewhere, as an agent runs it, `job add` prints the command that installs it
instead, and `kabane doctor` reports `recipes/job-tick-missing` while this machine has a job and
nothing ticks it:

```bash
kabane doctor --fix recipes/job-tick-missing
```

The tick runs the kabane that installed it, with that shell's `PATH`, so it finds `hc`, the
harnesses and the `recipes.onAttention` command as your shell does, and with its `KABANE_HOME`.
After you change your `PATH` or move kabane, remove the tick and install it again. To remove it on
macOS, `launchctl bootout gui/$(id -u)/com.kabane.job-tick` and delete the file; on Linux, delete
the line with `crontab -e`. Its output goes to `job-tick.log` and `job-tick.error.log` in
`KABANE_HOME`. A tick with nothing due does nothing, so ticking every minute is cheap.

## Settings

`recipes.harness` is the command a run starts when the recipe names none, as a list; the prompt
is added as its last argument. Unset, it is `claude`. A recipe's own `harness`, a job's
`--harness` and `kabane run --harness` come before it ([Which harness a run
starts](#which-harness-a-run-starts)). `recipes.onAttention` is the command a tick runs when a
job's run needs you ("Hear when a run needs you", above); unset by default.

```bash
kabane config set recipes.harness codex --layer global
kabane config set recipes.harness claude,--model,opus            # for this project only
```

`config set` splits a list on commas. For an argument that contains one, write the list in
`config.json` or in the project's `.kabane/recipes.json` by hand.
