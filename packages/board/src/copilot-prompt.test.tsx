/** @jsxImportSource @opentui/react */
// The `A` flow end to end against a scripted copilot: the window and its chip, the running
// indicator while the board stays interactive, the copilot card in the sidebar, the live transcript
// in the event view with `x stop the turn`, the `✓` flash on completion, and the keypress that dismisses it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner } from "@cabane/core";
import {
	type CapturedSpan,
	RGBA,
	type TextareaRenderable,
} from "@opentui/core";
import { createRef } from "react";
import { App } from "./app";
import type { BoardContext } from "./context";
import {
	CopilotPane,
	collapsedSegments,
	contextChip,
	harnessOf,
	paletteNameCols,
	titleSegments,
} from "./copilot-prompt";
import type { BoardNav } from "./nav";
import type { Copilot, CopilotStep, CopilotUpdate } from "./ports";
import { noActivity } from "./ports";
import { Segments } from "./segments";
import { dropDb, freshDb } from "./test-db";
import { pumpUntil, renderTest } from "./testing";
import { Theme } from "./theme";

const TEST_BASE = join(tmpdir(), `cabane-board-copilot-${crypto.randomUUID()}`);
const PERMISSION_BASE = join(
	tmpdir(),
	`cabane-board-permission-${crypto.randomUUID()}`,
);

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

// The open panel's title row, inside its one cell of padding. The panel has no frame to wait on any
// more, and the collapsed row and the footer both start at column 0, so this is the panel alone.
const panelOpen = (frame: string): boolean =>
	frame.split("\n").some((row) => row.startsWith(" copilot · "));

const ctx = (
	over: Partial<BoardContext.Context> = {},
): BoardContext.Context => ({
	view: "board",
	filter: { kind: "all", status: "open" },
	marked: [],
	briefs: [],
	truncated: false,
	...over,
});

describe("contextChip", () => {
	it("names the selection, the working set and the section, in that order", () => {
		expect(
			contextChip(
				ctx({
					selected: { id: "e", shortId: "JCAB-31", title: "Board copilot" },
					marked: [
						{ id: "a", shortId: "JCAB-34", title: "a" },
						{ id: "b", shortId: "JCAB-35", title: "b" },
						{ id: "c", shortId: "JCAB-36", title: "c" },
					],
					section: "inbox",
				}),
			),
		).toBe("JCAB-31 · 3 marked · inbox");
		expect(contextChip(ctx({ section: "next" }))).toBe("next");
		expect(contextChip(ctx())).toBe("no selection");
	});
});

// A copilot whose turn pauses at `gate` so the running state can be observed, then finishes.
type Seen = {
	prompts: string[];
	contexts: BoardContext.Context[];
	cancels: number;
};

const scriptedCopilot = (gate: Promise<void>, seen: Seen): Copilot => ({
	run: async function* (prompt, context) {
		seen.prompts.push(prompt);
		seen.contexts.push(context);
		const at = (): string => new Date().toISOString();
		const step = (type: CopilotStep, summary: string): CopilotUpdate => ({
			type,
			summary,
			at: at(),
		});
		yield step("thought", "reading the selection");
		yield step("tool_call", "cabane_edit");
		await gate;
		yield step("tool_result", "ok");
		yield step("text", "Moved it to someday.\nNothing else changed.");
		yield step("done", "");
	},
	cancel: async () => {
		seen.cancels++;
	},
	shortcuts: () => [
		{
			name: "triage",
			hint: "keep, someday or next",
			template: "Triage every issue in view.",
		},
	],
	answerPermission: () => {},
});

