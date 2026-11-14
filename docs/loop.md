# Loop

The loop drives an issue, or a parent issue's subtasks, through coding harnesses on your
machine. It follows blockers, runs your configured gates after completed work, and can
run verifier lenses before finishing. With worktrees enabled, it keeps the run's work on
its own branch and checkpoints it as work passes the gates.

Enable it by adding `"loop"` to the `extensions` array in `~/.kabane/config.json`, keeping
any extensions already there. The harness you choose must be installed and logged in.

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

On the board, a run's tab says what the run is doing: working its subtasks, then, once they
are done, its closing gates, each lens's review, the fixer, the rechecks and the landing.
When it says `waiting on`, each subtask it names says why, for example `JCAB-64 (someday)`.
The run never claims a subtask you parked (`someday`, `waiting`) or took (`in_progress`),
and it does not finish while one is open: set it back to `next` for the run to take it, or
close it. `kabane loop skip` only keeps the run from claiming a subtask; a skipped subtask
that stays open still holds the run.

By default, `loop.land` is `none`: the finished branch stays in its worktree. The other
settings land it on completion, after rebasing it onto the latest of its base and running
the gates again when the rebase moved it:

- `pr` pushes the branch and opens its pull request with your own git and gh. The parent
  waits on that review.
- `merge` merges the branch into the base in your project checkout, as
  `git merge --no-ff`, and moves the parent to done. It refuses, changing nothing, while
  the checkout is not on the base or has uncommitted changes to tracked files; a merge
  that conflicts is aborted. It does not push: pushing the base is left to you. The next
  `kabane loop start` or `kabane loop prune` removes the merged worktree and branch.

To land a completed run by hand, or again once a landing that failed is fixed:

```bash
kabane loop land <runId> [--land pr|merge]
```

It lands as the run's `loop.land` says, as `--land` says over it, or as `pr` when the
setting is `none`. Run again after a `merge` landing, it only reports the branch as
merged. See `kabane loop --help` for
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
| `KABANE_PR` | The pull request's URL, when the run has one. |
| `KABANE_MERGED` | The merge commit on the base, after a `merge` landing. |

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

## Pick models with tiers

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

On the board, `a` on an issue opens the run form with advised values and their reasons.
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
adviser leaves that list at your configured value; choose the lenses you want there.
Advice never changes `loop.implementer`, `loop.verifier`, `loop.model` or `loop.land`.
Those are your choices of harness, model and what happens to the finished branch.

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

You can also ask the board copilot to "set up a loop for X". It reads the advice and the
subtasks' briefs, proposes settings and `tier:`/`agent:` tags with a reason for each, and
waits for your yes before it tags anything or starts the run. It never changes the
implementer or verifier unless you ask.
