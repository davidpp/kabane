/**
 * @cabane/loop
 *
 * The loop extension: drives a parent issue's subtasks to completion through ACP harnesses, one
 * core agent session per claimed subtask, or a single issue with no subtasks as its own one work
 * item, from a detached runner process whose state lives in
 * `$KABANE_HOME/loops/<runId>/`. Once the work is done, the project's gates and the verifier
 * lenses check it; a lens files findings as child issues. `Loop` holds the entry points the CLI
 * wires as `kabane loop start|run|status|stop|pause|resume|skip|next|rollback|answer`; the rest
 * is exported for the board's view of a run.
 *
 * The loop is a thin wrapper over the user's own harness. It adds no security or policy the user
 * did not configure: no allow list or settings file, no model unless the run names one. A session
 * that opens in the harness's manual mode is moved to the harness's own auto mode, unless the
 * device config turns that off; any other mode the user's settings chose is kept. When the
 * harness asks permission, the request
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
