/** @jsxImportSource @opentui/react */
// The `A` flow end to end against a scripted copilot: the window and its chip, the running
// indicator while the board stays interactive, the copilot card in the sidebar, the live transcript
// in the event view with `x cancel`, the `✓` flash on completion, and the keypress that dismisses it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner } from "@cabane/core";
import { App } from "./app";
import type { BoardContext } from "./context";
import { contextChip } from "./copilot-prompt";
import type { Copilot, CopilotStep, CopilotUpdate } from "./ports";
import { noActivity } from "./ports";
import { dropDb, freshDb } from "./test-db";
import { pumpUntil, renderTest } from "./testing";

const TEST_BASE = join(tmpdir(), `cabane-board-copilot-${crypto.randomUUID()}`);

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

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
});

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
		// The panel's own border — the collapsed row also carries a `▸`, so waiting on that races
		// focus and sends the next keystrokes to the board instead of the input.
		const untilPanel = () => until((f) => f.includes("┌─copilot"));
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

			// `A`: the pane opens into the panel — bordered, titled with the chip, and a real input
			// several rows tall with a placeholder.
			mockInput.pressKey("A");
			let frame = await untilPanel();
			expect(frame).toContain("copilot · JALL-1 · next");
			expect(frame).toContain("ask about the selection · / for shortcuts");

			// A half-written prompt survives leaving the pane and coming back — the point of making the
			// copilot focusable rather than modal. The textarea unmounts with the panel, so the
			// mirrored text is what seeds the new one.
			await mockInput.typeText("/tr");
			await until((f) => f.includes("/tr"));
			await pressEsc();
			await until((f) => !f.includes("┌─copilot"));
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
			expect(frame).not.toContain("┌─copilot");
			expect(frame).toContain("copilot · cabane_edit");
			// The sidebar card: glyph, label, no task, elapsed.
			expect(frame).toMatch(/copilot · — · \d+s/);
			expect(seen.prompts).toEqual(["Triage every issue in view."]);
			expect(seen.contexts[0]?.selected?.title).toBe("Wire the copilot");
			expect(seen.contexts[0]?.briefs.length).toBe(1);
			mockInput.pressKey("?");
			frame = await until((f) => f.includes("? / esc close"));
			await pressEsc();
			frame = await until((f) => !f.includes("? / esc close"));
			expect(frame).toContain("copilot · cabane_edit");

			// `o` while it runs: the live transcript, with `x cancel` on offer; esc comes back and the
			// turn runs on.
			mockInput.pressKey("o");
			frame = await until((f) => f.includes("⚙ cabane_edit"));
			expect(frame).toContain("reading the selection");
			expect(frame).toContain("copilot · — · running");
			expect(frame).toContain("x cancel");
			await pressEsc();
			frame = await until((f) => f.includes("Wire the copilot"));
			expect(frame).toContain("copilot · cabane_edit");

			// `A` while running says so beside the chip and still takes keys; esc there stops the turn
			// and the indicator turns to the error tone.
			mockInput.pressKey("A");
			frame = await untilPanel();
			expect(frame).toContain("running");
			await pressEsc();
			frame = await until((f) => f.includes("✗ copilot · cancelled"));
			expect(frame).not.toContain("a turn is running");
			expect(seen.cancels).toBe(1);

			// `o` opens the transcript on the copilot card, back on esc.
			mockInput.pressKey("o");
			frame = await until((f) => f.includes("⚙ cabane_edit"));
			expect(frame).toContain("reading the selection");
			expect(frame).toContain("copilot · — · failed");
			expect(frame).not.toContain("x cancel");
			await pressEsc();
			frame = await until((f) => f.includes("Wire the copilot"));
			// The keypress after the turn ended dismisses the indicator; hints are back, and the
			// finished card stays in the sidebar.
			expect(frame).toContain("tab to ask the copilot");
			expect(frame).not.toContain("✗ copilot · cancelled");
			expect(frame).toMatch(/✗ copilot · — · \d+s/);

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
		// The panel's own border — the collapsed row also carries a `▸`, so waiting on that races
		// focus and sends the next keystrokes to the board instead of the input.
		const untilPanel = () => until((f) => f.includes("┌─copilot"));
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
		const untilPanel = () => until((f) => f.includes("┌─copilot"));
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

			// One card, one `o`, both turns — the rule each opens with is the question it answers.
			mockInput.pressKey("o");
			const transcript = await until((f) => f.includes("── and now link them"));
			expect(transcript).toContain("── what is left here");
			// Oldest first: the turn you asked for second reads below the one before it.
			expect(transcript.indexOf("── what is left here")).toBeLessThan(
				transcript.indexOf("── and now link them"),
			);
		} finally {
			destroy();
		}
	});
});
