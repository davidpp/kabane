/** @jsxImportSource @opentui/react */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	RGBA,
	type TextareaRenderable,
	type CapturedSpan,
} from "@opentui/core";
import { createRef } from "react";
import { App } from "./app";
import { CopilotPane } from "./copilot-prompt";
import { answerKeys, ElicitationBlock } from "./elicitation-block";
import { ElicitationForm } from "./elicitation-form";
import type { BoardNav } from "./nav";
import {
	type Copilot,
	type CopilotElicitation,
	type CopilotElicitationAnswer,
	noActivity,
} from "./ports";
import { Fixtures } from "./stories/fixtures";
import { dropDb, freshDb } from "./test-db";
import { pumpUntil, renderTest } from "./testing";
import { Theme } from "./theme";

const { STORE, TAGS, DELIVERY } = Fixtures;

const mount = async (
	request: CopilotElicitation,
	draft: ElicitationForm.Draft,
	width: number,
	{ bg, rows = 24 }: { bg?: string; rows?: number } = {},
) => {
	const setup = await renderTest(
		<box style={{ flexDirection: "column", width }}>
			<ElicitationBlock
				request={request}
				draft={draft}
				width={width}
				rows={rows}
				{...(bg ? { bg } : {})}
				inHand
				onSubmit={() => {}}
			/>
		</box>,
		{ width, height: 24 },
	);
	await setup.renderOnce();
	return {
		...setup,
		frame: setup.captureCharFrame(),
		spans: setup.captureSpans().lines.flatMap((line) => line.spans),
	};
};

const lines = (frame: string): string[] =>
	frame
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");

// The block's rows as drawn, its indents and blank rows kept, the empty screen under it dropped.
const rowsOf = (frame: string): string[] => {
	const rows = frame.split("\n").map((line) => line.trimEnd());
	while (rows.at(-1) === "") rows.pop();
	return rows;
};

