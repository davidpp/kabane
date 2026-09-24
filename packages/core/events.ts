/**
 * Domain events.
 *
 * Emitted by the storage layer on task mutations and delivered
 * through the `Notifier` port, so a host can fan them out (SSE, a dashboard)
 * without the core knowing how. Names follow `{module}.{entity}.{action}`.
 */

import { Runtime } from "./runtime";

export const PLANNER_EVENTS = {
	TASK_CREATED: "planner.task.created",
	TASK_UPDATED: "planner.task.updated",
	TASK_DELETED: "planner.task.deleted",
	/** Task state changed (subset of updated) */
	TASK_STATE_CHANGED: "planner.task.state_changed",
} as const;

export type PlannerEventType =
	(typeof PLANNER_EVENTS)[keyof typeof PLANNER_EVENTS];

export namespace Events {
	/** Deliver an event to the configured notifier. Never throws. */
	export const emit = async (type: string, payload: unknown): Promise<void> => {
		try {
			await Runtime.notifier()(type, payload);
		} catch (e) {
			console.error(`[kabane] notifier failed for ${type}:`, e);
		}
	};
}
