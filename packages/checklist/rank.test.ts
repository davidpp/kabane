import { expect, it } from "bun:test";
import { place, type Ranked } from "./rank";

/** Insert `count` entries at `index`, applying the re-ranks, and return the list sorted as SQL sorts it. */
const insert = (list: Ranked[], index: number, ids: string[]): Ranked[] => {
	const { placed, moved } = place(list, index, ids);
	const ranks = new Map(moved.map((entry) => [entry.id, entry.rank]));
	return [
		...list.map((entry) => ({
			id: entry.id,
			rank: ranks.get(entry.id) ?? entry.rank,
		})),
		...placed.map(({ entry, rank }) => ({ id: entry, rank })),
	].sort((a, b) =>
		a.rank === b.rank ? (a.id < b.id ? -1 : 1) : a.rank < b.rank ? -1 : 1,
	);
};

it("keeps every insert where it was asked, in byte order, with keys that never end in 0", () => {
	let list: Ranked[] = [];
	const expected: string[] = [];
	let seed = 7;
	for (let n = 0; n < 400; n++) {
		seed = (seed * 48271) % 2147483647;
		const index = seed % (list.length + 1);
		const id = `item-${String(n).padStart(3, "0")}`;
		list = insert(list, index, [id]);
		expected.splice(index, 0, id);
		expect(list.map((entry) => entry.id)).toEqual(expected);
	}
	for (const { rank } of list) expect(rank).toMatch(/^[0-9a-z]*[1-9a-z]$/);
	const ranks = list.map((entry) => entry.rank);
	expect(new Set(ranks).size).toBe(ranks.length);
});

it("grows a key by one character every 35 appends, and places a batch in order", () => {
	let list: Ranked[] = [];
	for (let n = 0; n < 100; n++)
		list = insert(list, list.length, [`a${String(n).padStart(3, "0")}`]);
	expect(Math.max(...list.map((entry) => entry.rank.length))).toBe(4);
	const batch = insert(list, 3, ["x1", "x2", "x3"]);
	expect(batch.slice(2, 7).map((entry) => entry.id)).toEqual([
		"a002",
		"x1",
		"x2",
		"x3",
		"a003",
	]);
});

it("re-ranks a tie sync left behind, so an insert between the tied pair lands between them", () => {
	const tied: Ranked[] = [
		{ id: "a", rank: "i" },
		{ id: "b", rank: "i" },
		{ id: "c", rank: "i" },
		{ id: "d", rank: "r" },
	];
	const { placed, moved } = place(tied, 1, ["new"]);
	expect(moved.map((entry) => entry.id)).toEqual(["b", "c"]);
	const order = insert(tied, 1, ["new"]).map((entry) => entry.id);
	expect(order).toEqual(["a", "new", "b", "c", "d"]);
	const [first] = placed;
	expect(first && first.rank > "i" && first.rank < "r").toBe(true);
	expect(place(tied, 4, ["end"]).moved).toEqual([]);
});