describe("ElicitationBlock", () => {
	it("at 120 columns: the message, the field, and each description on its own row under its label", async () => {
		const { frame, destroy } = await mount(STORE, ElicitationForm.start(), 120);
		expect(rowsOf(frame)).toEqual([
			"? Which store should the cache use for the session tokens?",
			"Store · 1 of 2 · optional",
			"",
			"1 Redis",
			"  Shared, survives restarts",
			"2 Memory",
			"",
			"↑↓ move · enter pick · 1-2 pick · s skip · esc decline",
		]);
		destroy();
	});

	it("at 40 columns the message and the descriptions wrap by word under their own column", async () => {
		const { frame, destroy } = await mount(
			DELIVERY,
			ElicitationForm.start(),
			40,
		);
		expect(rowsOf(frame)).toEqual([
			"? Which delivery contract should the",
			"  runner hold to when a harness drops",
			"  its session?",
			"Delivery",
			"",
			"1 At most once",
			"  Drop the turn and report it failed",
			"2 At least once",
			"  Replay the turn from its last",
			"  checkpoint",
			"3 Ask the human",
			"",
			"↑↓ move · enter pick · 1-3 pick · esc d…",
		]);
		destroy();
	});

	it("a multi-select's descriptions start at its labels' column, past the box", async () => {
		const { frame, destroy } = await mount(
			{
				...TAGS,
				fields: [
					{
						key: "tags",
						title: "Tags",
						required: true,
						type: "choices",
						options: [
							{ value: "a", label: "Alpha", description: "the first" },
							{ value: "b", label: "Beta" },
						],
					},
				],
			},
			{ at: 0, values: {}, picked: [0] },
			40,
		);
		expect(rowsOf(frame).slice(3, 6)).toEqual([
			"1 [x] Alpha",
			"      the first",
			"2 [ ] Beta",
		]);
		destroy();
	});

	it("held to fewer rows, it gives up the blank rows, then each description's tail", async () => {
		const at = async (rows: number) => {
			const { frame, destroy } = await mount(
				DELIVERY,
				ElicitationForm.start(),
				40,
				{ rows },
			);
			destroy();
			return rowsOf(frame);
		};
		// Whole, with its blank rows: 13 rows.
		expect(await at(13)).toHaveLength(13);
		// No blank rows.
		expect(await at(12)).toEqual([
			"? Which delivery contract should the",
			"  runner hold to when a harness drops",
			"  its session?",
			"Delivery",
			"1 At most once",
			"  Drop the turn and report it failed",
			"2 At least once",
			"  Replay the turn from its last",
			"  checkpoint",
			"3 Ask the human",
			"↑↓ move · enter pick · 1-3 pick · esc d…",
		]);
		// Each description cut to its label's row.
		expect((await at(10)).slice(4, 7)).toEqual([
			"1 At most once  Drop the turn and repor…",
			"2 At least once  Replay the turn from i…",
			"3 Ask the human",
		]);
		// Tighter than that, it takes the rows it needs rather than draw over itself: each option
		// keeps a row of its own, because the cursor is a row.
		expect(await at(7)).toEqual(await at(10));
	});

	it("undescribed options take a row each, as described ones do", async () => {
		const { frame, destroy } = await mount(
			{
				...TAGS,
				fields: [
					{
						key: "pick",
						title: "Pick",
						required: true,
						type: "choice",
						options: ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map(
							(label) => ({ value: label, label }),
						),
					},
				],
			},
			ElicitationForm.start(),
			30,
		);
		expect(rowsOf(frame).slice(3, 9)).toEqual([
			"1 Alpha",
			"2 Beta",
			"3 Gamma",
			"4 Delta",
			"5 Epsilon",
			"",
		]);
		destroy();
	});

	it("a typed field shows its input with what it wants, and a refusal says why", async () => {
		const { frame, destroy } = await mount(
			STORE,
			{ at: 1, values: { question_0: "Redis" }, picked: [], error: "nope" },
			120,
		);
		expect(rowsOf(frame)).toEqual([
			"? Which store should the cache use for the session tokens?",
			"Other · 2 of 2 · optional",
			"",
			" ▸ text",
			"nope",
			"",
			"enter send, empty skips · esc decline",
		]);
		destroy();
	});

	it("a multi-select shows what is toggled", async () => {
		const { frame, destroy } = await mount(
			TAGS,
			{ at: 0, values: {}, picked: [2] },
			40,
		);
		expect(lines(frame)).toEqual([
			"? Which tags apply?",
			"Tags",
			"1 [ ] Alpha",
			"2 [ ] Beta",
			"3 [x] Gamma",
			"↑↓ move · space toggle · enter send (1 …",
		]);
		destroy();
	});

	it("the cursor's option is on the selected surface across the row, its note's rows too", async () => {
		const T = Theme.DARK;
		const bg = T.surface.raised;
		const { frame, captureSpans, destroy } = await mount(
			DELIVERY,
			{ ...ElicitationForm.start(), cursor: 1 },
			40,
			{ bg },
		);
		const rgb = (hex: string): string =>
			RGBA.fromHex(hex).toInts().slice(0, 3).join();
		// Every cell of a row painted, as the Selection Rule wants: the row's backgrounds and how
		// many columns they cover.
		const painted = (y: number): { bgs: string[]; cols: number } => {
			const spans = captureSpans().lines[y]?.spans ?? [];
			return {
				bgs: [...new Set(spans.map((s) => s.bg.toInts().slice(0, 3).join()))],
				cols: spans.reduce((n, s) => n + s.text.length, 0),
			};
		};
		const rows = rowsOf(frame);
		const at = rows.indexOf("2 At least once");
		expect(rows.slice(at, at + 3)).toEqual([
			"2 At least once",
			"  Replay the turn from its last",
			"  checkpoint",
		]);
		for (const y of [at, at + 1, at + 2])
			expect(painted(y)).toEqual({ bgs: [rgb(T.surface.selected)], cols: 40 });
		for (const y of [at - 2, at - 1, at + 3])
			expect(painted(y).bgs).not.toContain(rgb(T.surface.selected));
		destroy();
	});

	it("without the keys it says who has them and how to reach it; with them, nothing extra", async () => {
		const shown = async (inHand: boolean) => {
			const { captureCharFrame, destroy } = await renderTest(
				<box style={{ flexDirection: "column", width: 60 }}>
					<ElicitationBlock
						request={TAGS}
						draft={ElicitationForm.start()}
						width={60}
						rows={24}
						inHand={inHand}
						reach={{ key: "esc", holder: "the prompt" }}
						onSubmit={() => {}}
					/>
				</box>,
				{ width: 60, height: 24 },
			);
			const frame = captureCharFrame();
			destroy();
			return lines(frame).at(-1);
		};
		expect(await shown(false)).toBe("esc to answer · the prompt has the keys");
		expect(await shown(true)).toBe(
			"↑↓ move · space toggle · enter send (0 picked) · esc decline",
		);
	});

	it("a click on a typed field's enter hint sends what its input holds", async () => {
		const sent: string[] = [];
		const { mockInput, mockMouse, renderOnce, captureCharFrame, destroy } =
			await renderTest(
				<box style={{ flexDirection: "column", width: 60 }}>
					<ElicitationBlock
						request={STORE}
						draft={{ ...ElicitationForm.start(), at: 1 }}
						width={60}
						rows={24}
						inHand
						onSubmit={(text) => sent.push(text)}
					/>
				</box>,
				{ width: 60, height: 24 },
			);
		try {
			await mockInput.typeText("Postgres");
			await renderOnce();
			const rows = captureCharFrame().split("\n");
			const y = rows.findIndex((row) => row.startsWith("enter send"));
			await mockMouse.click(0, y);
			expect(sent).toEqual(["Postgres"]);
		} finally {
			destroy();
		}
	});

	it("answerKeys names what answers each kind of field", () => {
		const store = STORE.fields[0];
		const tags = TAGS.fields[0];
		if (!store || !tags) throw new Error("the forms have their fields");
		expect(answerKeys(store)).toEqual([
			["↑↓", "move"],
			["enter", "pick"],
			["1-2", "pick"],
			["s", "skip"],
			["esc", "decline"],
		]);
		expect(answerKeys(tags, 2)).toEqual([
			["↑↓", "move"],
			["space", "toggle"],
			["enter", "send (2 picked)"],
			["esc", "decline"],
		]);
		expect(answerKeys({ ...tags, required: false })).toContainEqual([
			"s",
			"skip",
		]);
		expect(answerKeys(undefined)).toEqual([
			["enter", "accept"],
			["esc", "decline"],
		]);
		expect(
			answerKeys({ key: "ok", title: "Ok", required: true, type: "boolean" }),
		).toEqual([
			["y", "yes"],
			["n", "no"],
			["esc", "decline"],
		]);
	});
});

