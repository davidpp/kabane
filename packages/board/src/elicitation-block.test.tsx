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
import { dropDb, freshDb } from "./test-db";
import { pumpUntil, renderTest } from "./testing";
import { Theme } from "./theme";

const STORE: CopilotElicitation = {
	id: "form-1",
	message: "Which store should the cache use for the session tokens?",
	fields: [
		{
			key: "question_0",
			title: "Store",
			required: false,
			type: "choice",
			options: [
				{
					value: "Redis",
					label: "Redis",
					description: "Shared, survives restarts",
				},
				{ value: "Memory", label: "Memory" },
			],
		},
		{ key: "question_0_custom", title: "Other", required: false, type: "text" },
	],
};

const TAGS: CopilotElicitation = {
	id: "form-2",
	message: "Which tags apply?",
	fields: [
		{
			key: "tags",
			title: "Tags",
			required: true,
			type: "choices",
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
				{ value: "c", label: "Gamma" },
			],
		},
	],
};

const mount = async (
	request: CopilotElicitation,
	draft: ElicitationForm.Draft,
	width: number,
	bg?: string,
) => {
	const setup = await renderTest(
		<box style={{ flexDirection: "column", width }}>
			<ElicitationBlock
				request={request}
				draft={draft}
				width={width}
				{...(bg ? { bg } : {})}
				inHand
				onSubmit={() => {}}
			/>
		</box>,
		{ width, height: 12 },
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

describe("ElicitationBlock", () => {
	it("at 120 columns: the message verbatim, the field, one option a row once one explains itself", async () => {
		const { frame, destroy } = await mount(STORE, ElicitationForm.start(), 120);
		expect(lines(frame)).toEqual([
			"? Which store should the cache use for the session tokens?",
			"Store · 1 of 2 · optional",
			"1 Redis  Shared, survives restarts",
			"2 Memory",
			"enter skip · esc decline",
		]);
		destroy();
	});

	it("at 40 columns the message wraps rather than losing its tail", async () => {
		const { frame, destroy } = await mount(STORE, ElicitationForm.start(), 40);
		const shown = lines(frame);
		expect(shown.join(" ")).toContain("session tokens?");
		expect(shown.every((line) => line.length <= 40)).toBe(true);
		expect(shown.at(-1)).toBe("enter skip · esc decline");
		destroy();
	});

	it("a typed field shows its input with what it wants, and a refusal says why", async () => {
		const { frame, destroy } = await mount(
			STORE,
			{ at: 1, values: { question_0: "Redis" }, picked: [], error: "nope" },
			120,
		);
		expect(lines(frame)).toEqual([
			"? Which store should the cache use for the session tokens?",
			"Other · 2 of 2 · optional",
			"▸ text",
			"nope",
			"enter send, empty skips · esc decline",
		]);
		destroy();
	});

	it("a multi-select shows what is toggled, on one row when it fits", async () => {
		for (const width of [40, 120]) {
			const { frame, destroy } = await mount(
				TAGS,
				{ at: 0, values: {}, picked: [2] },
				width,
			);
			expect(lines(frame)).toEqual([
				"? Which tags apply?",
				"Tags",
				"1 [ ] Alpha · 2 [ ] Beta · 3 [x] Gamma",
				"enter confirm · esc decline",
			]);
			destroy();
		}
	});

	it("answerKeys names what answers each kind of field", () => {
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
			bg,
		);
		expect(fgOf(spans, "Redis")).toEqual(rgb(T.text));
		expect(fgOf(spans, "Memory")).toEqual(rgb(T.text));
		expect(fgOf(spans, "Shared, survives restarts")).toEqual(rgb(T.secondary));
		expect(fgOf(spans, "1 of 2")).toEqual(rgb(T.muted));
		expect(fgOf(spans, "optional")).toEqual(rgb(T.muted));
		destroy();
	});

	it("undescribed: the labels in the text color, the separators muted", async () => {
		const { spans, destroy } = await mount(
			UNDESCRIBED,
			ElicitationForm.start(),
			120,
			bg,
		);
		expect(fgOf(spans, "Redis")).toEqual(rgb(T.text));
		expect(fgOf(spans, "Memory")).toEqual(rgb(T.text));
		expect(fgOf(spans, " · ")).toEqual(rgb(T.muted));
		destroy();
	});

	it("a multi-select: every label in the text color, a toggled box in the accent and an open one muted", async () => {
		const { spans, destroy } = await mount(
			TAGS,
			{ at: 0, values: {}, picked: [2] },
			120,
			bg,
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
			"1 [ ] Alpha · 2 [ ] Beta · 3 [ ] Gamma",
			"enter confirm · esc decline",
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
