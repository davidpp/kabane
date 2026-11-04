// The in-memory record of the copilot's turns, the current one projected as ONE activity card so the
// header strip, the event view and the footer spinner show it through the machinery they already have.
// Nothing here persists: the list is a session buffer, capped, and gone when the board closes.
// `start`, `apply` and `footer` are pure; `source` is the ActivitySource-shaped adapter app.tsx
// hands the event view, layered over the host's own source.
import { ok } from "@cabane/core";
import { BoardActivity } from "./activity";
import {
	type ActivityCard,
	type ActivityEvent,
	type ActivitySource,
	type CopilotStep,
	type CopilotUpdate,
	type CopilotUsage,
	type PlanEntry,
	PROMPT_EVENT,
} from "./ports";

export namespace CopilotLog {
	// The one card id the reducer and the source agree on; `o` opens the event view on it.
	export const CARD_ID = "copilot";
	const KIND = "copilot";

	// One prompt and everything it produced: the transcript of that exchange, the agent's todo list
	// while it worked, and the card carrying its outcome.
	type Turn = {
		prompt: string;
		card: ActivityCard;
		events: ActivityEvent[];
		// The agent's todo list for the turn, as last sent. Replaced wholesale, never merged.
		plan: readonly PlanEntry[];
		// What the footer says while running: the last tool call, else "thinking".
		activity: string;
		// The agent's last prose lines, newest last: the panel shows a few, the footer flash the last.
		tail: readonly string[];
	};

	// The turn in hand and the few behind it. `current` is its own field rather than the last element
	// of a list because there is ALWAYS one — a log exists only once a turn has started — and a
	// current-turn-or-undefined would put a fallback in every reader of the pane and the footer.
	// `usage` is the session's, not a turn's: the latest reading of its context window, null until the
	// harness has sent one, and kept across turns.
	export type Log = {
		past: readonly Turn[];
		current: Turn;
		usage: CopilotUsage | null;
	};

	// How many turns the transcript keeps. Enough to re-read what you asked two questions ago, which
	// is what asking a second one used to cost; not a history, and never written down.
	const TURN_CAP = 5;

	const lastSeq = (turn: Turn): number =>
		turn.events[turn.events.length - 1]?.seq ?? 0;

	// Seqs run across the WHOLE log, not per turn: the event view reads every turn through the one
	// card and asks for what comes after the last seq it saw, so a second turn restarting at 1 would
	// read as already-seen. Numbering at read time instead would shift under the cap.
	export const start = (log: Log | null, prompt: string, at: string): Log => ({
		past: log ? [...log.past, log.current].slice(-(TURN_CAP - 1)) : [],
		usage: log?.usage ?? null,
		current: {
			prompt,
			card: {
				id: CARD_ID,
				kind: KIND,
				label: "copilot",
				status: "running",
				startedAt: at,
				detail: [],
				hasEvents: true,
			},
			// The prompt opens its own transcript. It is what the event view draws the rule from, so
			// every turn is introduced by the question it answers.
			events: [
				{
					seq: log ? lastSeq(log.current) + 1 : 1,
					at,
					type: PROMPT_EVENT,
					summary: prompt,
				},
			],
			plan: [],
			activity: "thinking",
			tail: [],
		},
	});

	// Event-view types: a call opening is its `tool_use`, and its end `tool_result` or `tool_failed`
	// (ToolRows folds the pair into one row); the glyph table knows `text` and `error`, and `thought`
	// falls to its blank, muted default, which is the dimmed rendering wanted for it. A notice is the
	// event view's `warning` when it is one, a muted `notice` otherwise.
	const eventType = (update: CopilotUpdate): string =>
		update.type === "tool_call"
			? "tool_use"
			: update.type === "notice" && update.severity === "warning"
				? "warning"
				: update.type;

