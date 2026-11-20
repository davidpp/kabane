---
name: loop-run
description: Set up, tune or start a kabane loop run, which drives an issue or a parent's subtasks to done through a coding harness in a detached runner. Use when the human asks to set up a loop for an issue ("set up a loop for JCAB-79"), to tune a run's settings or subtask tags, or to run an issue ("run JCAB-79 with codex").
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
