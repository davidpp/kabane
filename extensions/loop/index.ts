/**
 * @cabane/loop
 *
 * The loop extension: drives a parent issue's subtasks to completion through ACP harnesses, one
 * core agent session per claimed subtask, from a detached runner process whose state lives in
 * `$KABANE_HOME/loops/<runId>/`. `Loop` holds the entry points the CLI wires as `kabane loop
 * start|run|status|stop|pause|resume|skip|next|rollback|answer`; the rest is exported for the board's view of a run.
 *
 * The loop is a thin wrapper over the user's own harness. It adds no security or policy the user
 * did not configure and overrides none of their settings: no permission mode, no allow list or
 * settings file, no model unless the run names one. When the harness asks permission, the request
 * becomes a question on the asking session, answered by the human from the board or with
 * `kabane loop answer`. The loop never approves or declines one itself; a run that stops while
 * one waits cancels it unanswered.
 */

export { Budget } from "./src/budget";
export { Loop } from "./src/commands";
export { LoopConfig } from "./src/config";
export { loop } from "./src/extension";
export { LoopPlan } from "./src/plan";
export { RunStore } from "./src/store";