// A copilot whose turn stops on a question and waits — the board has to put it on screen and
// answer it for anything more to happen, which is the point of the channel.
const askingCopilot = (answers: (string | null)[]): Copilot => {
	let respond: ((optionId: string | null) => void) | null = null;
	return {
		run: async function* () {
			const at = (): string => new Date().toISOString();
			yield {
				type: "permission",
				request: {
					id: "t0",
					title: "cabane_edit",
					options: [
						{ id: "allow", label: "Allow" },
						{ id: "reject", label: "Reject" },
					],
				},
				at: at(),
			};
			const answer = await new Promise<string | null>((resolve) => {
				respond = resolve;
			});
			answers.push(answer);
			yield {
				type: "text",
				summary: answer === null ? "Left it alone." : `Ran it with ${answer}.`,
				at: at(),
			};
			yield { type: "done", summary: "", at: at() };
		},
		cancel: async () => {},
		shortcuts: () => [],
		answerPermission: (_id, optionId) => respond?.(optionId),
	};
};

describe("the A prompt against a scripted copilot", () => {
	beforeAll(async () => {
		await freshDb(TEST_BASE);
		const added = await Planner.addTask(TEST_BASE, {
			title: "Wire the copilot",
			kind: "issue",
			state: "next",
		});
		if (!added.ok) throw added.error;
	});

	afterAll(() => {
		dropDb(TEST_BASE);
	});

	it("runs a turn in the background, shows it in the footer, sidebar and event view, then flashes ✓ until a keypress", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const seen: Seen = { prompts: [], contexts: [], cancels: 0 };
		const setup = await renderTest(
			<App
				cwd={TEST_BASE}
				basePath={TEST_BASE}
				activity={noActivity}
				copilot={scriptedCopilot(gate, seen)}
			/>,
			{ width: 120, height: 24 },
		);
		const { renderOnce, captureCharFrame, mockInput, destroy } = setup;
		const until = (p: (f: string) => boolean) =>
			pumpUntil(renderOnce, captureCharFrame, p);
		// The panel's own title row — the collapsed row also carries a `▸`, so waiting on that races
		// focus and sends the next keystrokes to the board instead of the input.
		const untilPanel = () => until(panelOpen);
		// A lone escape followed by another byte in the same tick reads as Alt+key to a terminal
		// parser, so every escape here is rendered through before the next key is sent.
		const pressEsc = async (): Promise<void> => {
			mockInput.pressEscape();
			await renderOnce();
			await sleep(30);
		};
		try {
			// The pane names its own key; the footer hints no longer repeat it.
			expect(await until((f) => f.includes("Wire the copilot"))).toContain(
				"tab to ask the copilot",
			);

			// `A`: the pane opens into the panel — a raised panel with no frame, titled with the chip,
			// and a real input several rows tall with a placeholder.
			mockInput.pressKey("A");
			let frame = await untilPanel();
			expect(frame).toContain("copilot · JALL-1 · next");
			expect(frame).not.toMatch(/[┌┐└┘│─]/);
			expect(frame).toContain("ask about the selection · / for shortcuts");

			// A half-written prompt survives leaving the pane and coming back — the point of making the
			// copilot focusable rather than modal. The textarea unmounts with the panel, so the
			// mirrored text is what seeds the new one.
			await mockInput.typeText("/tr");
			await until((f) => f.includes("/tr"));
			await pressEsc();
			await until((f) => !panelOpen(f));
			mockInput.pressKey("A");
			frame = await untilPanel();
			expect(frame).toContain("/tr");

			// `/` shows the shortcut; tab expands it in place so the text is read before it is sent.
			// The palette is a two-column list now — the name padded, then the hint.
			frame = await until((f) => /\/triage\s+keep, someday or next/.test(f));
			mockInput.pressTab();
			// The textarea takes the expansion imperatively, so its content lands a frame before the
			// mirrored state that the palette is drawn from — wait for both to settle.
			frame = await until(
				(f) =>
					f.includes("Triage every issue in view.") &&
					!f.includes("keep, someday or next"),
			);
			expect(frame).toContain("Triage every issue in view.");

			// Enter sends it; the window closes, the footer spins on the last tool, the sidebar lists
			// the copilot card, and the board still answers keys (`?` opens help, esc closes it).
			mockInput.pressEnter();
			frame = await until((f) => f.includes("copilot · cabane_edit"));
			// The panel collapses back to its one row; the board has the keyboard again.
			expect(panelOpen(frame)).toBe(false);
			expect(frame).toContain("copilot · cabane_edit");
			// The sidebar card: glyph, label, no task, elapsed.
			expect(frame).toMatch(/copilot · — · \d+s/);
			expect(seen.prompts).toEqual(["Triage every issue in view."]);
			expect(seen.contexts[0]?.selected?.title).toBe("Wire the copilot");
			expect(seen.contexts[0]?.briefs.length).toBe(1);
			mockInput.pressKey("?");
			frame = await until((f) => f.includes("? esc close"));
			await pressEsc();
			frame = await until((f) => !f.includes("? esc close"));
			expect(frame).toContain("copilot · cabane_edit");

			// `o` while it runs: the live transcript, with `x stop the turn` on offer; esc comes back and the
			// turn runs on.
			mockInput.pressKey("o");
			frame = await until((f) => f.includes("⚙ cabane_edit"));
			expect(frame).toContain("reading the selection");
			expect(frame).toContain("copilot · — · running");
			expect(frame).toContain("x stop the turn");
			await pressEsc();
			frame = await until((f) => f.includes("Wire the copilot"));
			expect(frame).toContain("copilot · cabane_edit");

			// `A` while running says so beside the chip, and the input stops inviting a prompt it would
			// refuse. esc leaves the pane and the turn runs on — tabbing in to look and backing out
			// used to kill it, which is the trap this whole flow exists to not set.
			mockInput.pressKey("A");
			frame = await untilPanel();
			expect(frame).toContain("running");
			expect(frame).toContain("a turn is running · send when it ends");
			await pressEsc();
			frame = await until((f) => f.includes("Wire the copilot"));
			expect(frame).toContain("copilot · cabane_edit");
			expect(seen.cancels).toBe(0);

			// `x` on the transcript is the one key that stops a turn; the header turns error-toned and
			// the hint that offered it goes away with the thing it acted on.
			mockInput.pressKey("o");
			frame = await until((f) => f.includes("⚙ cabane_edit"));
			expect(frame).toContain("reading the selection");
			expect(frame).toContain("x stop the turn");
			mockInput.pressKey("x");
			frame = await until((f) => f.includes("copilot · — · failed"));
			expect(frame).not.toContain("x stop the turn");
			expect(seen.cancels).toBe(1);
			await pressEsc();
			frame = await until((f) => f.includes("Wire the copilot"));
			// The keypress that popped the view also dismissed the indicator; the row now names the
			// key that reopens the transcript, and the finished card stays in the sidebar.
			expect(frame).toContain("tab to ask the copilot");
			expect(frame).toContain("o transcript");
			expect(frame).not.toContain("✗ copilot · cancelled");
			expect(frame).toMatch(/✗ copilot · — · \d+s/);

			// The indicator is gone; the transcript is not. `o` still opens it.
			mockInput.pressKey("o");
			frame = await until((f) => f.includes("⚙ cabane_edit"));
			expect(frame).toContain("copilot · — · failed");
			await pressEsc();
			frame = await until((f) => f.includes("Wire the copilot"));

			// Late updates from the cancelled stream are dropped, not written over the closed log.
			release();
			await sleep(50);
			frame = await until((f) => f.includes("Wire the copilot"));
			expect(frame).not.toContain("✓ copilot");
		} finally {
			destroy();
		}
	});

	it("a turn that runs to the end flashes ✓ with the agent's first line; o reopens the finished transcript", async () => {
		const seen: Seen = { prompts: [], contexts: [], cancels: 0 };
		const setup = await renderTest(
			<App
				cwd={TEST_BASE}
				basePath={TEST_BASE}
				activity={noActivity}
				copilot={scriptedCopilot(Promise.resolve(), seen)}
			/>,
			{ width: 120, height: 24 },
		);
		const { renderOnce, captureCharFrame, mockInput, destroy } = setup;
		const until = (p: (f: string) => boolean) =>
			pumpUntil(renderOnce, captureCharFrame, p);
		// The panel's own title row — the collapsed row also carries a `▸`, so waiting on that races
		// focus and sends the next keystrokes to the board instead of the input.
		const untilPanel = () => until(panelOpen);
		try {
			await until((f) => f.includes("Wire the copilot"));
			mockInput.pressKey(":");
			await untilPanel();
			await mockInput.typeText("is this still real?");
			mockInput.pressEnter();
			const frame = await until((f) => f.includes("✓ copilot"));
			expect(frame).toContain("✓ copilot · Moved it to someday.");
			expect(seen.prompts).toEqual(["is this still real?"]);
			// `o` still opens the finished transcript; it shows the completed footer of the card.
			mockInput.pressKey("o");
			const transcript = await until((f) => f.includes("completed ·"));
			expect(transcript).toContain("Moved it to someday.");
			expect(transcript).toContain("← ok");
		} finally {
			destroy();
		}
	});

	it("asking a second thing keeps the first: both turns in the transcript, each under the prompt that started it", async () => {
		const seen: Seen = { prompts: [], contexts: [], cancels: 0 };
		const setup = await renderTest(
			<App
				cwd={TEST_BASE}
				basePath={TEST_BASE}
				activity={noActivity}
				copilot={scriptedCopilot(Promise.resolve(), seen)}
			/>,
			{ width: 120, height: 24 },
		);
		const { renderOnce, captureCharFrame, mockInput, destroy } = setup;
		const until = (p: (f: string) => boolean) =>
			pumpUntil(renderOnce, captureCharFrame, p);
		const untilPanel = () => until(panelOpen);
		const ask = async (prompt: string): Promise<void> => {
			mockInput.pressKey(":");
			await untilPanel();
			await mockInput.typeText(prompt);
			mockInput.pressEnter();
			await until((f) => f.includes("✓ copilot ·"));
		};
		try {
			await until((f) => f.includes("Wire the copilot"));
			await ask("what is left here");
			await ask("and now link them");
			expect(seen.prompts).toEqual(["what is left here", "and now link them"]);

			// One card, one `o`, both turns — each opens on the question it answers, as a block of its
			// own rather than a rule.
			mockInput.pressKey("o");
			const transcript = await until(
				(f) =>
					f.includes("and now link them") && f.includes("what is left here"),
			);
			expect(transcript).not.toContain("──");
			// Oldest first: the turn you asked for second reads below the one before it.
			expect(transcript.indexOf("what is left here")).toBeLessThan(
				transcript.indexOf("and now link them"),
			);
		} finally {
			destroy();
		}
	});
});

