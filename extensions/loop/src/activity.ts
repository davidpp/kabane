// The loop's runs as board activity: each run is a card with a tab of its own, its events are the
// run's `events.jsonl`, and the core sessions it claimed are what its tab counts questions on. This
// is the minimal source the board's tabs read; the richer header, lanes and actions come later.
import type {
	ActivityCard,
	ActivitySource,
	ActivityStatus,
} from "@cabane/board/ports";
import { ok } from "@cabane/core";
import { RunStore } from "./store";

// A board polls every few seconds, and every run ever started on the device stays on disk.
const RECENT_RUNS = 10;

export namespace LoopActivity {
	// A stopped run was halted on purpose (a human, a budget, a stall) and reads as stopped, not
	// failed; why is its `error`.
	const STATUS: Readonly<Record<RunStore.Status, ActivityStatus>> = {
		pending: "pending",
		running: "running",
		completed: "completed",
		stopped: "stopped",
		failed: "failed",
	};

	const sessionsOf = (run: RunStore.Run): string[] => [
		...new Set(run.claims.map((claim) => claim.sessionId)),
	];

	const plural = (count: number, noun: string): string =>
		`${count} ${noun}${count === 1 ? "" : "s"}`;

	export const card = (run: RunStore.Run): ActivityCard => ({
		id: run.id,
		kind: "loops",
		label: "loop",
		status: STATUS[run.status],
		taskId: run.parentId,
		taskShortId: run.parentShortId,
		startedAt: run.startedAt ?? run.createdAt,
		...(run.endedAt ? { finishedAt: run.endedAt } : {}),
		detail: [plural(run.claims.length, "session")],
		// The runner's own words for why it ended: `stalled (no progress across 3 session ends)`.
		...(run.exit && run.status !== "completed"
			? {
					error: `${run.exit.reason}${run.exit.detail ? ` (${run.exit.detail})` : ""}`,
				}
			: {}),
		hasEvents: true,
		tab: true,
		sessionIds: sessionsOf(run),
	});

	/** The device's newest runs, read from `$KABANE_HOME/loops` on every call. */
	export const source = (home: string): ActivitySource => ({
		load: async () => {
			const runs = RunStore.list(home);
			return runs.ok ? ok(runs.value.slice(0, RECENT_RUNS).map(card)) : runs;
		},
		card: async (id) => {
			const run = RunStore.read(home, id);
			return run.ok ? ok(card(run.value)) : run;
		},
		events: async (id, afterSeq) => {
			const events = RunStore.readEvents(home, id, afterSeq);
			return events.ok
				? ok(
						events.value.map(({ seq, at, type, summary }) => ({
							seq,
							at,
							type,
							summary,
						})),
					)
				: events;
		},
	});
}
