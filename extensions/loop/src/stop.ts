// The stop predicate: a run is done when every subtask is closed, every lens has reviewed the
// work, the fixer has taken what they found, and the gates are green on the result. Pure over a
// plan the caller just read and what it knows of its checks; the runner runs the gates, then the
// lenses, then the fixer, once the work is done. Findings left open do not keep a run going: the
// fixer had its pass at them, and what it left is for a human.
import { LoopPlan } from "./plan";

export namespace Stop {
	/**
	 * What the run knows of its checks: green with no gates, done with no lenses, and the fixer
	 * done once its session ended or when there was nothing for it to take.
	 */
	type Checks = {
		gatesGreen: boolean;
		lensesDone: boolean;
		fixerDone: boolean;
	};

	type Verdict =
		| { done: true }
		| ({ done: false; openSubtasks: number } & Checks);

	const openSubtasks = (plan: LoopPlan.Plan): number =>
		plan.nodes.filter((n) => LoopPlan.isWork(n) && !LoopPlan.isClosed(n.task))
			.length;

	/** Whether the plan's work is done: every subtask closed. */
	export const workDone = (plan: LoopPlan.Plan): boolean =>
		openSubtasks(plan) === 0;

	export const evaluate = (plan: LoopPlan.Plan, checks: Checks): Verdict => {
		const left = openSubtasks(plan);
		return left === 0 &&
			checks.gatesGreen &&
			checks.lensesDone &&
			checks.fixerDone
			? { done: true }
			: { done: false, openSubtasks: left, ...checks };
	};
}
