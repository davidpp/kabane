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
