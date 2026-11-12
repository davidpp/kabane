// Starting a loop from the board: `a` on an issue, or on a parent of issue subtasks, offers "start loop", whose form
// holds the run's settings (LoopSettings) beside the plan it would start on (Briefing), and whose
// `enter` is `kabane loop start` from the board's directory, with the same checks.
import type {
	Dispatcher,
	TriggerDescriptor,
	TriggerInput,
} from "@cabane/board/ports";
import { err, ok, type Result } from "@cabane/core";
import type { LoopAdvice } from "./advice";
import { Briefing } from "./briefing";
import { Loop } from "./commands";
import { Lenses } from "./lenses";
import { LoopPlan } from "./plan";
import { LoopSettings } from "./settings";

export namespace LoopDispatcher {
	const START = "start";

	const description = (plan: LoopPlan.Plan): string =>
		LoopPlan.single(plan)
			? "drive this issue to done through a coding harness, in a detached runner"
			: "drive the subtasks to done through coding harnesses, in a detached runner";

	// What a run needs to start that a trigger cannot ask for: where it was started from.
	type Deps = Pick<
		Loop.StartDeps,
		"home" | "basePath" | "kabaneBin" | "cwd" | "settings"
	>;

	const trigger = (
		plan: LoopPlan.Plan,
		inputs: Record<string, TriggerInput>,
		extra: Partial<TriggerDescriptor>,
	): TriggerDescriptor => ({
		id: START,
		label: "start loop",
		description: description(plan),
		source: "loop",
		inputs,
		satisfiable: true,
		...extra,
	});

	/**
	 * The loop's triggers on `taskId`: none unless it has work for a run (subtasks, or itself as a
	 * single issue); "start loop", with its form and the plan, when `Loop.start` would take it from
	 * here; otherwise the same trigger, unsatisfiable, with `start`'s own reason as its hint.
	 */
	export const triggers = async (
		deps: Deps,
		taskId: string,
		now: Date = new Date(),
		onAdvice?: (advice: LoopAdvice.Recommendation[]) => void,
	): Promise<Result<TriggerDescriptor[]>> => {
		const plan = await LoopPlan.load(deps.basePath, taskId);
		if (!plan.ok) return plan;
		if (!plan.value.nodes.some(LoopPlan.isWork)) return ok([]);
		const prepared = await Loop.prepare(deps, { parent: taskId });
		if (!prepared.ok)
			return ok([
				trigger(
					plan.value,
					{},
					{
						satisfiable: false,
						hint: prepared.error.message,
					},
				),
			]);
		const { projectRoot, config } = prepared.value;
		const { advice, messages } = await Loop.adviceOf(deps, prepared.value);
		onAdvice?.(advice);
		const gates = advice.find((r) => r.path === "gates")?.value ?? config.gates;
		return ok([
			trigger(
				plan.value,
				LoopSettings.inputs(config, Lenses.offered(projectRoot), advice),
				{
					preview: Briefing.preview(
						prepared.value.plan,
						gates,
						messages,
						now,
						advice,
					),
				},
			),
		]);
	};

	/** Start the run with the form's values, as `kabane loop start` would from the board's directory. */
	const start = async (
		deps: Deps,
		parent: string,
		values: Readonly<Record<string, unknown>>,
		edited: readonly string[],
		advice: readonly LoopAdvice.Recommendation[],
	): Promise<Result<string>> => {
		// Setup and a width above one were advised for worktrees. A shared submission keeps only
		// configured setup; one sharing a tree also drops the width, and "sessions at once" the human
		// never moved is that advised default, not their choice.
		const sharedTree =
			values.isolation === "shared" || values.worktree === false;
		const width = advice.find(
			(r) => r.path === "budget.concurrency" && r.value > 1,
		);
		const dropWidth =
			sharedTree && width !== undefined && !edited.includes(width.path);
		const config = LoopSettings.overrides(
			dropWidth
				? Object.fromEntries(
						Object.entries(values).filter(([name]) => name !== width.path),
					)
				: values,
			advice.filter(
				(r) =>
					(r.path !== "setup" || values.isolation !== "shared") &&
					(r !== width || !sharedTree),
			),
		);
		if (!config.ok) return config;
		const run = await Loop.start(deps, { parent, config: config.value });
		return run.ok
			? ok(`loop ${run.value.id} ${run.value.status}`)
			: err(run.error);
	};

	export const make = (deps: Deps): Dispatcher => {
		// Keep the non-editable advice (gates and setup) that this form actually previewed.
		const advised = new Map<string, LoopAdvice.Recommendation[]>();
		return {
			triggers: (taskId) => {
				advised.delete(taskId);
				return triggers(deps, taskId, new Date(), (advice) =>
					advised.set(taskId, advice),
				);
			},
			dispatch: (triggerId, target, inputs, edited) =>
				triggerId === START
					? start(
							deps,
							target.id,
							inputs ?? {},
							edited ?? [],
							advised.get(target.id) ?? [],
						)
					: Promise.resolve(
							err(new Error(`Unknown loop trigger: ${triggerId}`)),
						),
		};
	};
}