describe("a harness blocked on a permission request", () => {
	beforeAll(async () => {
		await freshDb(PERMISSION_BASE);
		const added = await Planner.addTask(PERMISSION_BASE, {
			title: "Wire the copilot",
			kind: "issue",
			state: "next",
		});
		if (!added.ok) throw added.error;
	});

	afterAll(() => {
		dropDb(PERMISSION_BASE);
	});

	// Send a prompt and stop at the choice. The pane's one row is the whole answer to "where does a
	// board with no transcript open learn that something is waiting on it".
	const ask = async (answers: (string | null)[]) => {
		const setup = await renderTest(
			<App
				cwd={PERMISSION_BASE}
				basePath={PERMISSION_BASE}
				activity={noActivity}
				copilot={askingCopilot(answers)}
			/>,
			{ width: 120, height: 24 },
		);
		const { renderOnce, captureCharFrame, mockInput } = setup;
		const until = (p: (f: string) => boolean) =>
			pumpUntil(renderOnce, captureCharFrame, p);
		await until((f) => f.includes("Wire the copilot"));
		mockInput.pressKey(":");
		await until(panelOpen);
		await mockInput.typeText("edit it");
		mockInput.pressEnter();
		// "esc decline" is the block's own line and appears nowhere else on the board.
		const frame = await until((f) => f.includes("esc decline"));
		return { ...setup, until, frame };
	};

	it("asks in the pane, again in the transcript, and a digit answers it", async () => {
		const answers: (string | null)[] = [];
		const { until, mockInput, frame, destroy } = await ask(answers);
		try {
			expect(frame).toContain(
				"? cabane_edit · 1 Allow · 2 Reject · esc decline",
			);

			// `o` opens the transcript, which owns the copilot's detail while it is up: the record
			// of the question among the events, and the live choice pinned below them.
			mockInput.pressKey("o");
			const transcript = await until((f) =>
				f.includes("? permission: cabane_edit"),
			);
			expect(transcript).toContain("1 Allow · 2 Reject");
			// One surface, not two: the pane says nothing while the transcript has it.
			expect(transcript).not.toContain("? cabane_edit · 1 Allow");

			mockInput.pressKey("1");
			const answered = await until((f) => f.includes("Ran it with allow."));
			expect(answers).toEqual(["allow"]);
			expect(answered).not.toContain("esc decline");
		} finally {
			destroy();
		}
	});

	it("esc declines, and nothing else ever answers for the human", async () => {
		const answers: (string | null)[] = [];
		const { until, mockInput, renderOnce, destroy } = await ask(answers);
		try {
			// Nobody has answered while the board rendered its way here.
			expect(answers).toEqual([]);
			mockInput.pressEscape();
			await renderOnce();
			const declined = await until((f) => f.includes("Left it alone."));
			expect(answers).toEqual([null]);
			expect(declined).not.toContain("esc decline");
		} finally {
			destroy();
		}
	});
});

