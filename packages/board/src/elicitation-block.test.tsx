/** @jsxImportSource @opentui/react */
import { describe, expect, it } from "bun:test";
import type { TextareaRenderable } from "@opentui/core";
import { createRef } from "react";
import { CopilotPane } from "./copilot-prompt";
import { answerKeys, ElicitationBlock } from "./elicitation-block";
import { ElicitationForm } from "./elicitation-form";
import type { BoardNav } from "./nav";
import type { CopilotElicitation } from "./ports";
import { renderTest } from "./testing";

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
) => {
	const setup = await renderTest(
		<box style={{ flexDirection: "column", width }}>
			<ElicitationBlock
				request={request}
				draft={draft}
				width={width}
				inHand
				onSubmit={() => {}}
			/>
		</box>,
		{ width, height: 12 },
	);
	await setup.renderOnce();
	return { ...setup, frame: setup.captureCharFrame() };
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

describe("the copilot pane with a form at the head of its queue", () => {
	const copilot = (asks: BoardNav.CopilotAsk[]): BoardNav.CopilotState => ({
		text: "",
		paletteAt: 0,
		history: [],
		historyAt: 0,
		turn: "running",
		hasLog: false,
		shortcuts: [],
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
