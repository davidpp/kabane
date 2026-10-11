// The loop's runs as board activity: each run is a card with a tab of its own, its events are the
// run's `events.jsonl`, and the core sessions it claimed are what its tab counts questions on. Each
// claim is a lane, so the tab can follow one session or tag every line with whose it is.
import {
	type ActivityCard,
	type ActivitySource,
	type ActivityStatus,
	type CardAction,
	STOP_ACTION,
} from "@cabane/board/ports";
import { err, ok, type Result } from "@cabane/core";
import { Loop } from "./commands";
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

	// What the human can do to a live run from its tab: stop it, message one session (the inbox's
	// `inject`), and steer what it claims. `p` pauses a running run and resumes a paused one. None of
	// these keys is one the board keeps for itself on a card's tab (card-tab.ts).
	const actions = (run: RunStore.Run): readonly CardAction[] => [
		{ id: STOP_ACTION, key: "x", label: "stop" },
		{
			id: "inject",
			key: "i",
			label: "message",
			input: "a message for this agent · enter sends it",
			lane: true,
		},
		run.steering.paused
			? { id: "resume", key: "p", label: "resume" }
			: { id: "pause", key: "p", label: "pause" },
		{
			id: "skip",
			key: "s",
			label: "skip",
			input: "a subtask's short id · it is never claimed",
		},
		{
			id: "next",
			key: "n",
			label: "next",
			input: "a subtask's short id · claimed first once ready",
		},
	];

	// The lanes a message can still reach: the claims whose session has not ended, the most recently
	// started first, which is where the board aims a message sent from the all-agents view.
	const liveLanes = (run: RunStore.Run): string[] =>
		run.claims
			.filter((claim) => claim.endedAt === undefined)
			.map((claim) => claim.lane)
			.toReversed();

	/** The kind a run's card has: what the board's strip counts and the header is keyed by. */
	export const KIND = "loops";

	export const card = (run: RunStore.Run): ActivityCard => ({
		id: run.id,
		kind: KIND,
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
		// One lane per claim, in claim order: claims only append, so a session keeps its color.
		lanes: run.claims.map((claim) => claim.lane),
		laneNoun: "agents",
		...(RunStore.isLive(run.status)
			? { actions: actions(run), liveLanes: liveLanes(run) }
			: {}),
	});

	/**
	 * Run an action through the run's inbox, which the runner reads every tick. `stop` is the
	 * command's own (`kabane loop stop`), without waiting for the run to wind down; `pause`,
	 * `resume`, `skip` and `next` are the commands' own too; `inject` is appended for the session
	 * behind the lane, and refused for a session that has ended.
	 */
	export const act = async (
		deps: { home: string; basePath: string },
		runId: string,
		actionId: string,
		input: { text?: string; lane?: string },
	): Promise<Result<string>> => {
		const { home } = deps;
		const run = RunStore.read(home, runId);
		if (!run.ok) return run;
		if (!RunStore.isLive(run.value.status))
			return err(new Error(`${runId} is ${run.value.status}`));
		switch (actionId) {
			case STOP_ACTION: {
				const stopped = await Loop.stop({ home, waitMs: 0 }, runId);
				return stopped.ok ? ok(`stop requested for ${runId}`) : stopped;
			}
			case "pause":
			case "resume": {
				const asked = Loop.pause(deps, runId, actionId);
				return asked.ok ? ok(`${actionId} requested for ${runId}`) : asked;
			}
			case "skip":
			case "next": {
				const task = input.text?.trim() ?? "";
				if (task === "") return err(new Error(`${actionId} needs a subtask`));
				const asked = await Loop.direct(deps, actionId, task, runId);
				return asked.ok
					? ok(`${actionId} ${asked.value.task} requested`)
					: asked;
			}
			case "inject":
				return inject(home, run.value, input);
			default:
				return err(new Error(`Unknown loop action: ${actionId}`));
		}
	};

	const inject = (
		home: string,
		run: RunStore.Run,
		input: { text?: string; lane?: string },
	): Result<string> => {
		const runId = run.id;
		const claim = run.claims.find((c) => c.lane === input.lane);
		if (!claim) return err(new Error(`No session on lane ${input.lane ?? ""}`));
		if (claim.endedAt) return err(new Error(`${claim.lane} has ended`));
		const text = input.text?.trim() ?? "";
		if (text === "") return err(new Error("Nothing to send"));
		const appended = RunStore.appendInbox(home, runId, {
			kind: "inject",
			at: new Date().toISOString(),
			session: claim.sessionId,
			lane: claim.lane,
			text,
		});
		return appended.ok ? ok(`message queued for ${claim.lane}`) : appended;
	};

	/**
	 * Every live run, and the newest of the others up to RECENT_RUNS in all, newest first: a
	 * run still going never drops off the board for being old.
	 */
	const listed = (runs: readonly RunStore.Run[]): RunStore.Run[] => {
		const shown = runs.filter((run) => !run.dismissedAt);
		const live = shown.filter((run) => RunStore.isLive(run.status));
		const recent = new Set(
			shown
				.filter((run) => !RunStore.isLive(run.status))
				.slice(0, Math.max(0, RECENT_RUNS - live.length)),
		);
		return shown.filter(
			(run) => RunStore.isLive(run.status) || recent.has(run),
		);
	};

	/**
	 * The device's runs, read from `$KABANE_HOME/loops` on every call. A question the board
	 * answers for one of a run's sessions is noted in the run's inbox as answered by `actor`, the
	 * board's, as `kabane loop answer` notes its own.
	 */
	export const source = ({
		home,
		basePath,
		actor,
	}: {
		home: string;
		basePath: string;
		actor: string;
	}): ActivitySource => ({
		// A run whose tab the human closed is not listed again; `kabane loop status` still shows it.
		load: async () => {
			const runs = RunStore.list(home);
			return runs.ok ? ok(listed(runs.value).map(card)) : runs;
		},
		card: async (id) => {
			const run = RunStore.read(home, id);
			return run.ok ? ok(card(run.value)) : run;
		},
		events: async (id, afterSeq) => {
			const events = RunStore.readEvents(home, id, afterSeq);
			return events.ok
				? ok(
						events.value.map(({ seq, at, type, summary, lane }) => ({
							seq,
							at,
							type,
							summary,
							...(lane ? { lane } : {}),
						})),
					)
				: events;
		},
		act: (id, actionId, input) => act({ home, basePath }, id, actionId, input),
		dismiss: async (id) => {
			const dismissed = RunStore.dismiss(home, id, new Date());
			return dismissed.ok ? ok(undefined) : dismissed;
		},
		answering: (questionId) =>
			Loop.answering({ home, basePath, actor }, questionId),
	});
}