	// How far the turn is through its own plan, for the one-line indicator. Absent without a plan:
	// harnesses that never send one keep today's text rather than showing a hollow `0/0`.
	export const progress = (
		plan: readonly PlanEntry[],
	): { done: number; total: number } | null =>
		plan.length === 0
			? null
			: {
					done: plan.filter((e) => e.status === "completed").length,
					total: plan.length,
				};

	const firstLine = (text: string): string => text.split("\n")[0] ?? "";

	// How many of the agent's prose lines the log keeps. The transcript has all of them; this is the
	// glance surface's tail.
	const TAIL_CAP = 6;

	const lastLine = (tail: readonly string[]): string =>
		tail[tail.length - 1] ?? "";

	// The updates that are a line of the transcript as they come: the steps and the notices.
	type Line = Extract<CopilotUpdate, { type: CopilotStep | "notice" }>;

	// One line as the event view reads it, with the tool call it belongs to and what was known of
	// the call then, when it is one.
	const record = (seq: number, update: Line): ActivityEvent => ({
		seq,
		at: update.at,
		type: eventType(update),
		summary: update.summary,
		...(update.type !== "notice" && update.callId !== undefined
			? { callId: update.callId }
			: {}),
		...(update.type !== "notice" && update.detail
			? { detail: update.detail }
			: {}),
	});

	const applyToTurn = (turn: Turn, update: CopilotUpdate): Turn => {
		if (update.type === "plan") return { ...turn, plan: update.entries };
		// The harness's command list is the `/` palette's, which the reducer holds, and its usage the
		// log's: nothing in the turn changes.
		if (update.type === "commands" || update.type === "usage") return turn;
		// The pending choice is rendered from the reducer's copy, not from here; what the transcript
		// keeps is the RECORD that it was asked, which outlives the answer and reads in the order it
		// happened, between the tool call that provoked it and whatever followed. A form reads as
		// the same kind of row: the event view's `?` is a question, whatever shape its answer takes.
		if (update.type === "permission" || update.type === "elicitation")
			return {
				...turn,
				events: [
					...turn.events,
					{
						seq: lastSeq(turn) + 1,
						at: update.at,
						type: "permission",
						summary:
							update.type === "permission"
								? `permission: ${update.request.title}`
								: `asks: ${update.request.message}`,
					},
				],
			};
		// The record of a question the harness took back, in the order it happened; the block that
		// asked it is gone from the reducer's copy.
		if (update.type === "withdrawn")
			return {
				...turn,
				events: [
					...turn.events,
					{
						seq: lastSeq(turn) + 1,
						at: update.at,
						type: "withdrawn",
						summary: update.summary,
					},
				],
			};
		const events =
			update.type === "done"
				? turn.events
				: [...turn.events, record(lastSeq(turn) + 1, update)];
		switch (update.type) {
			case "tool_call":
				return { ...turn, events, activity: update.summary };
			case "text":
				return {
					...turn,
					events,
					tail: [...turn.tail, firstLine(update.summary)].slice(-TAIL_CAP),
				};
			case "thought":
			case "tool_result":
			case "tool_failed":
			case "mode":
			case "notice":
				return { ...turn, events };
			case "error":
				return {
					...turn,
					events,
					card: {
						...turn.card,
						status: "failed",
						finishedAt: update.at,
						error: update.summary,
					},
				};
			case "done":
				return {
					...turn,
					card: { ...turn.card, status: "completed", finishedAt: update.at },
				};
		}
	};

	// Every update belongs to the turn in flight; a finished one is never written to again (the
	// reducer refuses a prompt while one runs, so there is only ever one).
	export const apply = (log: Log, update: CopilotUpdate): Log =>
		update.type === "usage"
			? {
					...log,
					usage: {
						used: update.used,
						size: update.size,
						...(update.cost ? { cost: update.cost } : {}),
					},
				}
			: { ...log, current: applyToTurn(log.current, update) };

