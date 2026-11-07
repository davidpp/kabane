/**
 * Fractional ranks: an item's place in its list is a string key, ordered
 * bytewise, so moving or inserting one item writes that item alone.
 *
 * Keys are base-36 digits (`0-9a-z`, whose ASCII order is their numeric
 * order) and never end in `0`, so a key always exists between any two. Two
 * devices that insert at the same spot concurrently can produce one key twice;
 * the list breaks that tie by id, and the next insert between the tied pair
 * re-ranks the run it lands in (`place`).
 */

const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";

const digit = (key: string): number =>
	key === "" ? 0 : DIGITS.indexOf(key.charAt(0));

/** A key strictly between `low` ("" for none) and `high` (undefined for none). */
const midpoint = (low: string, high: string | undefined): string => {
	if (high !== undefined) {
		let shared = 0;
		while ((low.charAt(shared) || "0") === high.charAt(shared)) shared++;
		if (shared > 0)
			return (
				high.slice(0, shared) + midpoint(low.slice(shared), high.slice(shared))
			);
	}
	const from = digit(low);
	const to = high === undefined ? DIGITS.length : digit(high);
	if (to - from > 1) return DIGITS.charAt(Math.round((from + to) / 2));
	if (high !== undefined && high.length > 1) return high.charAt(0);
	return DIGITS.charAt(from) + midpoint(low.slice(1), undefined);
};

/** A key above `low`: its first digit plus one, so appending grows keys by a character every 35 items. */
const after = (low: string): string => {
	const head = digit(low);
	return head < DIGITS.length - 1
		? DIGITS.charAt(head + 1)
		: `z${after(low.slice(1))}`;
};

export type Ranked = { id: string; rank: string };

/**
 * A rank for each of `entries`, inserted in order before `ordered[index]` (at
 * the end when `index` is its length), and the tied neighbours that must take
 * a new rank to make room. `ordered` is sorted by rank, then id.
 */
export const place = <T>(
	ordered: readonly Ranked[],
	index: number,
	entries: readonly T[],
): { placed: { entry: T; rank: string }[]; moved: Ranked[] } => {
	const low = ordered[index - 1]?.rank ?? "";
	let end = index;
	while (low !== "" && ordered[end]?.rank === low) end++;
	const high = ordered[end]?.rank;
	let previous = low;
	const next = (): string => {
		previous =
			high === undefined && previous !== ""
				? after(previous)
				: midpoint(previous, high);
		return previous;
	};
	const placed = entries.map((entry) => ({ entry, rank: next() }));
	const moved = ordered
		.slice(index, end)
		.map((entry) => ({ id: entry.id, rank: next() }));
	return { placed, moved };
};
