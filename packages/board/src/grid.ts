// The grid the trigger form and the settings view share: a column of labelled values under section
// titles, one in hand, `j/k` to walk it and `h/l` to step the value in hand. Each surface keeps its
// own state, what a value looks like and what saving means; this owns what they lay out and read
// the same way. Its row on screen is grid-view.tsx.
import type { BoardNav } from "./nav";

/** The label column at its widest. */
const LABEL_COLS = 24;

export namespace Grid {
	/**
	 * The label column for `labels` in `cols`: as wide as the longest needs and a gap, up to
	 * LABEL_COLS, leaving `reserve` columns for the rest of the row.
	 */
	export const labelCols = (
		labels: readonly string[],
		cols: number,
		reserve: number,
	): number =>
		Math.max(
			0,
			Math.min(
				LABEL_COLS,
				Math.max(0, ...labels.map((label) => label.length)) + 2,
				cols - reserve,
			),
		);

	/** `text` in a label column of `cols`: cut with `…` when it does not fit, a space kept after it. */
	export const label = (text: string, cols: number): string =>
		(text.length < cols
			? text
			: cols < 2
				? ""
				: `${text.slice(0, cols - 2)}…`
		).padEnd(Math.max(0, cols));

	/** A section title at `depth` (0 the outermost), or an untitled break; or an item, by its place. */
	export type Line<T> =
		| { kind: "title"; depth: number; title?: string }
		| { kind: "item"; index: number; item: T };

	/**
	 * `items` in order, with a title wherever a level's section changes, outermost first. A level
	 * changing starts every level under it again. An item with no section after one that had one
	 * gets an untitled break, so it does not read as the previous title's.
	 */
	export const sections = <T>(
		items: readonly T[],
		levels: readonly ((item: T) => string | undefined)[],
	): Line<T>[] => {
		const lines: Line<T>[] = [];
		const current: (string | undefined)[] = levels.map(() => undefined);
		items.forEach((item, index) => {
			let changed = false;
			levels.forEach((level, depth) => {
				const title = level(item);
				if (!changed && title === current[depth]) return;
				changed = true;
				current[depth] = title;
				if (title !== undefined || index > 0)
					lines.push({
						kind: "title",
						depth,
						...(title === undefined ? {} : { title }),
					});
			});
			lines.push({ kind: "item", index, item });
		});
		return lines;
	};

	/** `j`/`down` one row on, `k`/`up` one back; undefined for any other key. */
	export const moveBy = (key: BoardNav.KeyInput): 1 | -1 | undefined =>
		key.name === "j" || key.name === "down"
			? 1
			: key.name === "k" || key.name === "up"
				? -1
				: undefined;

	/** `l`/`right` the value one step on, `h`/`left` one back; undefined for any other key. */
	export const stepBy = (key: BoardNav.KeyInput): 1 | -1 | undefined =>
		key.name === "l" || key.name === "right"
			? 1
			: key.name === "h" || key.name === "left"
				? -1
				: undefined;
}
