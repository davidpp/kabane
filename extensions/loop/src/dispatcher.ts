// Starting a loop from the board: `a` on an issue, or on a parent of issue subtasks, offers "start loop", whose form
// holds the run's settings (LoopSettings) beside the plan it would start on (Briefing), and whose
// `enter` is `kabane loop start` from the board's directory, with the same checks.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	Dispatcher,
	TriggerDescriptor,
	TriggerInput,
} from "@cabane/board/ports";
import { err, Lint, ok, type Result, type Risk } from "@cabane/core";
import { z } from "zod";
import { LoopAdvice } from "./advice";
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

	// Core lint's risks for the plan, most severe first; a lint that cannot run is itself worth
	// reading before starting.
	const lintOf = async (
		basePath: string,
		parentTaskId: string,
		cwd: string,
	): Promise<{ risks: Risk[]; messages: string[] }> => {
		const linted = await Lint.run({ basePath, parentTaskId, cwd });
		return linted.ok
			? {
					risks: linted.value.risks,
					messages: linted.value.risks.map(
						(r) => `${r.message} (${r.severity})`,
					),
				}
			: { risks: [], messages: [`lint did not run: ${linted.error.message}`] };
	};

	const projectScripts = (root: string): Record<string, string> => {
		try {
			const parsed = z
				.object({ scripts: z.record(z.string()).default({}) })
				.safeParse(
					JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
				);
			return parsed.success ? parsed.data.scripts : {};
		} catch {
			return {};
		}
	};

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
		const { projectDir, projectRoot, config } = prepared.value;
		const lint = await lintOf(deps.basePath, taskId, projectDir);
		const advice = LoopAdvice.of(plan.value, lint.risks, {
			config,
			scripts: projectScripts(projectRoot),
			lockfiles: LoopAdvice.LOCKFILES.filter((name) =>
				existsSync(join(projectRoot, name)),
			),
		});
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
						lint.messages,
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
		advice: readonly LoopAdvice.Recommendation[],
	): Promise<Result<string>> => {
		const config = LoopSettings.overrides(values, advice);
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
			dispatch: (triggerId, target, inputs) =>
				triggerId === START
					? start(deps, target.id, inputs ?? {}, advised.get(target.id) ?? [])
					: Promise.resolve(
							err(new Error(`Unknown loop trigger: ${triggerId}`)),
						),
		};
	};
}
