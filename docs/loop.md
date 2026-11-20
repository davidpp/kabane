# Loop

The loop drives an issue, or a parent issue's subtasks, through coding harnesses on your
machine. It follows blockers, runs your configured gates after completed work, and can
run verifier lenses before finishing. With worktrees enabled, it keeps the run's work on
its own branch and checkpoints it as work passes the gates.

## Install

The loop is an extension, built from a kabane checkout and installed under
`$KABANE_HOME/extensions/loop`. [Extensions](extensions.md) says how to build, install and enable it;
`kabane loop --help` then prints its commands. The build includes its harness client, its
`loop-run` skill and the verifier lenses it ships. The harness you choose must be installed
and logged in.

When upgrading from a version that bundled the loop, install this directory before using
`kabane loop`. Until it is installed, an enabled `loop` reports `not installed; put it in
<home>/extensions/loop/`. Existing settings and run state under `$KABANE_HOME/loops` remain
in place. Loop settings written before installation are kept and read again once the loop
is installed and enabled. Until then, `kabane config get loop.<key>` answers
`Unknown config key`.

## Start and follow a run

Run these from your project directory. Replace `<id>` with an issue's short id, and
`<runId>` with the run id printed by `start`:

```bash
kabane loop start <id>
kabane loop status
kabane loop status <runId>
kabane loop stop <runId>
```

`start` launches a detached runner. In a git project, its default worktree needs at least
one commit. Use `--no-worktree` to work in the project checkout without checkpoints.
`status` lists runs; with a run id it shows the
worktree, each subtask's claims and any questions waiting on you. `stop` asks the runner
to cancel its sessions and release their work.

Answer a question from the run's board tab, or use its id from `status`:

```bash
kabane loop answer <questionId> <option>
```

For a permission request, `<option>` is an option id, label or position shown with the
question. The loop submits your answer to the runner, which records it and returns it to
the harness. It never chooses a permission answer for you. A question whose runner has
died cannot be answered; `status` gives the command to restart that run.

Each run keeps its session claims in `run.json`, its stream in `events.jsonl`, and its
questions and their answers or withdrawals in `questions.jsonl`, under
`$KABANE_HOME/loops/<runId>/`. Session summaries and your answers to questions other than
permission requests also appear on the issue's timeline; its work log links each session
with a `session:` URI. Runs created before the question journal existed still load, but
questions stored in the old tracker session tables are not offered by the loop.

On the board, a run's tab opens on its run row and its map. The run row names the issue and
says what the run is doing in words: `● recheck · 2 of 5 done · 2 live · 40m28s · $17.50` while
it runs, `? docs-recheck waits on you` when a session asks you something, and
`✓ completed · 6 findings left for you · 46m52s` once it is over. Continuations show there once
the run has used one.

The map under it has one row per step, in the order the run takes them: implement (its
subtasks), the gates, triage, the lenses' review, the fixer, the rechecks of its diff and the
landing, each with its result and how long it took. A step that is not configured is left out,
and a step still to come is listed with `○`. The step under way opens to one row per session; a
lens triage skipped is listed as done with its reason. A cursor follows the newest live session,
or the one that asks you something, until you move it with `j/k`; `f` makes it follow again.
`h/l` fold and open a step, and `enter` on a session shows its own events under the map in
place of every session's; `esc` goes back. A question waits under the map, naming the session
that asked, and its digits answer it.

Once the run is over, the map lists what it left for you: each finding still open, reopened by a
lens's recheck or filed by one, and the branch when it did not land. `enter` on a finding opens
it. The run's tab keeps an orange `?` until you have looked at that list.

When the run row says `waiting on`, each subtask it names says why, for example
`JCAB-64 (someday)`.
The run never claims a subtask you parked (`someday`, `waiting`) or took (`in_progress`),
and it does not finish while one is open: set it back to `next` for the run to take it, or
close it. `kabane loop skip` only keeps the run from claiming a subtask; a skipped subtask
that stays open still holds the run.

