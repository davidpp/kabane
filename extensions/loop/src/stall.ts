// Stall detection: no progress across N session ends. Pure: the runner takes a progress mark
// after each session ends and asks whether it has stopped moving. A mark is any string that
// changes when the run gets somewhere: which subtasks are closed, the repository's tree, and
// which gates passed last time.
import { z } from "zod";

export namespace Stall {
	export const StateSchema = z.object({
		/** The mark at the last session end (or at the start of the run). */
		mark: z.string(),
		/** Session ends in a row that left the mark unchanged. */
		unchanged: z.number().int().min(0),
	});
	type State = z.infer<typeof StateSchema>;

	export const start = (mark: string): State => ({ mark, unchanged: 0 });

	/** Fold one session end into the state. */
	export const observe = (state: State, mark: string): State =>
		mark === state.mark
			? { mark, unchanged: state.unchanged + 1 }
			: { mark, unchanged: 0 };

	export const stalled = (state: State, limit: number): boolean =>
		state.unchanged >= limit;

	/** The mark for closed subtask ids, a fingerprint of the working tree and the last gate results. */
	export const mark = (
		closedIds: readonly string[],
		tree: string,
		gates = "",
	): string => `${[...closedIds].sort().join(",")}|${tree}|${gates}`;
}
