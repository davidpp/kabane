import { describe, expect, it } from "bun:test";
import { planGlyph } from "./plan-block";
import { Theme } from "./theme";

const T = Theme.DARK;

describe("planGlyph", () => {
	it("the glyph is the status, and the hue says what it means: in flight, done, still to come", () => {
		expect(planGlyph("in_progress", "⠹", T)).toEqual({
			glyph: "⠹",
			color: T.working,
		});
		expect(planGlyph("completed", "⠹", T)).toEqual({
			glyph: "✓",
			color: T.done,
		});
		expect(planGlyph("pending", "⠹", T)).toEqual({
			glyph: "○",
			color: T.muted,
		});
	});
});