// The pane's look against DESIGN.md: no frame of its own (herdr draws the lines), a raised panel,
// chrome muted and names in the text color, the accent kept for the cursor.
const T = Theme.DARK;
const ints = (color: RGBA): number[] => color.toInts().slice(0, 3);
const rgb = (hex: string): number[] => ints(RGBA.fromHex(hex));
const spanWith = (
	spans: readonly CapturedSpan[],
	text: string,
): CapturedSpan | undefined => spans.find((span) => span.text.includes(text));

const idle = (
	over: Partial<BoardNav.CopilotState> = {},
): BoardNav.CopilotState => ({
	text: "",
	paletteAt: 0,
	history: [],
	historyAt: 0,
	turn: "idle",
	hasLog: false,
	shortcuts: [],
	actor: null,
	permission: null,
	...over,
});

const SHORTCUTS = [
	{ name: "triage", hint: "keep, someday or next", template: "Triage." },
	{
		name: "setup-dispatch",
		hint: "write this project's dispatch skill",
		template: "Set up.",
	},
];

const mountPane = async (
	copilot: BoardNav.CopilotState,
	focused: boolean,
	width = 40,
) => {
	const setup = await renderTest(
		<CopilotPane
			copilot={copilot}
			chip="JALL-1 · next"
			focused={focused}
			log={null}
			spinnerFrame="⠋"
			textareaRef={createRef<TextareaRenderable>()}
			onSubmit={() => {}}
			onContentChange={() => {}}
		/>,
		{ width, height: 16 },
	);
	await setup.renderOnce();
	return {
		...setup,
		frame: setup.captureCharFrame(),
		spans: setup.captureSpans().lines.flatMap((line) => line.spans),
	};
};

