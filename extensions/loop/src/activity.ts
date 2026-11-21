// The loop's runs as board activity: each run is a card with a tab of its own, its events are the
// run's `events.jsonl`, and its questions name the card and lane that ask them. Each
// claim is a lane, so the tab can follow one session or tag every line with whose it is.
import {
	type Host,
	type ActivityCard,
	type ActivityEvent,
	type ActivityQuestion,
	type ActivitySource,
	type ActivityStatus,
	type CardAction,
	type NoticeSeverity,
	type StopAction,
} from "@kabane/extension";
import { err, ok } from "./result";

import { existsSync } from "node:fs";
import type { Result } from "@kabane/core";
import { Loop } from "./commands";
import { LoopPlan } from "./plan";
import { parseQuestionBody } from "./question-body";
import { RunSteps } from "./steps";
import { RunStore } from "./store";

const STOP_ACTION: StopAction = "stop";

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
			input: "a subtask's short id, or the issue's · it is never claimed",
		},
		{
			id: "next",
			key: "n",
			label: "next",
			input: "a subtask's short id, or the issue's · claimed first once ready",
		},
	];

	// What the human can do to a run whose runner died: start it again (`Loop.restart`).
	const RESTART: CardAction = { id: "restart", key: "r", label: "restart" };

	// The lanes a message can still reach: the claims whose session has not ended, the most recently
	// started first, which is where the board aims a message sent from the all-agents view.
	const liveLanes = (run: RunStore.Run): string[] =>
		run.claims
			.filter((claim) => claim.endedAt === undefined)
			.map((claim) => claim.lane)
			.toReversed();

	/** The kind a run's card has: what the board's strip counts and the header is keyed by. */
	export const KIND = "loops";

	/**
	 * A run as a card. `nodes` are the parent's children as the tracker holds them now, which the
	 * steps count findings and finished work from; without them the steps are what run.json says.
	 */
	export const card = (
		run: RunStore.Run,
		nodes: readonly LoopPlan.Node[] | null = null,
		now: Date = new Date(),
		after: RunSteps.After = {},
	): ActivityCard => {
		const left = RunSteps.left(run, nodes, after);
		return {
			...base(run),
			steps: RunSteps.of(run, nodes, now, after),
			facts: RunSteps.facts(run),
			...(left.length > 0 ? { left } : {}),
		};
	};

	const base = (run: RunStore.Run): ActivityCard => ({
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
		// One lane per claim, in claim order: claims only append, so a session keeps its color.
		lanes: run.claims.map((claim) => claim.lane),
		laneNoun: "agents",
		...(RunStore.isLive(run.status)
			? { actions: actions(run), liveLanes: liveLanes(run) }
			: Loop.died(run)
				? { actions: [RESTART] }
				: {}),
	});

	type ActDeps = {
		host: Host;
		home: string;
		basePath: string;
		kabaneBin: string;
	};

	/**
	 * Run an action through the run's inbox, which the runner reads every tick. `stop` is the
	 * command's own (`kabane loop stop`), without waiting for the run to wind down; `pause`,
	 * `resume`, `skip` and `next` are the commands' own too; `inject` is appended for the session
	 * behind the lane, and refused for a session that has ended. `restart`, on a run whose runner
	 * died, is `Loop.restart`'s detached runner, as `kabane loop resume` starts it.
	 */
	export const act = async (
		deps: ActDeps,
		runId: string,
		actionId: string,
		input: { text?: string; lane?: string },
	): Promise<Result<string>> => {
		const { home } = deps;
		if (actionId === RESTART.id) {
			const restarted = await Loop.restart(deps, runId);
			return restarted.ok ? ok(`${runId} restarted`) : restarted;
		}
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
				if (task === "")
					return err(
						new Error(
							`${actionId} needs a subtask, or the issue of a single-issue run`,
						),
					);
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

	const SEVERITIES: readonly NoticeSeverity[] = ["info", "warning", "error"];

	// A notice's severity as the run's dispatch wrote it in the event's data; anything else is none,
	// and the board falls back to the summary's `<severity>:` prefix.
	const noticeSeverity = (
		value: string | number | undefined,
	): NoticeSeverity | undefined => SEVERITIES.find((s) => s === value);

	const BOARD_TYPE: Readonly<Record<string, string>> = {
		session_start: "phase",
		session_end: "done",
		gate_passed: "done",
		landed: "done",
		gate_failed: "error",
		merge_conflict: "error",
		pruned: "done",
		permission_asked: "permission",
		elicitation_asked: "permission",
	};
	const summaryOf = (e: RunStore.Event): string => {
		switch (e.type) {
			case "pruned":
				return `pruned · ${e.summary.replace(/^worktree .+ and branch .+ removed: /, "worktree and branch removed: ")}`;
			case "gate_passed":
			case "gate_failed":
				// Between sessions these rows carry no tag, so the subject says whose gates ran.
				return `gates · ${e.task ? `${e.task} · ` : ""}${e.summary}`;
			case "landed":
				return `land · ${e.summary}`;
			default:
				return e.summary;
		}
	};
	const TRANSCRIPT = new Set([
		"text",
		"thought",
		"prompt",
		"tool_call",
		"tool_completed",
		"tool_failed",
		"notice",
		"warning",
		"error",
		"metric",
		"phase",
		"permission",
	]);
	const RUN_EVENTS = new Set([
		"claim",
		"gates",
		"gate_passed",
		"gate_failed",
		"merged",
		"merge_conflict",
	]);

	const boardEvent = (
		e: RunStore.Event,
		setup: readonly RunStore.Event[] = [],
	): ActivityEvent => {
		const severity =
			e.type === "notice" ? noticeSeverity(e.data?.severity) : undefined;
		const claim = setup.find((entry) => entry.type === "claim");
		const detail = setup
			.filter((entry) => entry !== claim)
			.map((entry) => entry.summary);
		return {
			seq: e.seq,
			at: e.at,
			type:
				BOARD_TYPE[e.type] ?? (TRANSCRIPT.has(e.type) ? e.type : "progress"),
			summary: claim?.summary ?? summaryOf(e),
			...(setup.length ? { includes: setup.map((entry) => entry.seq) } : {}),
			...(severity ? { severity } : {}),
			...(e.lane !== undefined ? { lane: e.lane } : {}),
			...(e.lane === undefined || RUN_EVENTS.has(e.type) ? { run: true } : {}),
			...(e.callId ? { callId: e.callId } : {}),
			...(detail.length
				? { detail: { input: detail.join("\n") } }
				: e.detail
					? { detail: e.detail }
					: {}),
		};
	};

	// A poll can split the claim and handshake from the start. Recover the start's context
	// from the same append-only log, including entries before the caller's cursor.
	export const boardEvents = (
		log: readonly RunStore.Event[],
		afterSeq: number,
	): ActivityEvent[] => {
		if ((log.at(-1)?.seq ?? 0) <= afterSeq) return [];
		const setup = new Map<string, RunStore.Event[]>();
		const out: ActivityEvent[] = [];
		for (const e of log) {
			const key = e.session ?? e.lane;
			if (key && e.type === "claim") setup.set(key, [e]);
			if (key && ["launch", "model", "mode"].includes(e.type)) {
				const entries = setup.get(key) ?? [];
				entries.push(e);
				setup.set(key, entries);
			}
			const start =
				key && e.type === "session_start" ? setup.get(key) : undefined;
			if (key && (e.type === "session_start" || e.type === "session_end"))
				setup.delete(key);
			if (e.seq > afterSeq) out.push(boardEvent(e, start));
		}
		return out;
	};

	// What became of an over run's worktree. Its event log is read only once the directory is gone, to
	// tell `kabane loop prune`'s removal, which follows a merge, from a directory removed by hand.
	const afterOf = (home: string, run: RunStore.Run): RunSteps.After => {
		if (
			RunStore.isLive(run.status) ||
			run.worktree === undefined ||
			existsSync(run.worktree)
		)
			return {};
		const events = RunStore.readEvents(home, run.id);
		return {
			worktree:
				events.ok && events.value.some((e) => e.type === "pruned")
					? "pruned"
					: "missing",
		};
	};

	/**
	 * The device's runs, read from `$KABANE_HOME/loops` on every call. A question the board
	 * answers for one of a run's sessions is noted in the run's inbox as answered by `actor`, the
	 * board's, as `kabane loop answer` notes its own.
	 */
	export const source = ({
		home,
		host,
		basePath,
		actor,
		kabaneBin,
	}: ActDeps & { actor: string }): ActivitySource => {
		// A run whose children cannot be read still gets its card, its steps from run.json alone.
		const cardOf = async (run: RunStore.Run): Promise<ActivityCard> => {
			const nodes = await LoopPlan.children(host.record, run.parentId);
			return card(
				run,
				nodes.ok ? nodes.value : null,
				new Date(),
				afterOf(home, run),
			);
		};
		return {
			// A run whose tab the human closed is not listed again; `kabane loop status` still shows it.
			load: async () => {
				const runs = RunStore.list(home);
				if (!runs.ok) return runs;
				return ok(await Promise.all(listed(runs.value).map(cardOf)));
			},
			card: async (id) => {
				const run = RunStore.read(home, id);
				return run.ok ? ok(await cardOf(run.value)) : run;
			},
			events: async (id, afterSeq) => {
				const events = RunStore.readEvents(home, id);
				return events.ok ? ok(boardEvents(events.value, afterSeq)) : events;
			},
			act: (id, actionId, input) =>
				act({ home, basePath, host, kabaneBin }, id, actionId, input),
			dismiss: async (id) => {
				const dismissed = RunStore.dismiss(home, id, new Date());
				return dismissed.ok ? ok(undefined) : dismissed;
			},
			questions: async () => {
				const runs = RunStore.list(home);
				if (!runs.ok) return runs;
				const questions: ActivityQuestion[] = [];
				for (const run of runs.value.filter((r) => RunStore.isLive(r.status))) {
					const entries = RunStore.pendingQuestions(home, run);
					if (!entries.ok) return entries;
					for (const { question, claim } of entries.value) {
						const parsed = parseQuestionBody(question.body);
						questions.push({
							id: question.id,
							cardId: run.id,
							lane: claim.lane,
							taskId: claim.taskId,
							taskShortId: claim.shortId,
							question: parsed.question,
							choices: parsed.choices,
							multiSelect: parsed.multiSelect,
							allowFreeform: parsed.allowFreeform,
							...(parsed.permission ? { permission: true } : {}),
							asker: claim.harness,
							askedAt: question.createdAt,
						});
					}
				}
				return ok(questions);
			},
			answer: async (id, text) => {
				const answered = await Loop.answer(
					{ home, basePath, host, actor },
					id,
					text,
				);
				return answered.ok ? ok(`answered ${answered.value.answer}`) : answered;
			},
		};
	};
}