By default, `loop.land` is `none`: the finished branch stays in its worktree, and the
completed run flags the issue it ran on `Needs review`, because its work is not merged yet.
The issue keeps its state: a single issue its session closed stays done, and a parent
stays in progress. A `merge` landing clears the flag. The other
settings land it on completion, after rebasing it onto the latest of its base and running
the gates again when the rebase moved it:

- `pr` pushes the branch and opens its pull request with your own git and gh. The parent
  waits on that review. The run's branch is cut from your local base, so commits that base
  has and its remote lacks are pushed and are part of the pull request. `kabane loop advise`
  and the board's run form preview name them before a run starts, and `kabane loop start`
  names them as it starts one. They compare against your remote-tracking branch without fetching, so the count
  is only as fresh as your last fetch. The landing names them again in its summary, and the
  pull request's body lists them under "Not this run's work".
- `merge` merges the branch into the base in your project checkout, as
  `git merge --no-ff`, and moves the parent to done. It refuses, changing nothing, while
  the checkout is not on the base or has uncommitted changes to tracked files; a merge
  that conflicts is aborted. If git cannot abort it, the landing says the checkout is
  mid-merge and leaves it for you to finish or abort. If you commit on the base or switch
  branches while the merge runs, the landing reports it as not landed and undoes nothing.
  It does not push: pushing the base is left to you. The next `kabane loop start` or
  `kabane loop prune` removes the merged worktree and branch. A run that already had a pull
  request stops tracking it: the parent waiting on it moves to done, and the pull request
  stays open on GitHub for you to close.

To land a completed run by hand, or again once a landing that failed is fixed:

```bash
kabane loop land <runId> [--land pr|merge]
```

It lands as the run's `loop.land` says, as `--land` says over it, or as `pr` when the
setting is `none`. Run again after a `merge` landing, it only reports the branch as
merged, and still runs `loop.onLanded`. See `kabane loop --help` for
flags and the commands for pausing, resuming, answering questions and rolling back to a
checkpoint.

### Run a command after a landing

`loop.onLanded` is one shell command that runs after a branch lands, both at the end of a
run and after `kabane loop land`. It runs in your project checkout, only when the landing
succeeded, and never for a run that was stopped. By then the run is recorded as completed
and nothing holds its worktree, so a `kabane loop prune` in the command can remove this
run's worktree and branch. Unset, nothing runs. Like every loop setting, it is read when
the run starts: `kabane loop land` runs the command the run started with.

The command learns what landed from these environment variables:

| Variable | Value |
|---|---|
| `KABANE_RUN_ID` | The run id. |
| `KABANE_PARENT` | The issue's short id. |
| `KABANE_LAND` | How it landed: `pr` or `merge`. |
| `KABANE_BRANCH` | The run's branch. |
| `KABANE_BASE` | The base branch it landed on (its commit, for a run started from a detached HEAD). |
| `KABANE_WORKTREE` | The run's worktree. |
| `KABANE_PR` | The pull request's URL, after a `pr` landing. |
| `KABANE_MERGED` | The merge commit on the base, after a `merge` landing. Unset when the base took the branch without one, for example by a fast-forward you made. |

Some commands to start from:

```bash
# land: merge, then publish the base
kabane config set loop.onLanded 'git push'
# land: pr, then let GitHub merge it once its checks pass
kabane config set loop.onLanded 'gh pr merge "$KABANE_PR" --auto --merge'
# remove the merged worktree and branch right away
kabane config set loop.onLanded 'kabane loop prune'
```

Chain them with `&&`, for example `git push && kabane loop prune`. The command's exit
status and the end of its output go on the run's trace. A command that fails leaves a
warning there and changes nothing else: the run stays completed and the landing stays
done. A `pr` landing's pull request is usually still open when the command runs, so
`kabane loop prune` keeps that worktree until it is merged.

