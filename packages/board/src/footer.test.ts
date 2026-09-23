import { describe, expect, test } from "bun:test";
import { copilotIndicatorFg, fitSegments, hintSegments } from "./footer";
import { Theme } from "./theme";

const T = Theme.DARK;

describe("copilotIndicatorFg", () => {
	test("working while a turn runs, done when it lands, failed on error; never the accent", () => {
		expect(copilotIndicatorFg("running", T)).toBe(T.working);
		expect(copilotIndicatorFg("done", T)).toBe(T.done);
		expect(copilotIndicatorFg("error", T)).toBe(T.failed);
	});
});

describe("hintSegments", () => {
	test("each key in the bar's foreground, its label and the separators muted", () => {
		expect(
			hintSegments(
				[
					{ key: "d", label: "done" },
					{ key: "?", label: "help" },
				],
				T,
			),
		).toEqual([
			{ text: "d", fg: T.text },
			{ text: " done", fg: T.muted },
			{ text: " · ", fg: T.muted },
			{ text: "?", fg: T.text },
			{ text: " help", fg: T.muted },
		]);
	});
});

describe("fitSegments", () => {
	const segments = hintSegments(
		[
			{ key: "d", label: "done" },
			{ key: "v", label: "review" },
		],
		T,
	);

	test("leaves a line that fits as it is", () => {
		expect(fitSegments(segments, 40)).toEqual(segments);
	});

	test("cuts a line that does not fit to the width, ending in an ellipsis, colors kept", () => {
		const fitted = fitSegments(segments, 12);
		const text = fitted.map((segment) => segment.text).join("");
		expect(text).toBe("d done · v …");
		expect(text.length).toBe(12);
		expect(fitted.at(-1)?.fg).toBe(T.muted);
	});
});
