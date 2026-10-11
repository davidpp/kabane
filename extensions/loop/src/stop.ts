// The stop predicate: a run is done when every subtask is closed and no `p1` finding is open.
// Pure over a plan the caller just read. Gates join the predicate with the package that runs them.
import { LoopPlan } from "./plan";

export namespace Stop {
	type Verdict =
		| { done: true }
		| { done: false; openSubtasks: number; openP1: number };

	export const evaluate = (plan: LoopPlan.Plan): Verdict => {
		let openSubtasks = 0;
		let openP1 = 0;
		for (const n of plan.nodes) {
			if (LoopPlan.isClosed(n.task)) continue;
			if (!n.finding) openSubtasks += 1;
			else if (n.p1) openP1 += 1;
		}
		return openSubtasks === 0 && openP1 === 0
			? { done: true }
			: { done: false, openSubtasks, openP1 };
	};
}
