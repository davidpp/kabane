// The board's colors, in one place. DESIGN.md names the roles; this module gives them values. The
// hues are fixed, because they carry meaning (a request, work in flight, done, failed). The neutrals
// and the painted surfaces derive from the terminal's own foreground and background when the
// terminal reports them, so the board sits on herdr's pane, or on any theme, with no tint of its
// own. When the terminal says nothing, DESIGN.md's fixed dark or light ramp stands in.
import {
	type CliRenderer,
	RGBA,
	SyntaxStyle,
	type TerminalColors,
	type ThemeMode,
} from "@opentui/core";
import { createContext, useContext } from "react";

export namespace Theme {
	export type Tokens = {
		mode: ThemeMode;
		/** A human is needed: review, a question, the marked set, a cursor waiting on you. */
		accent: string;
		/** Work in flight. */
		working: string;
		done: string;
		failed: string;
		/**
		 * The terminal's own foreground, written as SGR 39, for text that carries no meaning of its own
		 * on the unpainted background. Not the same as leaving `fg` unset: OpenTUI draws an unset
		 * foreground as explicit white, which vanishes on a light terminal.
		 */
		defaultFg: RGBA;
		/** The explicit foreground for a cell on a painted surface (the Selection Rule's fg). */
		text: string;
		/** One step down from the foreground: a normal-priority id. */
		secondary: string;
		/** Chrome: meta, counts, hints. */
		muted: string;
		/** What cannot be acted on right now. */
		faint: string;
		/** Painted steps above the terminal's own, unpainted background. */
		surface: { raised: string; overlay: string; selected: string };
		/**
		 * The structure of what an author wrote, inside rendered markdown and never in chrome: a
		 * heading, code, a link. The terminal's own ANSI colors when it reports them, so a brief reads
		 * like every other tool in that terminal.
		 */
		ink: { heading: string; code: string; link: string };
	};

	/** What the terminal reported, as OpenTUI hands it over: `#rrggbb` or nothing. */
	type Reported = {
		foreground: string | null;
		background: string | null;
		palette?: readonly (string | null)[];
	};

	const HUES = {
		accent: "#f97316",
		working: "#58a6ff",
		done: "#22c55e",
		failed: "#ef4444",
	} as const;

	const DEFAULT_FG = RGBA.defaultForeground();

	/** DESIGN.md's dark ramp: the board as it has always looked on a near-black terminal. */
	export const DARK: Tokens = {
		mode: "dark",
		...HUES,
		defaultFg: DEFAULT_FG,
		text: "#e6edf3",
		secondary: "#9ca3af",
		muted: "#6b7280",
		faint: "#4b5563",
		surface: { raised: "#1c1c1c", overlay: "#262626", selected: "#2f2f2f" },
		ink: { heading: "#c4a7e7", code: "#e5c07b", link: "#56b6c2" },
	};

	/** DESIGN.md's light ramp. The grays run the other way: faint is the lightest, not the darkest. */
	export const LIGHT: Tokens = {
		mode: "light",
		...HUES,
		defaultFg: DEFAULT_FG,
		text: "#1f2328",
		secondary: "#57606a",
		muted: "#6e7781",
		faint: "#8c959f",
		surface: { raised: "#f0f0f0", overlay: "#e8e8e8", selected: "#dddddd" },
		ink: { heading: "#6f42c1", code: "#8a5a00", link: "#006d77" },
	};

	// The ANSI slots the ink reads: magenta, yellow, cyan. Never blue, green or red, the terminal's
	// cousins of the working, done and failed hues.
	const INK_SLOTS = { heading: 5, code: 3, link: 6 } as const;

	// How far each surface steps from the background toward the foreground. Chosen so a near-black
	// terminal lands on the dark ramp's surfaces and a near-white one on the light ramp's.
	const SURFACE_STEPS = {
		raised: 0.08,
		overlay: 0.12,
		selected: 0.17,
	} as const;

	// How far each neutral steps from the foreground toward the background. A plain RGB mix is not
	// perceptually even, so the steps differ by polarity: the same fraction reads fainter on white.
	// Chosen so the dark steps land on the lightness of DARK's grays and the light ones on LIGHT's;
	// the hue is the terminal's own, where the ramps' grays lean blue.
	const TEXT_STEPS: Record<
		ThemeMode,
		{ secondary: number; muted: number; faint: number }
	> = {
		dark: { secondary: 0.34, muted: 0.55, faint: 0.69 },
		light: { secondary: 0.25, muted: 0.38, faint: 0.52 },
	};

	type Rgb = readonly [number, number, number];

	const parseHex = (hex: string | null): Rgb | null => {
		const match = hex
			? /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
			: null;
		if (!match) return null;
		const [, r = "", g = "", b = ""] = match;
		return [
			Number.parseInt(r, 16),
			Number.parseInt(g, 16),
			Number.parseInt(b, 16),
		];
	};

