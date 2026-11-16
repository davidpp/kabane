// In-flight activity seam for the board: host activity cards (via the ActivitySource port) plus
// awaiting-input questions supplied by that same port. app.tsx fetches this in the same 5s poll
// as loadBoard and threads the result down as props.
import { ok, type Result } from "@cabane/core";
import {
	type ActivityCard,
	type ActivityQuestion,
	type ActivitySource,
} from "@cabane/extension";
import { isInFlight } from "./ports";

export namespace BoardActivity {
	export type AwaitingQuestion = Omit<ActivityQuestion, "asker"> & {
		agent: string;
	};

	export type ActivityMap = {
		// Every card the source returned, newest first.
		cards: ActivityCard[];
		// In-flight cards keyed by task ULID (card badges, detail header).
		inFlightByTaskId: Map<string, ActivityCard[]>;
		// In-flight cards keyed by task shortId, for hosts that only know the label.
		inFlightByShortId: Map<string, ActivityCard[]>;
		// Questions without a task share the empty key so they remain in the attention queue.
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
		source: ActivitySource,
	): Promise<Result<ActivityMap>> => {
		const cards = await source.load();
		const activity = indexCards(cards.ok ? cards.value : []);

		const questions = await source.questions?.();
		for (const { asker, ...question } of questions?.ok ? questions.value : []) {
			push(activity.questionsByTaskId, question.taskId ?? "", {
				...question,
				agent: asker,
			});
		}

		return ok(activity);
	};

	// Every question waiting on the human, oldest first: the order `!` walks them in.
	export const questions = (activity: ActivityMap): AwaitingQuestion[] =>
		[...activity.questionsByTaskId.values()]
			.flat()
			.sort((a, b) => a.askedAt.localeCompare(b.askedAt));

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

	// The card whose events `o` opens on a task: its first in-flight card with events, else its most
	// recent one. Undefined when none of its cards has events to read.
	export const eventsCard = (
		activity: ActivityMap,
		taskId: string,
		shortId?: string,
	): ActivityCard | undefined => {
		const cards = cardsForTask(activity, taskId, shortId).filter(
			(c) => c.hasEvents,
		);
		return (
			cards.find((c) => c.status === "running" || c.status === "pending") ??
			cards[0]
		);
	};

	// What `o` says on a task with no events card. A card without events that is still in flight, or
	// that still offers actions (`open`: an idle session someone has to stop), is shown elsewhere: the
	// notice names it and its last detail line, which is where a host says where to look.
	export const noEvents = (
		activity: ActivityMap,
		taskId: string,
		shortId: string | undefined,
		open: ReadonlyMap<string, unknown>,
	): string => {
		const card = cardsForTask(activity, taskId, shortId).find(
			(c) =>
				!c.tab &&
				(c.status === "running" || c.status === "pending" || open.has(c.id)),
		);
		if (!card) return "no events";
		const where = card.detail.at(-1);
		return `${card.label} has no events here${where ? ` · ${where}` : ""}`;
	};

	// Whether the shared spinner should animate: any live (non-stale) running card.
	export const anyRunning = (activity: ActivityMap): boolean =>
		activity.cards.some(
			(card) =>
				(card.status === "running" || card.status === "pending") && !card.stale,
		);
}