// An ask's answers are what the human reads to decide: content, not chrome (DESIGN.md, Copilot pane).
describe("a form's colors on the copilot's raised panel", () => {
	const T = Theme.DARK;
	const bg = T.surface.raised;
	const ints = (color: RGBA): number[] => color.toInts().slice(0, 3);
	const rgb = (hex: string): number[] => ints(RGBA.fromHex(hex));
	const fgOf = (spans: readonly CapturedSpan[], text: string) => {
		const span = spans.find((s) => s.text.includes(text));
		return span && ints(span.fg);
	};
	const UNDESCRIBED: CopilotElicitation = {
		...STORE,
		fields: [
			{
				key: "question_0",
				title: "Store",
				required: true,
				type: "choice",
				options: [
					{ value: "Redis", label: "Redis" },
					{ value: "Memory", label: "Memory" },
				],
			},
		],
	};

	it("described: keys and labels in the text color, each description secondary, the meta muted", async () => {
		const { spans, destroy } = await mount(
			STORE,
			ElicitationForm.start(),
			120,
			{ bg },
		);
		expect(fgOf(spans, "Redis")).toEqual(rgb(T.text));
		expect(fgOf(spans, "Memory")).toEqual(rgb(T.text));
		expect(fgOf(spans, "Shared, survives restarts")).toEqual(rgb(T.secondary));
		expect(fgOf(spans, "1 of 2")).toEqual(rgb(T.muted));
		expect(fgOf(spans, "optional")).toEqual(rgb(T.muted));
		destroy();
	});

	it("undescribed: the labels in the text color", async () => {
		const { spans, destroy } = await mount(
			UNDESCRIBED,
			ElicitationForm.start(),
			120,
			{ bg },
		);
		expect(fgOf(spans, "Redis")).toEqual(rgb(T.text));
		expect(fgOf(spans, "Memory")).toEqual(rgb(T.text));
		destroy();
	});

	it("a multi-select: every label in the text color, a toggled box in the accent and an open one muted", async () => {
		const { spans, destroy } = await mount(
			TAGS,
			{ at: 0, values: {}, picked: [2] },
			120,
			{ bg },
		);
		for (const label of ["Alpha", "Beta", "Gamma"])
			expect(fgOf(spans, label)).toEqual(rgb(T.text));
		expect(fgOf(spans, "[x]")).toEqual(rgb(T.accent));
		expect(fgOf(spans, "[ ]")).toEqual(rgb(T.muted));
		destroy();
	});
});

