// What the human has said about claiming: pause it, never take this subtask, take that one first.
// Pure: the runner folds the inbox's directives into the state it keeps in run.json and asks it
// what to claim. Saying something to a session (`inject`) is the session's business, not this.
import { z } from "zod";
import type { LoopPlan } from "./plan";
import { Scheduler } from "./scheduler";

export namespace Steering {
	export const StateSchema = z.object({
		/** No new claims; sessions already running finish. */
		paused: z.boolean().default(false),
		/** Subtask ids the run never claims. They stay open, so what they block stays blocked. */
		skipped: z.array(z.string()).default([]),
		/** Subtask ids to claim ahead of the rest once ready, in the order asked. */
		next: z.array(z.string()).default([]),
	});
	type State = z.infer<typeof StateSchema>;

	export const INITIAL: State = { paused: false, skipped: [], next: [] };

	/** A subtask a directive names: its id, and the short id a human typed. */
	const Target = { taskId: z.string(), task: z.string() };

	/** The inbox entries that change what is claimed. */
	export const DirectiveSchemas = [
		z.object({ kind: z.literal("pause"), at: z.string() }),
		z.object({ kind: z.literal("resume"), at: z.string() }),
		z.object({ kind: z.literal("skip"), at: z.string(), ...Target }),
		z.object({ kind: z.literal("next"), at: z.string(), ...Target }),
	] as const;
	type Directive = z.infer<(typeof DirectiveSchemas)[number]>;

	const without = (ids: readonly string[], id: string): string[] =>
		ids.filter((other) => other !== id);

	/** Fold one directive in; the event that says what changed. */
	export const apply = (
		state: State,
		directive: Directive,
	): { state: State; type: string; summary: string } => {
		switch (directive.kind) {
			case "pause":
				return {
					state: { ...state, paused: true },
					type: "paused",
					summary: "paused: no new claims; running sessions finish",
				};
			case "resume":
				return {
					state: { ...state, paused: false },
					type: "resumed",
					summary: "resumed: claiming ready work",
				};
			case "skip":
				return {
					state: {
						...state,
						skipped: [
							...without(state.skipped, directive.taskId),
							directive.taskId,
						],
						next: without(state.next, directive.taskId),
					},
					type: "skipped",
					summary: `${directive.task} skipped: never claimed, and what it blocks stays blocked`,
				};
			case "next":
				// Asking for a skipped subtask first is asking for it again.
				return {
					state: {
						...state,
						skipped: without(state.skipped, directive.taskId),
						next: [...without(state.next, directive.taskId), directive.taskId],
					},
					type: "next",
					summary: `${directive.task} next: claimed first once it is ready`,
				};
		}
	};

	/**
	 * What to claim now from the ready frontier (which already leaves skipped subtasks out):
	 * nothing while paused, else the `next` ones first, then the scheduler's order.
	 */
	export const pick = (
		state: State,
		ready: readonly LoopPlan.Node[],
		slots: number,
	): LoopPlan.Node[] =>
		state.paused ? [] : Scheduler.pick(ready, slots, state.next);

	/** A claimed subtask has been taken first; it is no longer waiting to be. */
	export const claimed = (state: State, taskId: string): State =>
		state.next.includes(taskId)
			? { ...state, next: without(state.next, taskId) }
			: state;
}
