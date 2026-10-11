// Starting a loop from the board: `a` on an issue with subtasks offers "start loop", whose form
// holds the run's settings (LoopSettings) beside the plan it would start on (Briefing), and whose
// `enter` is `kabane loop start` from the board's directory, with the same checks.
import type {
	Dispatcher,
	TriggerDescriptor,
	TriggerInput,
} from "@cabane/board/ports";
import { err, Lint, ok, type Result } from "@cabane/core";
import { Briefing } from "./briefing";
import { Loop } from "./commands";
import { Lenses } from "./lenses";
import { LoopPlan } from "./plan";
import { LoopSettings } from "./settings";

export namespace LoopDispatcher {
	const START = "start";

	const DESCRIPTION =
		"drive the subtasks to done through coding harnesses, in a detached runner";

	// What a run needs to start that a trigger cannot ask for: where it was started from.
	type Deps = Pick<Loop.StartDeps, "home" | "basePath" | "kabaneBin" | "cwd">;

	const trigger = (
		inputs: Record<string, TriggerInput>,
		extra: Partial<TriggerDescriptor>,
	): TriggerDescriptor => ({
		id: START,
		label: "start loop",
		description: DESCRIPTION,
		source: "loop",
		inputs,
		satisfiable: true,
		...extra,
	});

	// Core lint's risks for the plan, most severe first; a lint that cannot run is itself worth
	// reading before starting.
	const lintOf = async (
		basePath: string,
		parentTaskId: string,
		cwd: string,
	): Promise<string[]> => {
		const linted = await Lint.run({ jakePath: basePath, parentTaskId, cwd });
		return linted.ok
			? linted.value.risks.map((r) => `${r.message} (${r.severity})`)
			: [`lint did not run: ${linted.error.message}`];
	};

	/**
	 * The loop's triggers on `taskId`: none unless it has subtasks for a run to work; "start loop",
	 * with its form and the plan, when `Loop.start` would take it from here; otherwise the same
	 * trigger, unsatisfiable, with `start`'s own reason as its hint.
	 */
	export const triggers = async (
		deps: Deps,
		taskId: string,
		now: Date = new Date(),
	): Promise<Result<TriggerDescriptor[]>> => {
		const plan = await LoopPlan.load(deps.basePath, taskId);
		if (!plan.ok) return plan;
		if (!plan.value.nodes.some(LoopPlan.isWork)) return ok([]);
		const prepared = await Loop.prepare(deps, { parent: taskId });
		if (!prepared.ok)
			return ok([
				trigger({}, { satisfiable: false, hint: prepared.error.message }),
			]);
		const { projectDir, config } = prepared.value;
		const risks = await lintOf(deps.basePath, taskId, projectDir);
		return ok([
			trigger(LoopSettings.inputs(config, Lenses.offered(projectDir)), {
				preview: Briefing.preview(
					prepared.value.plan,
					config.gates,
					risks,
					now,
				),
			}),
		]);
	};

	/** Start the run with the form's values, as `kabane loop start` would from the board's directory. */
	const start = async (
		deps: Deps,
		parent: string,
		values: Readonly<Record<string, unknown>>,
	): Promise<Result<string>> => {
		const config = LoopSettings.overrides(values);
		if (!config.ok) return config;
		const run = await Loop.start(deps, { parent, config: config.value });
		return run.ok
			? ok(`loop ${run.value.id} ${run.value.status}`)
			: err(run.error);
	};

	export const make = (deps: Deps): Dispatcher => ({
		triggers: (taskId) => triggers(deps, taskId),
		dispatch: (triggerId, target, inputs) =>
			triggerId === START
				? start(deps, target.id, inputs ?? {})
				: Promise.resolve(err(new Error(`Unknown loop trigger: ${triggerId}`))),
	});
}