describe("the copilot pane's look", () => {
	it("is a raised panel with no frame, titled with the harness in the text color", async () => {
		const { frame, spans, destroy } = await mountPane(
			idle({ actor: "cabane://actor/agent/claude" }),
			true,
		);
		try {
			expect(frame).not.toMatch(/[┌┐└┘│─]/);
			expect(frame).toContain(" copilot · claude · JALL-1 · next");
			const harness = spanWith(spans, "claude");
			expect(harness && ints(harness.fg)).toEqual(rgb(T.text));
			expect(harness && ints(harness.bg)).toEqual(rgb(T.surface.raised));
			const chrome = spanWith(spans, "copilot");
			expect(chrome && ints(chrome.fg)).toEqual(rgb(T.muted));
			// Nothing in the idle panel is orange: the accent is the cursor's, which is not a cell.
			expect(
				spans.some((span) => ints(span.fg).join() === rgb(T.accent).join()),
			).toBe(false);
		} finally {
			destroy();
		}
	});

	it("sizes the palette's names so the longest never runs into its hint, and paints the pick", async () => {
		const { frame, spans, destroy } = await mountPane(
			idle({ text: "/", shortcuts: SHORTCUTS, paletteAt: 1 }),
			true,
		);
		try {
			expect(frame).toMatch(/\/setup-dispatch {2,}write/);
			const picked = spanWith(spans, "/setup-dispatch");
			expect(picked && ints(picked.bg)).toEqual(rgb(T.surface.selected));
			expect(picked && ints(picked.fg)).toEqual(rgb(T.text));
			const other = spanWith(spans, "/triage");
			expect(other && ints(other.bg)).toEqual(rgb(T.surface.raised));
			const hint = spanWith(spans, "keep, someday");
			expect(hint && ints(hint.fg)).toEqual(rgb(T.muted));
		} finally {
			destroy();
		}
	});

	it("collapsed, names its key in the text color and says the rest muted", async () => {
		const { frame, spans, destroy } = await mountPane(idle(), false);
		try {
			expect(frame).toContain("▸ tab to ask the copilot");
			const key = spans.find((span) => span.text === "tab");
			expect(key && ints(key.fg)).toEqual(rgb(T.text));
			const rest = spanWith(spans, "to ask the copilot");
			expect(rest && ints(rest.fg)).toEqual(rgb(T.muted));
		} finally {
			destroy();
		}
	});
});

