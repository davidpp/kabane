/** @jsxImportSource @opentui/react */
// The theme against what a terminal can report: a near-black and a near-white background derive
// surfaces and grays close to DESIGN.md's ramps, an unanswered query falls back to them, the open
// screen follows a switch, and no component file carries a hex literal of its own.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type CliRenderer,
	CliRenderEvents,
	type RGBA,
	type TerminalColors,
} from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { ReactNode } from "react";
import { pumpUntil, renderTest } from "./testing";
import { Theme, ThemeProvider, useMarkdownStyle, useTheme } from "./theme";

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

	test("the same colors derive the same object, so a repeated report re-renders nothing", () => {
		const report = { foreground: "#E6EDF3", background: "#0d1117" };
		const tokens = Theme.derive(report, null);
		expect(Theme.derive({ ...report }, "light")).toBe(tokens);
		expect(Theme.derive({ ...report, background: "#0d1118" }, null)).not.toBe(
			tokens,
		);
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

describe("ink", () => {
	test("is the terminal's own magenta, yellow and cyan when it reports them", () => {
		const palette = Array<string | null>(16).fill(null);
		palette[3] = "#E5C07B";
		palette[5] = "#9d7cd8";
		palette[6] = "#56b6c2";
		const tokens = Theme.derive(
			{ foreground: "#eeeeee", background: "#0a0a0a", palette },
			null,
		);
		expect(tokens.ink).toEqual({
			heading: "#9d7cd8",
			code: "#e5c07b",
			link: "#56b6c2",
		});
	});

	test("falls back to the ramp's ink for the polarity, slot by slot", () => {
		const palette = Array<string | null>(16).fill(null);
		palette[5] = "#8839ef";
		const tokens = Theme.derive(
			{ foreground: "#1f2328", background: "#ffffff", palette },
			null,
		);
		expect(tokens.ink).toEqual({ ...Theme.LIGHT.ink, heading: "#8839ef" });
		expect(
			Theme.derive({ foreground: "#eeeeee", background: "#0a0a0a" }, null).ink,
		).toEqual(Theme.DARK.ink);
	});
});

describe("markdownStyle", () => {
	let renderer: CliRenderer;
	let other: CliRenderer;
	beforeAll(async () => {
		({ renderer } = await createTestRenderer({ width: 1, height: 1 }));
		({ renderer: other } = await createTestRenderer({ width: 1, height: 1 }));
	});
	afterAll(async () => {
		for (const r of [renderer, other]) {
			r.destroy();
			await r.closed.catch(() => {});
		}
	});

	const hexOf = (
		fg: { toInts: () => number[] } | undefined,
	): string | undefined =>
		fg &&
		`#${fg
			.toInts()
			.slice(0, 3)
			.map((c) => c.toString(16).padStart(2, "0"))
			.join("")}`;

	// OpenTUI falls back from a missing scope to its first segment only (`markup`), so a scope left
	// out is a scope drawn as plain text.
	test("names every scope OpenTUI emits: each heading level, strong, code on the overlay step", () => {
		const style = Theme.markdownStyle(renderer, Theme.DARK);
		for (const level of [1, 2, 3, 4, 5, 6]) {
			const heading = style.getStyle(`markup.heading.${level}`);
			expect({ level, fg: hexOf(heading?.fg), bold: heading?.bold }).toEqual({
				level,
				fg: Theme.DARK.ink.heading,
				bold: true,
			});
		}
		expect(style.getStyle("markup.strong")?.bold).toBe(true);
		const code = style.getStyle("markup.raw");
		expect(hexOf(code?.fg)).toBe(Theme.DARK.ink.code);
		expect(hexOf(code?.bg)).toBe(Theme.DARK.surface.overlay);
		expect(hexOf(style.getStyle("markup.link.label")?.fg)).toBe(
			Theme.DARK.ink.link,
		);
	});

	test("one style per renderer and theme, however many renders ask", () => {
		const dark = Theme.markdownStyle(renderer, Theme.DARK);
		expect(Theme.markdownStyle(renderer, Theme.DARK)).toBe(dark);
		expect(Theme.markdownStyle(renderer, Theme.LIGHT)).not.toBe(dark);
		// Another renderer's scene owns its own handle, though the tokens are the same object.
		expect(Theme.markdownStyle(other, Theme.DARK)).not.toBe(dark);
	});

	test("a theme change frees the old theme's style once the renderer is idle, and keeps the new", async () => {
		const dark = Theme.markdownStyle(renderer, Theme.DARK);
		const light = Theme.markdownStyle(renderer, Theme.LIGHT);
		const elsewhere = Theme.markdownStyle(other, Theme.DARK);
		Theme.retireMarkdownStyles(renderer, Theme.LIGHT);
		await renderer.idle();
		expect(() => dark.getStyle("markup.strong")).toThrow();
		expect(light.getStyle("markup.strong")?.bold).toBe(true);
		expect(elsewhere.getStyle("markup.strong")?.bold).toBe(true);
		expect(Theme.markdownStyle(renderer, Theme.LIGHT)).toBe(light);
		expect(Theme.markdownStyle(renderer, Theme.DARK)).not.toBe(dark);
	});
});

describe("ThemeProvider", () => {
	// What a light terminal answers: OSC 10/11 for the defaults, OSC 4 for the ANSI slots.
	const LIGHT_TERMINAL: TerminalColors = {
		palette: [
			"#000000",
			"#cc0000",
			"#00aa00",
			"#aa7700",
			"#0000cc",
			"#990099",
			"#007777",
			"#cccccc",
		],
		defaultForeground: "#24292f",
		defaultBackground: "#ffffff",
		cursorColor: null,
		mouseForeground: null,
		mouseBackground: null,
		tekForeground: null,
		tekBackground: null,
		highlightBackground: null,
		highlightForeground: null,
	};

	const hex = (rgba: RGBA): string =>
		`#${rgba
			.toInts()
			.slice(0, 3)
			.map((c) => c.toString(16).padStart(2, "0"))
			.join("")}`;

	const Probe = (): ReactNode => {
		const theme = useTheme();
		return (
			<box style={{ flexDirection: "column" }}>
				<text fg={theme.text}>{`mode ${theme.mode}`}</text>
				<markdown content="# Heading" syntaxStyle={useMarkdownStyle()} />
			</box>
		);
	};

	const mount = () =>
		renderTest(
			<ThemeProvider initial={Theme.DARK}>
				<Probe />
			</ThemeProvider>,
			{ width: 30, height: 4 },
		);

	const fgOf = (
		setup: Awaited<ReturnType<typeof mount>>,
		text: string,
	): string | undefined => {
		const span = setup
			.captureSpans()
			.lines.flatMap((line) => line.spans)
			.find((s) => s.text.includes(text));
		return span && hex(span.fg);
	};

	const headingTurns = (
		setup: Awaited<ReturnType<typeof mount>>,
		color: string,
	): Promise<string> =>
		pumpUntil(
			setup.renderOnce,
			() => fgOf(setup, "Heading") ?? "",
			(fg) => fg === color,
		);

	test("re-derives on a palette event, and the markdown follows", async () => {
		const setup = await mount();
		try {
			await pumpUntil(setup.renderOnce, setup.captureCharFrame, (f) =>
				f.includes("Heading"),
			);
			expect(fgOf(setup, "Heading")).toBe(Theme.DARK.ink.heading);

			setup.renderer.emit(CliRenderEvents.PALETTE, LIGHT_TERMINAL);
			await pumpUntil(setup.renderOnce, setup.captureCharFrame, (f) =>
				f.includes("mode light"),
			);
			const light = Theme.derive(
				{
					foreground: LIGHT_TERMINAL.defaultForeground,
					background: LIGHT_TERMINAL.defaultBackground,
					palette: LIGHT_TERMINAL.palette,
				},
				null,
			);
			expect(fgOf(setup, "mode light")).toBe(light.text);
			// The terminal's own magenta, a frame behind the text: the markdown restyles on its next draw.
			await headingTurns(setup, "#990099");
		} finally {
			setup.destroy();
		}
	});

	// A test renderer answers no palette query, which is what a terminal that reports a switch but
	// not its colors looks like.
	test("a light/dark switch from a terminal that reports no colors lands on that mode's ramp", async () => {
		const setup = await mount();
		try {
			await pumpUntil(setup.renderOnce, setup.captureCharFrame, (f) =>
				f.includes("mode dark"),
			);
			setup.renderer.emit(CliRenderEvents.THEME_MODE, "light");
			await pumpUntil(setup.renderOnce, setup.captureCharFrame, (f) =>
				f.includes("mode light"),
			);
			expect(fgOf(setup, "mode light")).toBe(Theme.LIGHT.text);
			await headingTurns(setup, Theme.LIGHT.ink.heading);
		} finally {
			setup.destroy();
		}
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
