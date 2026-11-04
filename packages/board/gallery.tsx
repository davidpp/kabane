#!/usr/bin/env bun
/** @jsxImportSource @opentui/react */
/**
 * The story gallery: every story in `src/stories` drawn through OpenTUI's test renderer, the one the
 * render tests mount into, so what David looks at and what an agent prints are the same frame.
 *
 *   bun run gallery                         a TUI: the stories on the left, the one picked on the right
 *   bun run gallery --list                  the stories' names, one per line
 *   bun run gallery --print <story> [--width N] [--height N] [--theme dark|light] [--ansi]
 *                                           the story's frame on stdout, as text or with its colors
 *
 * A story draws at its own size, or at a width preset in the TUI. The gallery paints the terminal's
 * own background and foreground for the theme picked, so the light ramp reads on a dark terminal.
 */
import { type CapturedLine, createCliRenderer, RGBA } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import { type ReactNode, useEffect, useState } from "react";
import { STORIES, type Story, storyNamed } from "./src/stories";
import { closeRenderer } from "./src/teardown";
import { renderTest } from "./src/testing";
import { Theme, ThemeProvider } from "./src/theme";

type ThemeName = "dark" | "light";
type Size = { width: number; height: number };

const THEMES: Record<ThemeName, Theme.Tokens> = {
	dark: Theme.DARK,
	light: Theme.LIGHT,
};

// What a terminal set to each ramp has under and on its cells: the ramp's text, and a background
// one step below its raised surface.
const CANVAS: Record<ThemeName, { fg: string; bg: string }> = {
	dark: { fg: Theme.DARK.text, bg: "#0d0d0d" },
	light: { fg: Theme.LIGHT.text, bg: "#ffffff" },
};

const WIDTHS: readonly number[] = [40, 80, 120];

/** One story's frame: its text, and its styled spans for the colored outputs. */
const capture = async (
	story: Story,
	size: Size,
	theme: ThemeName,
): Promise<{ text: string; lines: CapturedLine[] }> => {
	const setup = await renderTest(
		<ThemeProvider initial={THEMES[theme]}>{story.render()}</ThemeProvider>,
		size,
	);
	try {
		// testRender mounts inside act(), and leaves React warning about every update after it: the
		// effects of the first commit (a measured size) land outside one. A story is a picture, not
		// a test, so they are let commit on their own and drawn on a second pass.
		Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
		await Bun.sleep(20);
		await setup.renderOnce();
		return {
			text: setup.captureCharFrame(),
			lines: setup.captureSpans().lines,
		};
	} finally {
		setup.destroy();
	}
};

// A cell left unpainted, or drawn in the terminal's own foreground, takes the canvas's.
const resolved = (color: RGBA, fallback: string): RGBA =>
	color.intent === "default" || color.a === 0 ? RGBA.fromHex(fallback) : color;

const sgr = (attributes: number): string =>
	[
		attributes & 1 ? "1" : "",
		attributes & 2 ? "2" : "",
		attributes & 4 ? "3" : "",
		attributes & 8 ? "4" : "",
	]
		.filter(Boolean)
		.map((code) => `\x1b[${code}m`)
		.join("");

/** The frame with 24-bit color escapes, one line per row. */
const ansi = (lines: readonly CapturedLine[], theme: ThemeName): string =>
	lines
		.map((line) =>
			line.spans
				.map((span) => {
					const [fr, fg, fb] = resolved(span.fg, CANVAS[theme].fg).toInts();
					const [br, bg, bb] = resolved(span.bg, CANVAS[theme].bg).toInts();
					return `\x1b[38;2;${fr};${fg};${fb}m\x1b[48;2;${br};${bg};${bb}m${sgr(span.attributes)}${span.text}\x1b[0m`;
				})
				.join(""),
		)
		.join("\n");

// The arguments after `--print`: a story's name, then its flags.
const printArgs = (
	argv: readonly string[],
): { story: Story; size: Size; theme: ThemeName; ansi: boolean } | string => {
	const [name, ...rest] = argv;
	const story = name ? storyNamed(name) : undefined;
	if (!story)
		return `${name ? `No story "${name}"` : "--print needs a story"}; one of ${STORIES.map((s) => s.name).join(", ")}`;
	const flag = (key: string): string | undefined => {
		const at = rest.indexOf(key);
		return at === -1 ? undefined : rest[at + 1];
	};
	const number = (key: string, fallback: number): number | string => {
		const raw = flag(key);
		if (raw === undefined) return fallback;
		const value = Number(raw);
		return Number.isInteger(value) && value > 0
			? value
			: `${key} takes a whole number of cells, not "${raw}"`;
	};
	const width = number("--width", story.width);
	const height = number("--height", story.height);
	if (typeof width === "string") return width;
	if (typeof height === "string") return height;
	const theme = flag("--theme") ?? "dark";
	if (theme !== "dark" && theme !== "light")
		return `--theme is dark or light, not "${theme}"`;
	return {
		story,
		size: { width, height },
		theme,
		ansi: rest.includes("--ansi"),
	};
};