describe("the copilot pane with a form at the head of its queue", () => {
	const copilot = (asks: BoardNav.CopilotAsk[]): BoardNav.CopilotState => ({
		text: "",
		paletteAt: 0,
		history: [],
		historyAt: 0,
		turn: "running",
		hasLog: false,
		shortcuts: [],
		commands: [],
		actor: "cabane://actor/agent/claude",
		asks,
	});
	const ask: BoardNav.CopilotAsk = {
		type: "elicitation",
		request: TAGS,
		draft: ElicitationForm.start(),
	};

	const pane = async (outranked: boolean, detailShownElsewhere: boolean) => {
		const setup = await renderTest(
			<CopilotPane
				copilot={copilot([ask])}
				chip="JALL-1"
				focused={false}
				log={null}
				spinnerFrame="⠋"
				detailShownElsewhere={detailShownElsewhere}
				outranked={outranked}
				askInHand={!outranked}
				textareaRef={createRef<TextareaRenderable>()}
				onSubmit={() => {}}
				onContentChange={() => {}}
			/>,
			{ width: 60, height: 10 },
		);
		await setup.renderOnce();
		return { ...setup, frame: setup.captureCharFrame() };
	};

	it("opens unfocused, over the transcript too, with no copilot input under it", async () => {
		const { frame, destroy } = await pane(false, true);
		expect(lines(frame)).toEqual([
			"copilot · claude · JALL-1 · running",
			"? Which tags apply?",
			"Tags",
			"1 [ ] Alpha",
			"2 [ ] Beta",
			"3 [ ] Gamma",
			"↑↓ move · space toggle · enter send (0 picked) · esc decl…",
		]);
		destroy();
	});

	it("outranked, it is one row naming the form and the key that reaches it", async () => {
		const { frame, destroy } = await pane(true, false);
		expect(lines(frame)).toEqual([
			"? copilot asks: Which tags apply? · tab to answer",
		]);
		destroy();
	});
});

describe("a form's typed field in the running board", () => {
	const BASE = join(tmpdir(), `cabane-board-form-${crypto.randomUUID()}`);
	beforeAll(() => freshDb(BASE));
	afterAll(() => dropDb(BASE));

	const WORKERS: CopilotElicitation = {
		id: "form-1",
		message: "How many workers?",
		fields: [
			{
				key: "n",
				title: "Workers",
				required: true,
				type: "number",
				integer: true,
				minimum: 1,
				maximum: 64,
			},
		],
	};

	// Holds the form back until `ask` is called, so the test can focus the pane first, and hands
	// back the answer the board gives.
	const formCopilot = () => {
		let ask: () => void = () => {};
		const asked = new Promise<void>((resolve) => {
			ask = resolve;
		});
		let answer: (a: CopilotElicitationAnswer) => void = () => {};
		const answered = new Promise<CopilotElicitationAnswer>((resolve) => {
			answer = resolve;
		});
		const copilot: Copilot = {
			run: async function* () {
				const at = new Date().toISOString();
				await asked;
				yield { type: "elicitation", request: WORKERS, at };
				await answered;
				yield { type: "done", summary: "", at };
			},
			cancel: async () => {},
			shortcuts: () => [],
			answerPermission: () => {},
			answerElicitation: (_id, given) => answer(given),
		};
		return { copilot, ask, answered };
	};

	it("takes digits as text while the copilot pane has the focus, refuses what the field does not take, and sends a number", async () => {
		const { copilot, ask, answered } = formCopilot();
		const { renderOnce, captureCharFrame, mockInput, destroy } =
			await renderTest(
				<App
					cwd={BASE}
					basePath={BASE}
					activity={noActivity}
					copilot={copilot}
				/>,
				{ width: 100, height: 20 },
			);
		const until = (p: (f: string) => boolean) =>
			pumpUntil(renderOnce, captureCharFrame, p);
		try {
			await until((f) => f.includes("tab to ask the copilot"));
			mockInput.pressKey("A");
			await until((f) => f.includes("ask about the selection"));
			await mockInput.typeText("go");
			mockInput.pressEnter();
			await until((f) => f.includes("copilot · thinking"));
			// Back in the pane before the form arrives: its digits must reach the form's input.
			mockInput.pressKey("A");
			await until((f) => f.includes("a turn is running"));
			ask();
			await until((f) => f.includes("How many workers?"));
			await mockInput.typeText("99");
			mockInput.pressEnter();
			await until((f) => f.includes('"99" is not a whole number from 1 to 64'));
			mockInput.pressBackspace();
			mockInput.pressBackspace();
			await mockInput.typeText("42");
			mockInput.pressEnter();
			expect(await answered).toEqual({
				action: "accept",
				content: { n: 42 },
			});
		} finally {
			destroy();
		}
	});
});
