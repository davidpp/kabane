/**
 * @cabane/loop
 *
 * The loop extension: drives a parent issue's subtasks to completion through ACP harnesses, one
 * core agent session per claimed subtask, from a detached runner process whose state lives in
 * `$KABANE_HOME/loops/<runId>/`. `Loop` holds the entry points the CLI wires as `kabane loop
 * start|run|status|stop`; the rest is exported for the board's view of a run.
 */

export { Budget } from "./src/budget";
export { Loop } from "./src/commands";
export { LoopConfig } from "./src/config";
export { loop } from "./src/extension";
export { LoopPlan } from "./src/plan";
export { RunStore } from "./src/store";
