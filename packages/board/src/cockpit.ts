// How a card tab with a map is arranged (DESIGN.md, "Run map"): stacked under the run row below
// SPLIT_COLS, and from there split in two. The left column, LEFT_COLS wide, holds the map, what
// waits on the human and what the run runs with; the right one holds "now" over the log of the
// session under the map's cursor. The regions and their keys are the same at every width; only
// their arrangement changes. Plain functions, so the thresholds and row budgets are tested without
// a renderer.
import type { ActivityCard, ActivityFact } from "@kabane/extension";
import { RunMap } from "./run-map";

export namespace Cockpit {
	/** From this width the tab splits into two columns. */
	export const SPLIT_COLS = 160;
	/** The left column: the longest session name and its result on one row. */
	export const LEFT_COLS = 66;
	/** "Now" keeps at least this many event rows, and over a log takes at most NOW_MAX_ROWS. */
	export const NOW_MIN_ROWS = 5;
	export const NOW_MAX_ROWS = 16;

	export const split = (width: number): boolean => width >= SPLIT_COLS;

	/**
	 * The lane whose log the split's right column shows: the one `enter` opened, else the session
	 * under the cursor. A step, a session still to come or an issue left for the human opens none.
	 */
	export const logLane = (
		card: RunMap.Card,
		view: RunMap.View & { lane?: string | null },
		asking?: ReadonlySet<string>,
	): string | undefined => {
		if (view.lane) return view.lane;
		const row = RunMap.at(card, view, asking);
		return row?.type === "session" ? row.session.lane : undefined;
	};

	/**
	 * Whether "now" stands over the log: always on a finished card, whose "now" is its trace; while it
	 * runs, unless the one live session is the log already, which would say each line twice.
	 */
	export const nowOverLog = (
		card: Pick<ActivityCard, "liveLanes">,
		live: boolean,
		lane: string,
	): boolean => {
		if (!live) return true;
		const lanes = card.liveLanes ?? [];
		return !(lanes.length === 1 && lanes[0] === lane);
	};

	/**
	 * The event rows "now" may take over a log, in a column of `rows`: up to NOW_MAX_ROWS, never more
	 * than half the column, never fewer than NOW_MIN_ROWS.
	 */
	export const nowCap = (rows: number): number =>
		Math.max(NOW_MIN_ROWS, Math.min(NOW_MAX_ROWS, Math.floor(rows / 2)));

	/** Facts packed into rows of `width`, whole facts only, as many to a row as fit. */
	export const factRows = (
		facts: readonly ActivityFact[],
		width: number,
	): ActivityFact[][] => {
		const rows: ActivityFact[][] = [];
		let used = 0;
		for (const fact of facts) {
			const cols = fact.label.length + 1 + fact.value.length;
			const row = rows.at(-1);
			if (row && used + 3 + cols <= width) {
				row.push(fact);
				used += 3 + cols;
			} else {
				rows.push([fact]);
				used = cols;
			}
		}
		return rows;
	};
}