describe("the pane's words", () => {
	it("harnessOf reads the harness from the actor, and nothing from no actor", () => {
		expect(harnessOf("cabane://actor/agent/codex")).toBe("codex");
		expect(harnessOf(null)).toBeNull();
	});

	it("titleSegments leaves out what is absent and gives the state its hue", () => {
		const title = titleSegments(
			{
				harness: null,
				chip: "JALL-1",
				progress: "1/3",
				state: "running",
				elapsed: "12s",
			},
			T,
		);
		expect(Segments.plain(title)).toBe(
			"copilot · JALL-1 · 1/3 · running · 12s",
		);
		expect(title.find((part) => part.text === "running")?.fg).toBe(T.working);
		const stopped = titleSegments(
			{
				harness: null,
				chip: "JALL-1",
				progress: null,
				state: "stopped",
				elapsed: null,
			},
			T,
		);
		expect(stopped.find((part) => part.text === "stopped")?.fg).toBe(T.failed);
	});

	it("paletteNameCols leaves the gutter, the slash and a two-cell gap around the longest name", () => {
		expect(paletteNameCols(SHORTCUTS)).toBe("setup-dispatch".length + 5);
		expect(paletteNameCols([])).toBe(5);
	});

	it("collapsedSegments puts a waiting question ahead of everything, its ? in the accent", () => {
		const permission = {
			id: "p1",
			title: "cabane_edit",
			options: [
				{ id: "allow", label: "Allow" },
				{ id: "reject", label: "Reject" },
			],
		};
		const line = collapsedSegments(idle({ permission }), null, null, T);
		expect(Segments.plain(line)).toBe(
			"? cabane_edit · 1 Allow · 2 Reject · esc decline",
		);
		expect(line[0]?.fg).toBe(T.accent);
		expect(line.find((part) => part.text === "1")?.fg).toBe(T.text);
	});
});
