// The theme against what a terminal can report: a near-black and a near-white background derive
// surfaces and grays close to DESIGN.md's ramps, an unanswered query falls back to them, and no
// component file carries a hex literal of its own.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Theme } from "./theme";

const channels = (hex: string): number[] =>
	[1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

// Every channel within `tolerance` of the reference: "lands on" the ramp, not bit for bit.
const closeTo = (actual: string, expected: string, tolerance = 6): boolean =>
	channels(actual).every(
		(c, i) => Math.abs(c - (channels(expected)[i] ?? 0)) <= tolerance,
	);

const lighter = (a: string, b: string): boolean =>
	channels(a).reduce((s, c) => s + c, 0) >
	channels(b).reduce((s, c) => s + c, 0);

// A derived gray takes the terminal's tint where the ramp's grays lean blue, so grays are compared by
// how light they read, not channel by channel.
const luma = (hex: string): number => {
	const [r = 0, g = 0, b = 0] = channels(hex);
	return 0.299 * r + 0.587 * g + 0.114 * b;
};
const readsAs = (actual: string, expected: string): boolean =>
	Math.abs(luma(actual) - luma(expected)) <= 8;

const GRAYS = ["secondary", "muted", "faint"] as const;

describe("derive", () => {
	test("a near-black terminal lands on the dark ramp's surfaces and grays", () => {
		const tokens = Theme.derive(
			{ foreground: "#e6edf3", background: "#0a0a0a" },
			null,
		);
		expect(tokens.mode).toBe("dark");
		expect(tokens.text).toBe("#e6edf3");
		for (const key of ["raised", "overlay", "selected"] as const)
			expect({
				key,
				close: closeTo(tokens.surface[key], Theme.DARK.surface[key]),
			}).toEqual({ key, close: true });
		for (const key of GRAYS)
			expect({ key, reads: readsAs(tokens[key], Theme.DARK[key]) }).toEqual({
				key,
				reads: true,
			});
	});

	test("a near-white terminal lands on the light ramp, with the grays running the other way", () => {
		const tokens = Theme.derive(
			{ foreground: "#1f2328", background: "#ffffff" },
			"dark",
		);
		// The reported background wins over a mode that says otherwise.
		expect(tokens.mode).toBe("light");
		for (const key of ["raised", "overlay", "selected"] as const)
			expect({
				key,
				close: closeTo(tokens.surface[key], Theme.LIGHT.surface[key]),
			}).toEqual({ key, close: true });
		for (const key of GRAYS)
			expect({ key, reads: readsAs(tokens[key], Theme.LIGHT[key]) }).toEqual({
				key,
				reads: true,
			});
		expect(lighter(tokens.faint, tokens.muted)).toBe(true);
		expect(lighter(tokens.muted, tokens.secondary)).toBe(true);
	});

	test("surfaces step away from the background in order, and take its tint", () => {
		const bg = "#1e2030";
		const tokens = Theme.derive(
			{ foreground: "#c8d3f5", background: bg },
			null,
		);
		expect(lighter(tokens.surface.raised, bg)).toBe(true);
		expect(lighter(tokens.surface.overlay, tokens.surface.raised)).toBe(true);
		expect(lighter(tokens.surface.selected, tokens.surface.overlay)).toBe(true);
		const [r, , b] = channels(tokens.surface.raised);
		expect((b ?? 0) > (r ?? 0)).toBe(true);
	});

	test("the hues never move: they carry meaning, not the terminal's tint", () => {
		const tokens = Theme.derive(
			{ foreground: "#c8d3f5", background: "#1e2030" },
			null,
		);
		expect([tokens.accent, tokens.working, tokens.done, tokens.failed]).toEqual(
			[
				Theme.DARK.accent,
				Theme.DARK.working,
				Theme.DARK.done,
				Theme.DARK.failed,
			],
		);
	});

	test("with no answer it falls back to the ramp for the mode, and to dark when that is unknown too", () => {
		expect(Theme.derive(null, "light")).toBe(Theme.LIGHT);
		expect(Theme.derive(null, "dark")).toBe(Theme.DARK);
		expect(Theme.derive(null, null)).toBe(Theme.DARK);
		expect(
			Theme.derive({ foreground: "#ffffff", background: null }, "light"),
		).toBe(Theme.LIGHT);
		expect(
			Theme.derive({ foreground: null, background: "not a color" }, null),
		).toBe(Theme.DARK);
	});

	test("a background with no foreground takes the ramp's text for its polarity", () => {
		const tokens = Theme.derive(
			{ foreground: null, background: "#fafafa" },
			null,
		);
		expect(tokens.mode).toBe("light");
		expect(tokens.text).toBe(Theme.LIGHT.text);
	});
});

describe("markdownStyle", () => {
	test("one style per theme, however many renders ask", () => {
		expect(Theme.markdownStyle(Theme.DARK)).toBe(
			Theme.markdownStyle(Theme.DARK),
		);
		expect(Theme.markdownStyle(Theme.LIGHT)).not.toBe(
			Theme.markdownStyle(Theme.DARK),
		);
	});
});

// A color in a component file is a color the theme cannot reach: it would stay dark on a light
// terminal, and it would not follow herdr's pane.
test("no board source file outside theme.ts carries a hex color literal", () => {
	const dir = import.meta.dir;
	const offenders = readdirSync(dir)
		.filter(
			(name) =>
				/\.tsx?$/.test(name) && !name.includes(".test.") && name !== "theme.ts",
		)
		.flatMap((name) =>
			readFileSync(join(dir, name), "utf8")
				.split("\n")
				.map((line, index) => ({ name, line: index + 1, text: line }))
				.filter(({ text }) => /["'`]#[0-9a-f]{6}\b/i.test(text)),
		)
		.map(({ name, line }) => `${name}:${line}`);
	expect(offenders).toEqual([]);
});