Session briefs name the resolved landing mode and whether an `onLanded` command is
configured, without exposing its shell contents. Sessions leave landing and the hook to
the runner. Steps owned by configured automation are reported as pending; publication or
checks without automation need an explicit follow-up. Neither is automatically human-only.
`kabane loop status <runId>` reports the landing result and PR URL; the board trace contains hook output and warnings. For GitHub, inspect later
checks with `gh pr checks <pr-url>` or `gh run list --branch <branch>`. The loop does not
monitor those later checks or close findings when they pass.

Every successful landing runs the command, so a retry with `kabane loop land` runs it
again, also when the branch was already merged. Write a command that is safe to run twice:
`git push` and `kabane loop prune` are.

## Settings and layers

Loop settings live under `loop.*`. Each key resolves from lowest to highest priority:

1. The built-in default.
2. Global settings in the `loop` object of `~/.kabane/config.json`, for every project.
3. Shared settings in the project's `.kabane/loop.json`, which you can check into git.
4. Your local project settings under `~/.kabane/projects/<project>/loop.json`.
5. The run's flags or the board's run form.

The project files hold the loop keys directly, without a surrounding `loop` object.
`KABANE_HOME`, when set, replaces `~/.kabane`. To see the effective values, where each
came from and which lower values it hides:

```bash
kabane config get loop --layers
```

Inside a project, `config set` writes the local layer by default; outside one it writes
global. Use `--layer shared` for settings the project shares, or `--layer global` for
your defaults across projects. A higher layer still wins.

## Launch a harness from your own build

A run launches each harness through its pinned ACP adapter. To run a local adapter build
or a wrapper script instead, name its command, and its arguments if it takes any, under
`loop.harnesses.<harness>`:

```bash
kabane config set loop.harnesses.claude.command /path/to/claude-agent-acp
# a list takes commas; after --, an argument may start with a dash
kabane config set loop.harnesses.claude.args -- --verbose,--debug
```

The dotted key splits its value on commas, so an argument that holds a comma itself goes
in through the whole object instead, which replaces every harness's entry in that layer:

```bash
kabane config set loop.harnesses '{"claude":{"command":"/path/to/claude-agent-acp","args":["--allow","a,b"]}}'
```

The arguments replace the adapter's; a command with no arguments runs with none. Every
session of the run on that harness uses it: implementers, the review triage, the lenses,
the fixer and the rechecks.

`command` and `args` resolve key by key through the layers, so a command in your local
layer can sit over arguments in the global one. Once they merge, `args` with no `command`
is refused: it would run the adapter's `npx` with your arguments and no adapter. So is a
command no session could start: a bare name must be on PATH, and a path must be an
executable file. A relative path is read against the project when the run starts, and the
run launches that absolute path, since each session works in a tree of its own without the
project's ignored files; a leading `~` is not expanded.

`kabane loop advise` prints what each harness the run would use launches, the pinned
adapter or your command, and each session's `launch` event in the run's trace names the
command it ran.

## Pick models with tiers

With the loop extension enabled, `kabane doctor` suggests pinning an unset `loop.model`
(`loop/model-unpinned`) and names each tier requested by `loop.model` or an open issue's
`tier:` tag that `loop.tiers` does not map (`loop/tier-unmapped`).

`loop.implementer` picks the default harness: `claude`, `codex` or `gemini`. It defaults
to `claude`. `loop.verifier` picks the harness for verifier lenses; unset, it follows the
implementer.

A tier names the capability the work needs. The built-in tiers are `frontier`, `balanced`
and `fast`, with **no models pinned**. Map them per harness with
`loop.tiers.<harness>.<tier>`:

```bash
kabane config set loop.tiers.claude.fast haiku
kabane config set loop.model fast
```

Here, a new Claude session asks for `haiku`. Use a model id your harness offers. A new
name in `loop.tiers` adds a tier of your own. Keep the capability on the issue and update
the mapping as model releases or your quotas change.

`loop.model` accepts a tier name or a literal model id. Unset, it leaves the choice to
the harness. A tier with no mapping for that harness also leaves it on its own default,
with a trace warning. A literal model the harness does not list is not applied; the
trace says what it kept.

## Route a subtask with tags

Put these on the subtask's tags:

