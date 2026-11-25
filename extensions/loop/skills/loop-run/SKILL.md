---
name: loop-run
description: Set up, tune or start a kabane loop run, which drives an issue or a parent's subtasks to done through a coding harness in a detached runner. Use when the human asks to set up a loop for an issue ("set up a loop for JCAB-79"), to tune a run's settings or subtask tags, to run an issue ("run JCAB-79 with codex"), or to know what a run writes on an issue (claims, work log, summaries, findings).
---

# Loop run

Run kabane as `{{kabane}}`, in your shell, from your working directory, the project's checkout.

## Setting up a run

When the human asks to set up or tune a run ("set up a loop for JCAB-79"), run `{{kabane}} loop advise <id>` with any flags they named, and read the subtasks' briefs. It starts nothing: it prints the settings advised for the plan, each with its reason, and what each subtask's tier: and agent: tags run it on (harness, agent, model and where the model comes from).

Then propose, one reason each: which advised settings to keep or change; a tier:<name> tag, from the tiers it lists, where a subtask's brief makes its difficulty clear; an agent:<name> tag only for an agent the harness already has. Never change the implementer or the verifier unless asked. Your proposal is your own suggestion: wait for a yes.

Then add the tags with kabane_edit, keeping each subtask's other tags; pass the settings as `loop start` flags, or with kabane_configSet (see Settings that stick) when the human wants them to stick or a setting has no flag; and start the run as Starting a run says.

## Settings that stick

Change a setting only through kabane_configSet, never by editing config files. The loop's settings resolve through layers: default, global, shared (the project's checked-in .kabane/loop.json), local (the human's settings for this project on this device), then flags. Inside a project kabane_configSet writes the local layer by default; pass layer: global only when the human wants the change for every project. Never pass layer: shared: point the human to `{{kabane}} config set <key> <value> --layer shared` instead. Read the current value first with kabane_configGet, with layers:true to see the layer each value comes from. After the change, report the key, the layer, the before and after value, and that unset:true on that layer undoes it. When kabane_configSet returns shadowedBy, the write changed nothing yet: say which layer still decides and its value.

## Starting a run

The loop drives an issue to done through a coding harness, in a detached runner: run `{{kabane}} loop start <id>`. An issue with no subtasks runs as a single issue, and a parent runs its subtasks. Read `{{kabane}} loop --help` for the flags (`--implementer` picks claude, codex or gemini) and pass only what the human asked for: the loop's settings (kabane_configGet key loop) supply the rest.

When the human tells you to run an issue ("run JCAB-79 with codex"), that is the go-ahead: run the command once. When a run is your own suggestion, name the issue and the harness and wait for a yes.

If the command refuses (the loop extension is not enabled, the issue already has a run or nothing to do, this directory is not its scope), report its message as it is and do not retry with other flags.

When it starts, report the run id it prints, where the run works, and how to follow and stop it: the run's tab on the board, `{{kabane}} loop status <runId>`, and `{{kabane}} loop stop <runId>`. The run's sessions change the code, not you, and a question one of them asks is the human's to answer.

## On the record

What the loop exposes, and what a run writes in kabane's shapes (the base `kabane` skill's `references/record.md` says what a thread, an entry, an attribute and a ref are):

| To do this | MCP | CLI |
|---|---|---|
| Advise a run's settings and tags; changes nothing | `kabane_loop_advise` | `{{kabane}} loop advise <id>` |
| Start, follow, pause, resume or stop a run | none | `{{kabane}} loop start\|status\|pause\|resume\|stop` |
| Drive an existing run in the runner process launched by `loop start` | none | `{{kabane}} loop run <runId>` (internal runner entry point, performs the writes below) |
| Keep a run from claiming a subtask, or let it again | none | `{{kabane}} loop skip\|next <id>` |
| Answer a question a run's session asked | none | `{{kabane}} loop answer <questionId> <option>` |
| Land, roll back or prune a run's branch | none | `{{kabane}} loop land\|rollback\|prune` |

What a run writes:

- **Claims.** It claims a subtask with state `in_progress` and the harness as assignee, and stops if `claimHeld` is false. It never claims a thread that is `in_progress`, `waiting` or `someday`. A parent it runs moves to `in_progress`.
- **Work log.** On each claim, `loop:<runId>` labelled `claim started` with the session's `session:<id>`; after the gates, `loop:<runId>` labelled `gate results` with one `gate:<name>` per gate. A red gate puts a done subtask back to `next`.
- **Entries.** Each session's summary is an `outcome.summary` on the thread it claimed; a decision you answer for a session is an `outcome.decision`; the run's end is a comment on the parent.
- **Findings.** A verifier lens files each as a child issue of the parent: kind `issue`, state `next`, tags `finding`, its severity (`p1`, `p2`, `p3`) and the lens's name. `kabane_list` with the tag `finding` finds them.
- **Landing.** An unmerged branch sets `needsReview` on the issue. A `pr` landing records the pull request as the parent's GitHub upstream link and moves the parent to `waiting`; a `merge` landing moves it to `done`.

The run's sessions, events and questions stay in its own directory, `$KABANE_HOME/loops/<runId>/`, not on the record: read them with `{{kabane}} loop status <runId>`.
