// In-flight activity seam for the board: host activity cards (via the ActivitySource port) plus
// awaiting-input questions read straight from the tracker. Same posture as BoardData (data.ts) —
// direct reads, NO server. app.tsx fetches this in the same 5s poll as loadBoard and threads the
// result down as props.
import { ok, Planner, parseQuestionBody, type Result } from "@cabane/core";
import { type ActivityCard, type ActivitySource, isInFlight } from "./ports";

export namespace BoardActivity {
	export type AwaitingQuestion = {
		taskId: string;
		sessionId: string;
		questionActivityId: string;
		/** Human-readable question text (metadata fence stripped). */
		question: string;
	};

	export type ActivityMap = {
		// Every card the source returned, newest first (the sidebar list).
		cards: ActivityCard[];
		// In-flight cards keyed by task ULID (card badges, detail header).
		inFlightByTaskId: Map<string, ActivityCard[]>;
		// In-flight cards keyed by task shortId, for hosts that only know the label.
		inFlightByShortId: Map<string, ActivityCard[]>;
		questionsByTaskId: Map<string, AwaitingQuestion[]>;
	};

	export const emptyActivity = (): ActivityMap => ({
		cards: [],
		inFlightByTaskId: new Map(),
		inFlightByShortId: new Map(),
		questionsByTaskId: new Map(),
	});

	const push = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
		const list = map.get(key) ?? [];
		list.push(value);
		map.set(key, list);
	};

	// Pure projection of the source's cards into the lookup maps (unit-tested without disk).
	export const indexCards = (cards: ActivityCard[]): ActivityMap => {
		const activity = emptyActivity();
		activity.cards = cards;
		for (const card of cards) {
			if (!isInFlight(card)) continue;
			if (card.taskId) push(activity.inFlightByTaskId, card.taskId, card);
			if (card.taskShortId)
				push(activity.inFlightByShortId, card.taskShortId, card);
		}
		return activity;
	};

	// Load everything in flight. Reads are lenient — the board is a glance surface, so a failing
	// activity source must not blank the questions.
	export const loadActivity = async (
		basePath: string,
		source: ActivitySource,
	): Promise<Result<ActivityMap>> => {
		const cards = await source.load();
		const activity = indexCards(cards.ok ? cards.value : []);

		// Same storage call the tracker's `needsInput` surface uses — one row per unanswered question
		// activity, joined to its session + task.
		const needsInput = await Planner.getNeedsInput(basePath);
		if (!needsInput.ok) return needsInput;
		for (const row of needsInput.value) {
			if (!row.task || !row.question) continue;
			const parsed = parseQuestionBody(row.question.body);
			push(activity.questionsByTaskId, row.task.id, {
				taskId: row.task.id,
				sessionId: row.session.id,
				questionActivityId: row.question.id,
				question: parsed.question,
			});
		}

		return ok(activity);
	};

	// In-flight cards for a task, matched by ULID or shortId, deduped by card id. Pure.
	export const inFlightForTask = (
		activity: ActivityMap,
		taskId: string,
		shortId?: string,
	): ActivityCard[] => {
		const seen = new Set<string>();
		const result: ActivityCard[] = [];
		const take = (cards: ActivityCard[] | undefined): void => {
			for (const card of cards ?? []) {
				if (seen.has(card.id)) continue;
				seen.add(card.id);
				result.push(card);
			}
		};
		take(activity.inFlightByTaskId.get(taskId));
		if (shortId) take(activity.inFlightByShortId.get(shortId));
		return result;
	};

	// All cards for a task: in-flight first, then the rest of the recent list that references it.
	// Dedupes by card id and caps at `limit`. Pure, tested without disk.
	export const cardsForTask = (
		activity: ActivityMap,
		taskId: string,
		shortId?: string,
		limit = 5,
	): ActivityCard[] => {
		const result = inFlightForTask(activity, taskId, shortId);
		const seen = new Set(result.map((c) => c.id));
		for (const card of activity.cards) {
			if (result.length >= limit) break;
			if (seen.has(card.id)) continue;
			const matches =
				card.taskId === taskId ||
				(shortId !== undefined && card.taskShortId === shortId);
			if (!matches) continue;
			seen.add(card.id);
			result.push(card);
		}
		return result;
	};

	// Whether the shared spinner should animate: any live (non-stale) running card.
	export const anyRunning = (activity: ActivityMap): boolean =>
		activity.cards.some(
			(card) =>
				(card.status === "running" || card.status === "pending") && !card.stale,
		);
}