| Tag | What it asks for |
|---|---|
| `tier:fast` | The `fast` mapping for the run's implementer. |
| `tier:claude/fast` | Claude and its `fast` mapping, even if the run has another implementer. |
| `agent:reviewer` | The selected harness's named `reviewer` agent, such as one defined in `.claude/agents/`. |

You can combine one tier tag with one agent tag. If there is more than one of either
kind, the first wins and the others get a trace warning.

The model is chosen in this order:

1. The named agent's own model pin, if it has one.
2. The subtask's tier tag, resolved for the selected harness.
3. The run's `model`, resolved as a tier or passed as a literal model id.
4. The harness's own default.

An unmapped subtask tier falls back to the run's model. An agent with no model pin
leaves the choice to the tier or run. A resumed session keeps the harness, agent and
model it ran with; editing tags does not reroute that session.

Codex cannot select named agents yet. A `tier:` or `agent:` tag it cannot honour does not stop the
run: it falls back for the choice it cannot honour and leaves a warning on the trace.
`kabane loop status <runId>` shows the harness, agent and model each subtask ran as,
with where the model choice came from. If the harness did not report a model, status
shows it as unknown.

## Read the advice before starting

On the board, `a` on an issue lists what can start on it; the loop's entry opens the run form
with advised values and their reasons.
Review the values before submitting. The advice is based on the plan's dependencies,
file overlap and past attempts, plus the project's scripts and lockfile. It can propose:

- `loop.budget.concurrency`: how many sessions run at once. With a worktree per subtask
  it follows the independent work in the plan, up to 8, and drops to 1 when subtasks that
  could run together name the same file. A shared tree, or a project outside git, is
  advised 1.
- `loop.gates`: available `check`, `typecheck` and `test` scripts when no gates are set.
- `loop.setup`: the dependency install command for each subtask's worktree.
- `loop.stallAfter`: fewer attempts before stalling when past work has thrashed.

Verifier lenses (`loop.lenses`) are also task-shaped choices in the form. The current
adviser leaves that list at your configured value; choose the lenses you want there. Which
of them review a given run, and in how many sessions, is decided once the work is done by
the run's triage (see "How much review a run gets").
Advice never changes `loop.implementer`, `loop.verifier`, `loop.model` or `loop.land`.
Those are your choices of harness, model and what happens to the finished branch.

A lens is a Markdown prompt in your dispatch skill,
`.agents/skills/dispatch/references/lenses/<name>.md`, the same file the skill's close
review reads; `functional` and `quality` ship with the loop, which reads its own copies when
the project has none.

Older lenses still run: lookup checks `.agents/skills/dispatch/references/lenses/`,
then a real `.claude/skills/dispatch/references/lenses/`, then `.kabane/loop/lenses/`.
`kabane doctor` reports legacy loop lenses (`loop/legacy-lens-dir`) and duplicate names
(`loop/lens-shadowed`), naming the copy in force. `kabane doctor --fix` moves legacy loop
lenses into the `.agents` dispatch skill once it exists and removes the old directory
when empty. A conflicting copy in either skill directory is left for a manual merge;
without a dispatch skill the finding is informational and points to `/setup-dispatch`, which
the [dispatch extension](../extensions/dispatch/README.md) adds. That extension's doctor offers
`/setup-dispatch` for moving a real `.claude` skill itself.

A lens file can open with frontmatter that says which changes it reviews:

```markdown
---
applies: persisted rows, sync ops, MCP tool inputs, config keys, file formats, CLI flags and output
always: false
---

# Compatibility lens
```

`applies` is one line of prose, written for a model deciding from a diff stat and the
brief. `always: true` tells triage never to skip the lens; the shipped `functional`
lens is one. The triage prompt carries this guidance; code does not enforce it. Both keys
are optional: a file without frontmatter is a lens with no `applies` that is not `always`.
Any other key, or frontmatter that is not YAML, is an error that names the file, and
`kabane loop start` refuses a run that would use that lens. The session gets the prompt
without its frontmatter. The dispatch skill's close review skips a lens whose `applies`
the diff does not touch. A loop run's triage reads both keys to decide which lenses run;
with `loop.review.mode all`, every lens in `loop.lenses` runs.

