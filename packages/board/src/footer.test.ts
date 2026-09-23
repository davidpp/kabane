import { describe, expect, test } from "bun:test";
import { barSegments, copilotIndicatorFg, hintSegments } from "./footer";
import { Segments } from "./segments";
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

describe("barSegments", () => {
	const hints = [
		{ key: "d", label: "done" },
		{ key: "v", label: "review" },
		{ key: "?", label: "help" },
	];
	const line = (width: number, lead?: string): string =>
		Segments.plain(barSegments({ hints, lead }, width, T));

	test("leaves hints that fit as they are", () => {
		expect(line(40)).toBe("d done · v review · ? help");
	});

	test("drops whole hints from the end, keeps `? help`, and never cuts one mid-word", () => {
		expect(line(20)).toBe("d done · ? help");
		expect(line(8)).toBe("? help");
		expect(line(5)).toBe("");
	});

	test("a lead keeps its words and the hints fit in what it leaves", () => {
		expect(line(40, "/auth▌")).toBe("/auth▌  d done · v review · ? help");
		expect(line(22, "/auth▌")).toBe("/auth▌  ? help");
	});

	test("a notice with no hints is cut at the end with an ellipsis, colors kept", () => {
		const fitted = barSegments({ text: "a long notice", fg: T.done }, 8, T);
		expect(Segments.plain(fitted)).toBe("a long …");
		expect(fitted.at(-1)?.fg).toBe(T.done);
	});
});
