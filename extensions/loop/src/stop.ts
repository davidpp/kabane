// The stop predicate: a run is done when every subtask is closed, no `p1` finding is open, the
// gates are green and every lens has reviewed the work. Pure over a plan the caller just read and
// what it knows of its checks; the runner runs the gates, then the lenses, once the work is done.
import { LoopPlan } from "./plan";

export namespace Stop {
	/** What the run knows of its checks: green with no gates, done with no lenses. */
	type Checks = { gatesGreen: boolean; lensesDone: boolean };

	type Verdict =
		| { done: true }
		| {
				done: false;
				openSubtasks: number;
				openP1: number;
				gatesGreen: boolean;
				lensesDone: boolean;
		  };

	const open = (plan: LoopPlan.Plan): { subtasks: number; p1: number } => {
		let subtasks = 0;
		let p1 = 0;
		for (const n of plan.nodes) {
			if (LoopPlan.isClosed(n.task)) continue;
			if (!n.finding) subtasks += 1;
			else if (n.p1) p1 += 1;
		}
		return { subtasks, p1 };
	};

	/** Whether the plan's work is done: every subtask closed and no open `p1` finding. */
	export const workDone = (plan: LoopPlan.Plan): boolean => {
		const left = open(plan);
		return left.subtasks === 0 && left.p1 === 0;
	};

	export const evaluate = (plan: LoopPlan.Plan, checks: Checks): Verdict => {
		const left = open(plan);
		return left.subtasks === 0 &&
			left.p1 === 0 &&
			checks.gatesGreen &&
			checks.lensesDone
			? { done: true }
			: {
					done: false,
					openSubtasks: left.subtasks,
					openP1: left.p1,
					...checks,
				};
	};
}