To read the same advice from the CLI, including how the subtask tags would route:

```bash
kabane loop advise <id>
```

This changes no issue, run or setting. It prints recommendations, reasons, current
values, and flags or settings you can use to apply them. **`kabane loop start` applies
no advice**: it uses your settings and the flags you give it. `setup` and `stallAfter`
have no start flags; set them through `kabane config set` if you want those suggestions.
The board form applies the advice you reviewed to that run, without saving it as your
defaults.

Any session connected to kabane's MCP server, the board's copilot included, can set up and
start a run by asking for it ("set up a loop for JCAB-79"): the loop ships how to do it as its
`loop-run` skill, which the session reads with `kabane_skillGet`. kabane serves skills only
from an extension loaded as a directory under `$KABANE_HOME/extensions/`. Without the skill,
set a run up with `kabane loop advise` or the board's `a` form, and start it with
`kabane loop start`.

## How much review a run gets

With two lenses or more in `loop.lenses`, a run triages before they review. Once the
work is done and the gates are green, one short session reads what the run changed
(`git diff --stat` from the commit its worktree was made from, plus files new to git),
the parent's brief and each lens's `applies` and `always`. It changes nothing and answers
with a review plan: which lenses review together in one session, at which tier, and which
it skips, each with a reason. The plan goes on the run's trace, one line per session and
per skipped lens:

```text
functional+quality at tier balanced: one code path, the change is a new CLI flag
docs: README.md and docs/loop.md changed
skipped compat: no persisted data, interface or config change in the diff
```

The run then starts one session per group. A skipped lens files nothing and counts as
reviewed. Triage decides the grouping, weighing the diff's size against repeated reads
and how much one session can hold.

- The triage prompt carries `always: true` as guidance to never skip that lens; code
  does not enforce it.
- A lens the plan does not mention does not review and shows as skipped on the trace.
- A lens the run does not have is dropped, and so is a tier that no run knows.
- Triage never changes `loop.implementer`, `loop.verifier`, `loop.model` or `loop.land`.

Every lens reviews in a session of its own, with the reason on the trace, when triage
fails, is stopped, edits a file, or answers no plan. The same happens when the run has
no commit to diff against (a run without a worktree, or outside git), where no triage
session starts, and when a run resumed by a newer kabane was already reviewing. A failed
triage never stops the run. A run triages once: a restarted runner keeps the plan, and
runs a triage again only when the last one was cut short.

Triage runs on the verifier harness (`loop.verifier`, else `loop.implementer`) as its
default agent, at tier `loop.review.tier`, `fast` by default. Map that tier to the model
you want, or give triage a tier of its own so `tier:fast` subtasks keep theirs:

```bash
kabane config set loop.review.tier triage
kabane config set loop.tiers.claude.triage haiku
```

An unmapped tier runs on the run's model, with a trace warning. `kabane loop status
<runId>` lists the `triage` session with the model it ran on. `loop.review.mode all`
turns triage off: every lens reviews in a session of its own, as a run with one lens does.

## Advice over MCP

With `loop` in the device's `extensions` list, `kabane mcp` includes the loop's route-tag
vocabulary in its initialize instructions and exposes `kabane_loop_advise`. Restart the MCP
process after enabling or disabling the extension. The hub does not load extensions.

Call `kabane_loop_advise` with `id` (an issue id or short id). Settings resolve for the MCP
server’s project directory; use `kabane loop advise` for overrides. Its JSON result contains
resolved settings, recommendations with reasons, and each open subtask's harness, agent, model,
`modelSource`, tier and fallback notes.
It uses the same advice path as `kabane loop advise`; it starts no run and changes no issue or
setting. Advice is not applied automatically when starting a run.

`readOnlyHint` follows the tool’s `kind`; an extension may add `destructiveHint` and
`openWorldHint`, and kabane reads none of these hints.