// One captured row, span for span, as the gallery's own text. The story is drawn once off screen
// and copied here, so a story that reads the terminal's size sees its preset and not the gallery.
const Row = ({
	line,
	theme,
}: {
	line: CapturedLine;
	theme: ThemeName;
}): ReactNode => (
	<text bg={CANVAS[theme].bg}>
		{line.spans.map((span, index) => (
			<span
				// Index keys: a row's spans are positional, re-captured whole on every change.
				key={index}
				fg={resolved(span.fg, CANVAS[theme].fg)}
				bg={resolved(span.bg, CANVAS[theme].bg)}
				attributes={span.attributes}
			>
				{span.text}
			</span>
		))}
	</text>
);

const Gallery = (): ReactNode => {
	const renderer = useRenderer();
	const [at, setAt] = useState(0);
	const [theme, setTheme] = useState<ThemeName>("dark");
	// Null is the story's own width; otherwise a preset.
	const [preset, setPreset] = useState<number | null>(null);
	const [lines, setLines] = useState<CapturedLine[]>([]);
	const story = STORIES[at];
	const width = preset ?? story?.width ?? 0;
	const height = story?.height ?? 0;

	useEffect(() => {
		if (!story) return;
		let live = true;
		void capture(story, { width, height }, theme).then((frame) => {
			if (live) setLines(frame.lines);
		});
		return () => {
			live = false;
		};
	}, [story, width, height, theme]);

	useKeyboard((key) => {
		if (key.name === "q" || key.name === "escape") renderer.destroy();
		if (key.name === "j" || key.name === "down")
			setAt((i) => (i + 1) % STORIES.length);
		if (key.name === "k" || key.name === "up")
			setAt((i) => (i - 1 + STORIES.length) % STORIES.length);
		if (key.name === "t") setTheme((t) => (t === "dark" ? "light" : "dark"));
		if (key.name === "w")
			// Each preset in turn, then back to the story's own width.
			setPreset((p) => WIDTHS[p === null ? 0 : WIDTHS.indexOf(p) + 1] ?? null);
	});

	const chrome = THEMES.dark;
	return (
		<box style={{ flexDirection: "row", flexGrow: 1 }}>
			<box
				style={{
					flexDirection: "column",
					width: 30,
					flexShrink: 0,
					paddingLeft: 1,
					paddingRight: 1,
					backgroundColor: chrome.surface.raised,
				}}
			>
				<text fg={chrome.text} bg={chrome.surface.raised}>
					stories
				</text>
				<text> </text>
				{STORIES.map((s, index) => (
					<text
						key={s.name}
						fg={index === at ? chrome.text : chrome.muted}
						bg={index === at ? chrome.surface.selected : chrome.surface.raised}
					>
						{`${index === at ? "› " : "  "}${s.name}`.padEnd(28)}
					</text>
				))}
				<box style={{ flexGrow: 1 }} />
				<text fg={chrome.muted} bg={chrome.surface.raised}>
					<span fg={chrome.text}>j/k</span> story ·{" "}
					<span fg={chrome.text}>t</span> theme
				</text>
				<text fg={chrome.muted} bg={chrome.surface.raised}>
					<span fg={chrome.text}>w</span> width ·{" "}
					<span fg={chrome.text}>q</span> quit
				</text>
			</box>
			<box style={{ flexDirection: "column", flexGrow: 1, paddingLeft: 1 }}>
				<text fg={chrome.muted}>
					<span fg={chrome.text}>{story?.name ?? ""}</span>
					{` · ${width}×${height} · ${theme}${preset === null ? "" : " · preset"}`}
				</text>
				<text fg={chrome.muted}>{story?.about ?? ""}</text>
				<text> </text>
				{lines.map((line, index) => (
					// Index keys: row N of the frame is its only identity.
					<Row key={index} line={line} theme={theme} />
				))}
			</box>
		</box>
	);
};

const args = process.argv.slice(2);
if (args.includes("--list")) {
	for (const story of STORIES)
		console.log(
			`${story.name.padEnd(26)} ${`${story.width}×${story.height}`.padEnd(7)} ${story.about}`,
		);
	process.exit(0);
}
const printAt = args.indexOf("--print");
if (printAt !== -1) {
	const parsed = printArgs(args.slice(printAt + 1));
	if (typeof parsed === "string") {
		console.error(`gallery: ${parsed}`);
		process.exit(1);
	}
	const frame = await capture(parsed.story, parsed.size, parsed.theme);
	console.log(
		parsed.ansi ? ansi(frame.lines, parsed.theme) : frame.text.trimEnd(),
	);
	// The test renderer kept alive for the tree-sitter client would hold the process open.
	process.exit(0);
}
if (!process.stdout.isTTY) {
	console.error(
		"gallery: the TUI needs a terminal; use --list or --print <story> here",
	);
	process.exit(1);
}
const renderer = await createCliRenderer({ exitOnCtrlC: true });
createRoot(renderer).render(<Gallery />);
await new Promise<void>((resolve) => renderer.on("destroy", resolve));
await closeRenderer(renderer);
process.exit(0);
