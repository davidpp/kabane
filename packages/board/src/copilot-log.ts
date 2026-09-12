// The in-memory record of the copilot's current turn, projected as ONE activity card so the sidebar,
// the event view and the footer spinner show it through the machinery they already have. Nothing
// here persists: the log is replaced on the next turn and gone when the board closes. `start`,
// `apply` and `footer` are pure; `source` is the ActivitySource-shaped adapter app.tsx hands the
// event view, layered over the host's own source.
import { ok } from "@cabane/core";
import { BoardActivity } from "./activity";
import type {
	ActivityCard,
	ActivityEvent,
	ActivitySource,
	CopilotUpdate,
	PlanEntry,
} from "./ports";

export namespace CopilotLog {
	// The one card id the reducer and the source agree on; `o` opens the event view on it.
	export const CARD_ID = "copilot";
	export const KIND = "copilot";

	export type Log = {
		card: ActivityCard;
		events: ActivityEvent[];
		// The agent's todo list for the turn, as last sent. Replaced wholesale, never merged.
		plan: readonly PlanEntry[];
		// What the footer says while running: the last tool call, else "thinking".
		activity: string;
		// The agent's last prose line, for the `✓ copilot · …` flash on `done`.
		lastText: string;
	};

	export const start = (at: string): Log => ({
		card: {
			id: CARD_ID,
			kind: KIND,
			label: "copilot",
			status: "running",
			startedAt: at,
			detail: [],
			hasEvents: true,
		},
		events: [],
		plan: [],
		activity: "thinking",
		lastText: "",
	});

	// Event-view types: the glyph table there knows `text`, `tool_use`, `tool_result`, `error`;
	// `thought` falls to its blank, muted default, which is the dimmed rendering wanted for it.
	const eventType = (type: CopilotUpdate["type"]): string =>
		type === "tool_call" ? "tool_use" : type;

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

	export const apply = (log: Log, update: CopilotUpdate): Log => {
		if (update.type === "plan") return { ...log, plan: update.entries };
		const events =
			update.type === "done"
				? log.events
				: [
						...log.events,
						{
							seq: log.events.length + 1,
							at: update.at,
							type: eventType(update.type),
							summary: update.summary,
						},
					];
		switch (update.type) {
			case "tool_call":
				return { ...log, events, activity: update.summary };
			case "text":
				return { ...log, events, lastText: firstLine(update.summary) };
			case "thought":
			case "tool_result":
				return { ...log, events };
			case "error":
				return {
					...log,
					events,
					card: {
						...log.card,
						status: "failed",
						finishedAt: update.at,
						error: update.summary,
					},
				};
			case "done":
				return {
					...log,
					card: { ...log.card, status: "completed", finishedAt: update.at },
				};
		}
	};

	// Cancel from the board side: the turn ends as failed with a reason, no event appended.
	export const cancelled = (log: Log, at: string): Log => ({
		...log,
		card: { ...log.card, status: "failed", finishedAt: at, error: "cancelled" },
	});

	// The copilot card leads the host's cards, so it is the first thing in the sidebar and the one
	// `anyRunning` animates on. Questions come from the tracker and pass through untouched.
	export const withActivity = (
		activity: BoardActivity.ActivityMap,
		log: Log | null,
	): BoardActivity.ActivityMap => {
		if (!log) return activity;
		const merged = BoardActivity.indexCards([
			log.card,
			...activity.cards.filter((card) => card.id !== CARD_ID),
		]);
		merged.questionsByTaskId = activity.questionsByTaskId;
		return merged;
	};

	// The event view reads the copilot card through the same port as any host card. `read` is a
	// getter, not a value, because the log changes while the view polls it.
	export const source = (
		host: ActivitySource,
		read: () => Log | null,
	): ActivitySource => ({
		load: async () => {
			const cards = await host.load();
			const log = read();
			if (!cards.ok) return log ? ok([log.card]) : cards;
			return ok(log ? [log.card, ...cards.value] : cards.value);
		},
		card: async (id) => {
			if (id !== CARD_ID) return host.card ? host.card(id) : ok(null);
			return ok(read()?.card ?? null);
		},
		events: async (id, afterSeq) => {
			if (id !== CARD_ID)
				return host.events ? host.events(id, afterSeq) : ok([]);
			return ok((read()?.events ?? []).filter((e) => e.seq > afterSeq));
		},
	});

	export type Footer = { text: string; tone: "running" | "done" | "error" };

	// The footer indicator: spinner + what the agent is doing while running; a check and the first
	// line of its last prose on completion; the failure reason otherwise. A failure often carries
	// the harness's whole stderr, and this is one row: the rest of it waits in the event view.
	export const footer = (log: Log, spinnerFrame: string): Footer => {
		switch (log.card.status) {
			case "completed":
				return {
					text: `✓ copilot · ${log.lastText || "done"}`,
					tone: "done",
				};
			case "failed":
				return {
					text: `✗ copilot · ${firstLine(log.card.error ?? "failed")}`,
					tone: "error",
				};
			default: {
				const done = progress(log.plan);
				const counted = done ? `${done.done}/${done.total} · ` : "";
				return {
					text: `${spinnerFrame} copilot · ${counted}${log.activity}`,
					tone: "running",
				};
			}
		}
	};
}
