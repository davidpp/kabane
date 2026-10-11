// The stop predicate: a run is done when every subtask is closed, no `p1` finding is open and the
// gates are green. Pure over a plan the caller just read and what it knows of the gates; the
// runner runs the gates once the work is done and they are not green yet.
import { LoopPlan } from "./plan";

export namespace Stop {
	/** What the run knows of its checks; green when it has no gates. */
	type Checks = { gatesGreen: boolean };

	type Verdict =
		| { done: true }
		| {
				done: false;
				openSubtasks: number;
				openP1: number;
				gatesGreen: boolean;
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
		return left.subtasks === 0 && left.p1 === 0 && checks.gatesGreen
			? { done: true }
			: {
					done: false,
					openSubtasks: left.subtasks,
					openP1: left.p1,
					gatesGreen: checks.gatesGreen,
				};
	};
}
