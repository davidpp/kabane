import { describe, expect, test } from "bun:test";
import { Segments } from "./segments";

const seg = (text: string, fg = "#fff"): Segments.Segment => ({ text, fg });
const plainRows = (rows: Segments.Segment[][]): string[] =>
	rows.map(Segments.plain);

describe("Segments.wrap", () => {
	test("a line that fits is one row, unchanged", () => {
		const line = [seg(" ○ "), seg("JREP-4  "), seg("← JREP-2")];
		expect(Segments.wrap(line, 40)).toEqual([line]);
	});

	test("the overflowing part breaks at a comma and carries on under its own column", () => {
		const rows = Segments.wrap(
			[seg(" ○ JREP-4  Serve reads  "), seg("← JREP-2,JREP-3,JREP-5", "#888")],
			40,
		);
		expect(plainRows(rows)).toEqual([
			" ○ JREP-4  Serve reads  ← JREP-2,JREP-3,",
			`${" ".repeat(24)}JREP-5`,
		]);
		// Every piece keeps its part's color, padding included.
		expect(rows[1]?.map((s) => s.fg)).toEqual(["#888", "#888"]);
		// Nothing is lost: the full list is still there to read.
		expect(plainRows(rows).join("")).toContain("JREP-5");
	});

	test("padding that only spills over the edge is dropped", () => {
		expect(plainRows(Segments.wrap([seg("abc"), seg("de      ")], 6))).toEqual([
			"abcde",
		]);
	});

	test("too little room left on the row starts the part on the next one", () => {
		expect(
			plainRows(Segments.wrap([seg("a".repeat(16)), seg("bbb ccc ddd")], 20)),
		).toEqual(["a".repeat(16), "bbb ccc ddd"]);
	});

	test("a word longer than the room is cut at the room", () => {
		expect(plainRows(Segments.wrap([seg("abcdefghij")], 4))).toEqual([
			"abcd",
			"efgh",
			"ij",
		]);
	});
});

describe("Segments.flow", () => {
	const sep = seg(" · ", "#888");
	const items = [
		"1 Allow once",
		"2 Allow always",
		"3 Reject",
		"esc decline",
	].map((text) => [seg(text)]);
	const flowed = (room: number): string[] =>
		Segments.flow(items, room, sep).map((row) => Segments.plain(row.flat()));

	test("items that fit stay on one row, a separator between each", () => {
		expect(flowed(80)).toEqual([
			"1 Allow once · 2 Allow always · 3 Reject · esc decline",
		]);
	});

	test("a row breaks between two items, never through one, and drops the separator it breaks at", () => {
		expect(flowed(40)).toEqual([
			"1 Allow once · 2 Allow always · 3 Reject",
			"esc decline",
		]);
		expect(flowed(20)).toEqual([
			"1 Allow once",
			"2 Allow always",
			"3 Reject",
			"esc decline",
		]);
	});

	test("an item wider than a row has it to itself, whole, for its host to cut", () => {
		expect(flowed(10)).toEqual([
			"1 Allow once",
			"2 Allow always",
			"3 Reject",
			"esc decline",
		]);
	});

	test("the separator is the row's, ahead of every item but its first", () => {
		const rows = Segments.flow(items, 40, sep);
		expect(rows[0]?.map((item) => item[0])).toEqual([items[0]?.[0], sep, sep]);
		expect(rows[1]?.[0]).toEqual(items[3]);
	});
});

describe("Segments.fitHolding", () => {
	const name = [seg("claude-sonnet-4-20250514")];
	const age = [seg(" · "), seg("just now")];
	const at = (room: number): string =>
		Segments.plain(Segments.fitHolding(name, age, room));

	test("cuts the parts ahead of the held one, which stays whole", () => {
		expect(at(20)).toBe("claude-s… · just now");
		expect(at(20).length).toBe(20);
	});

	test("a room exactly as wide as the held part holds it whole and nothing ahead", () => {
		expect(at(11)).toBe(" · just now");
	});

	test("a room narrower than the held part cuts the held part itself", () => {
		expect(at(10)).toBe(" · just n…");
		expect(at(1)).toBe("…");
		expect(at(0)).toBe("");
	});
});
