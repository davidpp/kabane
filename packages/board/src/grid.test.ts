import { describe, expect, test } from "bun:test";
import { Grid } from "./grid";

describe("Grid.sections", () => {
	test("titles a section where it starts, and an ungrouped item after a group gets an untitled break", () => {
		const items = [{ g: undefined }, { g: "A" }, { g: "A" }, { g: undefined }];
		expect(
			Grid.sections(items, [(item) => item.g]).map((l) =>
				l.kind === "title" ? `#${l.title ?? ""}` : l.index,
			),
		).toEqual([0, "#A", 1, 2, "#", 3]);
	});

	test("an outer section changing titles the inner one again, even under the same name", () => {
		const rows = [
			{ ns: "cli", group: "Other" },
			{ ns: "loop", group: "Other" },
			{ ns: "loop", group: "Checks" },
		];
		expect(
			Grid.sections(rows, [(r) => r.ns, (r) => r.group]).map((l) =>
				l.kind === "title" ? `${l.depth}:${l.title}` : l.index,
			),
		).toEqual(["0:cli", "1:Other", 0, "0:loop", "1:Other", 1, "1:Checks", 2]);
	});
});

test("Grid.label cuts a label that fills its column and keeps a space after it", () => {
	expect(Grid.label("stall", 8)).toBe("stall   ");
	expect(Grid.label("concurrent", 8)).toBe("concur… ");
});
