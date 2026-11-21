// A card's steps as the rows of its map, and the cursor over them: plain functions over the card's
// data and the tab's view (BoardTabs.CardView), so the keys and the view agree without a renderer.
//
// The map is one row per step; an open step adds a row per session under it, and what the card left
// for the human follows the steps. A step opens by itself while it runs and folds once it is over,
// unless the human opened or folded it (`l`/`h`), which holds. The cursor is a row's key, never an
// index: the card and the rows under the cursor change between polls.
//
// Until the human moves it, the cursor follows the run: onto a session that waits on the human, else
// onto the live session that started last. Once moved, it stays on its row until `f` hands it back.
import type {
	ActivityLeft,
	ActivitySession,
	ActivityStep,
} from "@kabane/extension";

export namespace RunMap {
	export type Row =
		| { type: "step"; key: string; step: ActivityStep; open: boolean }
		| {
				type: "session";
				key: string;
				// The step the session belongs to, by its row key.
				parent: string;
				session: ActivitySession;
		  }
		| { type: "left"; key: string; item: ActivityLeft };

	/** What the map is drawn from: the card's steps and left list, and the tab's view of them. */
	export type Card = {
		steps?: readonly ActivityStep[];
		left?: readonly ActivityLeft[];
		// The lanes still live, the most recently started first.
		liveLanes?: readonly string[];
	};

	export type View = {
		cursor?: string;
		follow?: boolean;
		folds?: ReadonlyMap<string, boolean>;
	};

	export const stepKey = (step: ActivityStep): string => `step:${step.name}`;

	const sessionKey = (step: ActivityStep, session: ActivitySession): string =>
		`${stepKey(step)}/${session.lane ?? session.name}`;

	const leftKey = (item: ActivityLeft): string =>
		`left:${item.taskId ?? item.taskShortId ?? item.how}`;

	/** Whether a step shows its sessions: as the human left it, else while it runs. */
	export const isOpen = (view: View, step: ActivityStep): boolean =>
		view.folds?.get(step.name) ??
		(step.state === "running" && (step.sessions?.length ?? 0) > 0);

	/** Every row the cursor can stop on, in order. */
	export const rows = (card: Card, view: View): Row[] => [
		...(card.steps ?? []).flatMap((step): Row[] => {
			const open = isOpen(view, step) && (step.sessions?.length ?? 0) > 0;
			const key = stepKey(step);
			return [
				{ type: "step", key, step, open },
				...(open
					? (step.sessions ?? []).map((session): Row => ({
							type: "session",
							key: sessionKey(step, session),
							parent: key,
							session,
						}))
					: []),
			];
		}),
		...(card.left ?? []).map((item): Row => ({
			type: "left",
			key: leftKey(item),
			item,
		})),
	];

	/**
	 * The rows the map takes unwindowed, at most: one per row, and a blank row and a heading before
	 * what was left. Merging finished steps on a narrow pane only lowers it.
	 */
	export const height = (card: Card, view: View): number => {
		const all = rows(card, view);
		return all.length + (all.some((row) => row.type === "left") ? 2 : 0);
	};

	/**
	 * The row the run is at: the session a question waits on, else the live session that started
	 * last, else nowhere. A session in a step the human folded gives its step's row.
	 */
	const followed = (
		card: Card,
		view: View,
		asking: ReadonlySet<string>,
	): string | undefined => {
		const lanes = [...asking, ...(card.liveLanes ?? [])];
		for (const lane of lanes)
			for (const step of card.steps ?? []) {
				const session = step.sessions?.find((s) => s.lane === lane);
				if (session)
					return isOpen(view, step) ? sessionKey(step, session) : stepKey(step);
			}
		return undefined;
	};

	/**
	 * The cursor's row key: where the run is while following, else where the human left it. A row
	 * that went (its step folded) gives its step's row, and any other the first left item.
	 */
	export const cursor = (
		card: Card,
		view: View,
		asking: ReadonlySet<string> = new Set(),
	): string | undefined => {
		if (view.follow !== false) return followed(card, view, asking);
		const all = rows(card, view);
		const at = view.cursor;
		if (at === undefined || all.some((row) => row.key === at)) return at;
		const parent = at.split("/")[0];
		if (all.some((row) => row.key === parent)) return parent;
		return all.find((row) => row.type === "left")?.key ?? all[0]?.key;
	};

	/** The row the cursor is on, if any. */
	export const at = (
		card: Card,
		view: View,
		asking?: ReadonlySet<string>,
	): Row | undefined => {
		const key = cursor(card, view, asking);
		return rows(card, view).find((row) => row.key === key);
	};

	/**
	 * The key one row up or down from the cursor, held at the ends. From no cursor, down starts at
	 * the first row and up at the last.
	 */
	export const move = (
		card: Card,
		view: View,
		delta: 1 | -1,
		asking?: ReadonlySet<string>,
	): string | undefined => {
		const all = rows(card, view);
		if (all.length === 0) return undefined;
		const at = cursor(card, view, asking);
		const from = all.findIndex((row) => row.key === at);
		if (from === -1) return (delta === 1 ? all[0] : all.at(-1))?.key;
		return all[Math.max(0, Math.min(all.length - 1, from + delta))]?.key;
	};
}