	// The footer's reading of the session's context window, `ctx 42% · $0.31`. Null while nothing is
	// known, which hides it.
	export const usageLabel = (log: Log | null): string | null => {
		const usage = log?.usage;
		if (!usage || usage.size <= 0) return null;
		const ctx = `ctx ${Math.round((usage.used / usage.size) * 100)}%`;
		return usage.cost ? `${ctx} · ${money(usage.cost)}` : ctx;
	};

	const money = ({
		amount,
		currency,
	}: NonNullable<CopilotUsage["cost"]>): string =>
		currency === "USD"
			? `$${amount.toFixed(2)}`
			: `${amount.toFixed(2)} ${currency}`;

	// Cancel from the board side: the turn ends as failed with a reason, no event appended.
	export const cancelled = (log: Log, at: string): Log => ({
		...log,
		current: {
			...log.current,
			card: {
				...log.current.card,
				status: "failed",
				finishedAt: at,
				error: "cancelled",
			},
		},
	});

	// The copilot card leads the host's cards, so the event view, `o` and the shared spinner find it;
	// the board's header strip skips it, the pane being where the turn is shown. Questions come from
	// the tracker and pass through untouched.
	export const withActivity = (
		activity: BoardActivity.ActivityMap,
		log: Log | null,
	): BoardActivity.ActivityMap => {
		if (!log) return activity;
		const merged = BoardActivity.indexCards([
			log.current.card,
			...activity.cards.filter((card) => card.id !== CARD_ID),
		]);
		merged.questionsByTaskId = activity.questionsByTaskId;
		return merged;
	};

	// Every turn's events in the order they happened, each opened by its prompt.
	const transcript = (log: Log): readonly ActivityEvent[] =>
		[...log.past, log.current].flatMap((turn) => turn.events);

	// The event view reads the copilot card through the same port as any host card. `read` is a
	// getter, not a value, because the log changes while the view polls it.
	export const source = (
		host: ActivitySource,
		read: () => Log | null,
	): ActivitySource => ({
		load: async () => {
			const cards = await host.load();
			const log = read();
			if (!cards.ok) return log ? ok([log.current.card]) : cards;
			return ok(log ? [log.current.card, ...cards.value] : cards.value);
		},
		card: async (id) => {
			if (id !== CARD_ID) return host.card ? host.card(id) : ok(null);
			return ok(read()?.current.card ?? null);
		},
		events: async (id, afterSeq) => {
			if (id !== CARD_ID)
				return host.events ? host.events(id, afterSeq) : ok([]);
			const log = read();
			return ok(log ? transcript(log).filter((e) => e.seq > afterSeq) : []);
		},
		// The copilot's card never asks for a tab, so every action and dismissal is the host's.
		...(host.act ? { act: host.act.bind(host) } : {}),
		...(host.dismiss ? { dismiss: host.dismiss.bind(host) } : {}),
		...(host.answering ? { answering: host.answering.bind(host) } : {}),
	});

	export type Footer = { text: string; tone: "running" | "done" | "error" };

	// The footer indicator, always about the CURRENT turn: spinner + what the agent is doing while
	// running; a check and the first line of its last prose on completion; the failure reason
	// otherwise. A failure often carries the harness's whole stderr, and this is one row: the rest of
	// it waits in the event view.
	export const footer = (log: Log, spinnerFrame: string): Footer => {
		const turn = log.current;
		switch (turn.card.status) {
			case "completed":
				return {
					text: `✓ copilot · ${lastLine(turn.tail) || "done"}`,
					tone: "done",
				};
			case "failed":
				return {
					text: `✗ copilot · ${firstLine(turn.card.error ?? "failed")}`,
					tone: "error",
				};
			default: {
				const done = progress(turn.plan);
				const counted = done ? `${done.done}/${done.total} · ` : "";
				return {
					text: `${spinnerFrame} copilot · ${counted}${turn.activity}`,
					tone: "running",
				};
			}
		}
	};
}