	const toHex = (rgb: Rgb): string =>
		`#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;

	const mix = (from: Rgb, to: Rgb, t: number): Rgb => [
		Math.round(from[0] + (to[0] - from[0]) * t),
		Math.round(from[1] + (to[1] - from[1]) * t),
		Math.round(from[2] + (to[2] - from[2]) * t),
	];

	// The background decides the polarity: the terminal's own answer is the ground truth, and it
	// saves a second query.
	const polarity = ([r, g, b]: Rgb): ThemeMode =>
		0.299 * r + 0.587 * g + 0.114 * b < 128 ? "dark" : "light";

	const ramp = (mode: ThemeMode | null): Tokens =>
		mode === "light" ? LIGHT : DARK;

	const inkOf = (
		palette: Reported["palette"],
		fallback: Tokens["ink"],
	): Tokens["ink"] => {
		const slot = (index: number): string | null => {
			const rgb = parseHex(palette?.[index] ?? null);
			return rgb && toHex(rgb);
		};
		return {
			heading: slot(INK_SLOTS.heading) ?? fallback.heading,
			code: slot(INK_SLOTS.code) ?? fallback.code,
			link: slot(INK_SLOTS.link) ?? fallback.link,
		};
	};

	/**
	 * The tokens for what the terminal reported. With a background, surfaces and neutrals derive from
	 * it (and from the reported foreground, else the ramp's text for that polarity), and the ink is
	 * the terminal's own ANSI slot where it named one. Without a background there is nothing to derive
	 * from: the fixed ramp for `mode`, and the dark ramp when that is unknown too.
	 */
	export const derive = (
		reported: Reported | null,
		mode: ThemeMode | null,
	): Tokens => {
		const bg = parseHex(reported?.background ?? null);
		if (!bg) return ramp(mode);
		const detected = polarity(bg);
		const fg =
			parseHex(reported?.foreground ?? null) ??
			parseHex(ramp(detected).text) ??
			bg;
		const steps = TEXT_STEPS[detected];
		return {
			mode: detected,
			...HUES,
			defaultFg: DEFAULT_FG,
			text: toHex(fg),
			secondary: toHex(mix(fg, bg, steps.secondary)),
			muted: toHex(mix(fg, bg, steps.muted)),
			faint: toHex(mix(fg, bg, steps.faint)),
			surface: {
				raised: toHex(mix(bg, fg, SURFACE_STEPS.raised)),
				overlay: toHex(mix(bg, fg, SURFACE_STEPS.overlay)),
				selected: toHex(mix(bg, fg, SURFACE_STEPS.selected)),
			},
			ink: inkOf(reported?.palette, ramp(detected).ink),
		};
	};

	// Long enough for a terminal that answers, short enough that one which never answers costs a
	// blink before the first frame.
	const PALETTE_TIMEOUT_MS = 300;

	/**
	 * Ask the terminal for its colors once, before the first render. A terminal (or a multiplexer)
	 * that does not answer is not an error: it gets a fixed ramp.
	 */
	export const detect = async (renderer: CliRenderer): Promise<Tokens> => {
		const colors: TerminalColors | null = await renderer
			.getPalette({ timeout: PALETTE_TIMEOUT_MS })
			.then(
				(result) => result,
				() => null,
			);
		return derive(
			colors && {
				foreground: colors.defaultForeground,
				background: colors.defaultBackground,
				palette: colors.palette,
			},
			renderer.themeMode,
		);
	};

	// SyntaxStyle allocates a native FFI handle: one per theme for the process, never one per render.
	const markdownStyles = new WeakMap<Tokens, SyntaxStyle>();

	/**
	 * The markdown styles for a brief or a comment. Prose stays on the terminal's own foreground; the
	 * author's structure takes the ink (a heading, inline code on the overlay step, a link's label),
	 * and markdown's own punctuation (bullets, a link's URL, a table's pipes) is chrome. Every scope
	 * OpenTUI emits is named: a missing one falls back to its first segment, `markup`, which has no
	 * style, so `markup.heading.3` would read as plain text.
	 */
	export const markdownStyle = (tokens: Tokens): SyntaxStyle => {
		const cached = markdownStyles.get(tokens);
		if (cached) return cached;
		const heading = { fg: tokens.ink.heading, bold: true };
		const style = SyntaxStyle.fromStyles({
			default: { fg: tokens.defaultFg },
			"markup.heading.1": { ...heading, underline: true },
			"markup.heading.2": heading,
			"markup.heading.3": heading,
			"markup.heading.4": heading,
			"markup.heading.5": heading,
			"markup.heading.6": heading,
			// A table's header row: data, not a section, so Label weight and no ink.
			"markup.heading": { bold: true },
			"markup.strong": { bold: true },
			"markup.italic": { italic: true },
			"markup.strikethrough": { fg: tokens.muted },
			"markup.raw": { fg: tokens.ink.code, bg: tokens.surface.overlay },
			"markup.link": { fg: tokens.muted },
			"markup.link.label": { fg: tokens.ink.link, underline: true },
			"markup.link.url": { fg: tokens.muted, underline: true },
			"markup.list": { fg: tokens.muted },
			"markup.list.checked": { fg: tokens.done },
			"markup.list.unchecked": { fg: tokens.muted },
			"markup.quote": { fg: tokens.secondary, italic: true },
			"punctuation.special": { fg: tokens.faint },
			// What OpenTUI draws a table's lines in, when a table keeps any.
			conceal: { fg: tokens.faint },
		});
		markdownStyles.set(tokens, style);
		return style;
	};
}

// Render-only tests mount without a provider and get the dark ramp: the board as it always looked.
const ThemeContext = createContext<Theme.Tokens>(Theme.DARK);

export const ThemeProvider = ThemeContext.Provider;

export const useTheme = (): Theme.Tokens => useContext(ThemeContext);
