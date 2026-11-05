import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpClient } from "@cabane/acp";
import {
	type AgentActivity,
	isAnswerTo,
	parseQuestionBody,
	Planner,
	type Result,
} from "@cabane/core";
import { Elicitation } from "./elicitation";
import type { RunStore } from "./store";

let base = "";

beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "loop-elicitation-"));
	await Planner.init(base);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

// One AskUserQuestion question as claude-agent-acp 0.99.1 sends it, through AcpClient's mapping:
// the choice, then its optional "Other" box. Nothing is required.
const ASK: AcpClient.ElicitationRequest = {
	message: "Which store should the cache use?",
	toolCallId: "toolu_ask",
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
		{
			key: "question_0_custom",
			title: "Other",
			description:
				"Type your own answer, or add a note to the option you chose above (optional).",
			required: false,
			type: "text",
		},
	],
};

// Two AskUserQuestion questions in one form: each field carries its question as its description,
// and each is followed by its own "Other" box.
const otherBox = (
	index: number,
	multi: boolean,
): AcpClient.ElicitationField => ({
	key: `question_${index}_custom`,
	title: "Other",
	description: multi
		? "Type your own answer to add to your selection above (optional)."
		: "Type your own answer, or add a note to the option you chose above (optional).",
	required: false,
	type: "text",
});
const ASK_TWO: AcpClient.ElicitationRequest = {
	message: "Please answer the following questions.",
	toolCallId: "toolu_ask_two",
	fields: [
		{
			key: "question_0",
			title: "Store",
			description: "Which store should the cache use?",
			required: false,
			type: "choice",
			options: [
				{ value: "Redis", label: "Redis" },
				{ value: "Memory", label: "Memory" },
			],
		},
		otherBox(0, false),
		{
			key: "question_1",
			title: "Checks",
			description: "Which checks should the gate run?",
			required: false,
			type: "choices",
			options: [
				{ value: "lint", label: "Lint" },
				{ value: "types", label: "Types" },
			],
		},
		otherBox(1, true),
	],
};

// A field named F, of whatever shape the test gives it.
const named = { key: "f", title: "F" };
const field = (f: AcpClient.ElicitationField): AcpClient.ElicitationField => f;

const fieldsOf = (request: AcpClient.ElicitationRequest) => {
	const [first, second] = request.fields;
	if (!first || !second) throw new Error("the form has two fields");
	return [first, second] as const;
};

const asked = (request: AcpClient.ElicitationRequest) => {
	const [first, ...rest] = Elicitation.questions(request.fields);
	if (!first) throw new Error("the form asks nothing");
	return [first, ...rest] as const;
};

describe("Elicitation.questions", () => {
	it("folds each AskUserQuestion Other box into the choice before it", () => {
		const keys = Elicitation.questions(ASK_TWO.fields).map((q) => [
			q.field.key,
			q.other?.key,
		]);
		expect(keys).toEqual([
			["question_0", "question_0_custom"],
			["question_1", "question_1_custom"],
		]);
	});

	it("keeps a free-text field apart when it does not follow an optional choice, or is required", () => {
		const choice = field({
			...named,
			required: false,
			type: "choice",
			options: [{ value: "a", label: "A" }],
		});
		const note = field({
			key: "n",
			title: "Note",
			required: false,
			type: "text",
		});
		const apart = (...fields: AcpClient.ElicitationField[]) =>
			Elicitation.questions(fields).map((q) => [q.field.key, q.other?.key]);
		// codex's request_user_input: its choice is required, so a typed answer would leave it empty.
		expect(apart({ ...choice, required: true }, note)).toEqual([
			["f", undefined],
			["n", undefined],
		]);
		expect(apart(choice, { ...note, required: true })).toEqual([
			["f", undefined],
			["n", undefined],
		]);
		expect(apart(note, choice)).toEqual([
			["n", undefined],
			["f", undefined],
		]);
		expect(
			apart(field({ ...named, required: false, type: "boolean" }), note),
		).toEqual([
			["f", undefined],
			["n", undefined],
		]);
	});
});

describe("Elicitation.body", () => {
	it("asks a choice and its Other box as one question that also takes a typed answer", () => {
		const [store, ...rest] = asked(ASK);
		expect(rest).toEqual([]);
		const parsed = parseQuestionBody(
			Elicitation.body("claude", ASK, store, { index: 0, total: 1 }),
		);
		expect(parsed.question).toBe(
			"claude asks: Which store should the cache use?\nStore\nPick one, or type your own answer.",
		);
		expect(parsed.choices).toEqual(["Redis", "Memory", "skip", "decline"]);
		expect(parsed.multiSelect).toBe(false);
		expect(parsed.allowFreeform).toBe(true);
		expect(parsed.questionIndex).toBeUndefined();
	});

	it("numbers the questions of a form, and says a multi-select takes a typed answer too", () => {
		const [, checks] = asked(ASK_TWO);
		if (!checks) throw new Error("missing question");
		const parsed = parseQuestionBody(
			Elicitation.body("claude", ASK_TWO, checks, { index: 1, total: 2 }),
		);
		expect(parsed.question).toBe(
			[
				"claude asks: Please answer the following questions.",
				"Checks: Which checks should the gate run? (2 of 2)",
				"Pick any of the choices, type your own answer, `skip` to leave it empty, or `decline` to decline the form.",
			].join("\n"),
		);
		expect(parsed.choices).toEqual(["Lint", "Types"]);
		expect([parsed.questionIndex, parsed.totalQuestions]).toEqual([1, 2]);
	});

	it("asks a choice with no Other box from its options alone", () => {
		const [store] = fieldsOf(ASK);
		const parsed = parseQuestionBody(
			Elicitation.body("claude", ASK, { field: store }, { index: 0, total: 2 }),
		);
		expect(parsed.question).toBe(
			"claude asks: Which store should the cache use?\nStore (1 of 2)",
		);
		expect(parsed.choices).toEqual(["Redis", "Memory", "skip", "decline"]);
		expect(parsed.allowFreeform).toBe(false);
	});

	it("asks a text field as free text, its description verbatim, saying how to skip or decline", () => {
		const [, other] = fieldsOf(ASK);
		const parsed = parseQuestionBody(
			Elicitation.body("claude", ASK, { field: other }, { index: 1, total: 2 }),
		);
		expect(parsed.question).toBe(
			[
				"claude asks: Which store should the cache use?",
				"Other: Type your own answer, or add a note to the option you chose above (optional). (2 of 2)",
				"Type the answer, `skip` to leave it empty, or `decline` to decline the form.",
			].join("\n"),
		);
		expect(parsed.choices).toEqual([]);
		expect(parsed.allowFreeform).toBe(true);
	});

	it("offers no skip on a required field, and asks a lone field without numbering it", () => {
		const parsed = parseQuestionBody(
			Elicitation.body(
				"codex",
				{ message: "Codex needs your input to continue.", fields: [] },
				{ field: field({ ...named, required: true, type: "boolean" }) },
				{ index: 0, total: 1 },
			),
		);
		expect(parsed.question).toBe(
			"codex asks: Codex needs your input to continue.\nF",
		);
		expect(parsed.choices).toEqual(["Yes", "No", "decline"]);
	});
});

describe("Elicitation.read", () => {
	const choice = field({
		...named,
		required: true,
		type: "choice",
		options: [
			{ value: "r", label: "Redis" },
			{ value: "d", label: "Decline" },
		],
	});

	it("reads a choice as the option's value, by value, label or position", () => {
		expect(Elicitation.read(choice, "redis")).toEqual({
			kind: "value",
			value: "r",
		});
		expect(Elicitation.read(choice, "r")).toEqual({
			kind: "value",
			value: "r",
		});
		expect(Elicitation.read(choice, "1")).toEqual({
			kind: "value",
			value: "r",
		});
	});

	it("keeps an option called decline reachable, and declines by the reserved choice's position", () => {
		expect(Elicitation.read(choice, "Decline")).toEqual({
			kind: "value",
			value: "d",
		});
		expect(Elicitation.read(choice, "3")).toEqual({ kind: "decline" });
	});

	it("skips only an optional field", () => {
		const optional = { ...choice, required: false };
		expect(Elicitation.read(optional, "skip")).toEqual({ kind: "skip" });
		expect(Elicitation.read(choice, "skip").kind).toBe("invalid");
		const text = field({ ...named, required: false, type: "text" });
		expect(Elicitation.read(text, " Skip ")).toEqual({ kind: "skip" });
		// A required text field takes the word as its answer: nothing offered to skip it.
		expect(Elicitation.read({ ...text, required: true }, "skip")).toEqual({
			kind: "value",
			value: "skip",
		});
	});

	it("reads a boolean as Yes or No", () => {
		const yesNo = field({ ...named, required: true, type: "boolean" });
		expect(Elicitation.read(yesNo, "yes")).toEqual({
			kind: "value",
			value: true,
		});
		expect(Elicitation.read(yesNo, "2")).toEqual({
			kind: "value",
			value: false,
		});
		expect(Elicitation.read(yesNo, "maybe").kind).toBe("invalid");
	});

	it("validates a number, a whole number and its range", () => {
		const count = field({
			...named,
			required: true,
			type: "number",
			integer: true,
			minimum: 1,
			maximum: 9,
		});
		expect(Elicitation.read(count, "3")).toEqual({ kind: "value", value: 3 });
		// The board's form refuses each of these the same way (`FormField.read`).
		for (const given of ["three", "2.5", "12"])
			expect(Elicitation.read(count, given)).toEqual({
				kind: "invalid",
				why: "is not a whole number from 1 to 9",
			});
		const ratio = field({
			...named,
			required: true,
			type: "number",
			integer: false,
		});
		expect(Elicitation.read(ratio, "0.25")).toEqual({
			kind: "value",
			value: 0.25,
		});
	});

	it("validates text against its length and pattern", () => {
		const text = (pattern: string) =>
			field({ ...named, required: true, type: "text", maxLength: 5, pattern });
		const name = text("^[a-z]+$");
		expect(Elicitation.read(name, "abc")).toEqual({
			kind: "value",
			value: "abc",
		});
		expect(Elicitation.read(name, "abcdef").kind).toBe("invalid");
		expect(Elicitation.read(name, "ABC")).toEqual({
			kind: "invalid",
			why: "does not match ^[a-z]+$",
		});
		// The pattern is read as Unicode, as the board reads it, and one that does not compile is
		// the harness's to check: the answer is taken.
		expect(Elicitation.read(text("^\\p{L}+$"), "été")).toEqual({
			kind: "value",
			value: "été",
		});
		expect(Elicitation.read(text("("), "ABC")).toEqual({
			kind: "value",
			value: "ABC",
		});
	});

	it("reads a multi-select as the values it names, within its bounds", () => {
		const tags = field({
			...named,
			required: true,
			type: "choices",
			maxItems: 2,
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "b", label: "Beta" },
				{ value: "g", label: "Gamma, the third" },
			],
		});
		expect(Elicitation.read(tags, "Alpha, 2")).toEqual({
			kind: "value",
			value: ["a", "b"],
		});
		// A label with a comma in it is still one pick.
		expect(Elicitation.read(tags, "Gamma, the third")).toEqual({
			kind: "value",
			value: ["g"],
		});
		expect(Elicitation.read(tags, "1, 2, 3").kind).toBe("invalid");
		expect(Elicitation.read(tags, "Alpha, Delta").kind).toBe("invalid");
		expect(Elicitation.read(tags, "decline")).toEqual({ kind: "decline" });
	});

	it("keeps skip and decline out of a multi-select's choices, as words to type, and an option called decline reachable", () => {
		const tags = field({
			...named,
			required: false,
			type: "choices",
			options: [
				{ value: "a", label: "Alpha" },
				{ value: "d", label: "Decline" },
			],
		});
		const parsed = parseQuestionBody(
			Elicitation.body("claude", ASK, { field: tags }, { index: 0, total: 1 }),
		);
		expect(parsed.choices).toEqual(["Alpha", "Decline"]);
		expect(parsed.multiSelect).toBe(true);
		// What the board sends once the human, with nothing picked, types a word instead.
		expect(parsed.allowFreeform).toBe(true);
		expect(parsed.question).toContain(
			"Pick any of the choices, `skip` to leave it empty, or `decline` to decline the form.",
		);
		expect(Elicitation.read(tags, "skip")).toEqual({ kind: "skip" });
		expect(Elicitation.read(tags, " DECLINE ")).toEqual({
			kind: "value",
			value: ["d"],
		});
		// No position past the options stands for a word the choices do not list.
		expect(Elicitation.read(tags, "3").kind).toBe("invalid");
		expect(Elicitation.read(tags, "Alpha, skip").kind).toBe("invalid");
	});
});

describe("Elicitation.answer", () => {
	it("fills the choice with a pick, and its Other box with anything else", () => {
		const [store] = asked(ASK);
		expect(Elicitation.answer(store, "1")).toEqual({
			kind: "value",
			key: "question_0",
			value: "Redis",
		});
		expect(Elicitation.answer(store, " Valkey ")).toEqual({
			kind: "value",
			key: "question_0_custom",
			value: "Valkey",
		});
		expect(Elicitation.answer(store, "skip")).toEqual({ kind: "skip" });
		expect(Elicitation.answer(store, "decline")).toEqual({ kind: "decline" });
	});

	it("reads a multi-select's picks, and a typed answer into its Other box", () => {
		const [, checks] = asked(ASK_TWO);
		if (!checks) throw new Error("missing question");
		expect(Elicitation.answer(checks, "Lint, 2")).toEqual({
			kind: "value",
			key: "question_1",
			value: ["lint", "types"],
		});
		expect(Elicitation.answer(checks, "Fuzzing")).toEqual({
			kind: "value",
			key: "question_1_custom",
			value: "Fuzzing",
		});
	});

	it("asks again when a typed answer fits neither the choice nor its Other box", () => {
		const [store] = fieldsOf(ASK);
		const capped: Elicitation.Question = {
			field: store,
			other: {
				key: "question_0_custom",
				title: "Other",
				required: false,
				type: "text",
				maxLength: 3,
			},
		};
		expect(Elicitation.answer(capped, "Valkey")).toEqual({
			kind: "invalid",
			why: "names none of its choices, and as your own answer is not text of at most 3 characters",
		});
		expect(Elicitation.answer({ field: store }, "Valkey")).toEqual({
			kind: "invalid",
			why: "names none of its choices",
		});
	});
});

const session = async (): Promise<string> => {
	const task = await Planner.addTask(base, { kind: "issue", title: "sub" });
	if (!task.ok) throw task.error;
	const started = await Planner.startSession(base, {
		taskId: task.value.id,
		agent: "claude",
	});
	if (!started.ok) throw started.error;
	return started.value.id;
};

type Relayed = {
	result: Promise<Result<AcpClient.ElicitationAnswer>>;
	events: Omit<RunStore.EventDraft, "lane" | "session" | "task">[];
	stop: AbortController;
	harness: AbortController;
};

const relay = (
	sessionId: string,
	request: AcpClient.ElicitationRequest = ASK,
): Relayed => {
	const events: Relayed["events"] = [];
	const stop = new AbortController();
	const harness = new AbortController();
	const result = Elicitation.relay(
		{
			basePath: base,
			sessionId,
			harness: "claude",
			origin: "test",
			signal: stop.signal,
			emit: (e) => events.push(e),
			answeredBy: () => "cabane://actor/human/david",
			now: () => new Date(),
			pollMs: 5,
		},
		request,
		harness.signal,
	);
	return { result, events, stop, harness };
};

// The questions waiting on the session, once there are `count` of them.
const waiting = async (
	sessionId: string,
	count: number,
): Promise<AgentActivity[]> => {
	for (let i = 0; i < 200; i++) {
		const needs = await Planner.getNeedsInput(base);
		if (!needs.ok) throw needs.error;
		const rows = needs.value.flatMap((r) =>
			r.session.id === sessionId && r.question ? [r.question] : [],
		);
		if (rows.length === count) return rows;
		await Bun.sleep(5);
	}
	throw new Error(`no ${count} questions appeared`);
};

const answer = async (questionId: string, text: string) => {
	const answered = await Planner.answerQuestion(base, {
		questionId,
		answer: text,
	});
	if (!answered.ok) throw answered.error;
};

// How each question of the session was resolved, in order: [type, body] of what closes it.
const resolutions = async (sessionId: string) => {
	const activities = await Planner.getActivities(base, sessionId);
	if (!activities.ok) throw activities.error;
	return activities.value
		.filter((a) => a.type === "question")
		.map((q) =>
			activities.value
				.filter((a) => isAnswerTo(a.context, q.id))
				.map((a) => [a.type, a.body]),
		);
};

describe("Elicitation.relay", () => {
	it("asks every question at once and accepts with the fields the human answered", async () => {
		const sessionId = await session();
		const { result, events } = relay(sessionId, ASK_TWO);
		const [store, checks] = await waiting(sessionId, 2);
		if (!store || !checks) throw new Error("missing questions");

		await answer(store.id, "1");
		await answer(checks.id, "Fuzzing");
		expect(await result).toEqual({
			ok: true,
			value: {
				action: "accept",
				content: { question_0: "Redis", question_1_custom: "Fuzzing" },
			},
		});
		expect(events.map((e) => e.type)).toEqual([
			"elicitation_asked",
			"elicitation_answered",
		]);
		expect(events.at(-1)?.data).toMatchObject({
			action: "accept",
			fields: "question_0,question_1_custom",
			by: "cabane://actor/human/david",
			toolCallId: "toolu_ask_two",
		});
		const needs = await Planner.getNeedsInput(base);
		expect(needs.ok && needs.value).toEqual([]);
	});

	it("asks one AskUserQuestion question once, Other box and all, and a skip fills nothing", async () => {
		const sessionId = await session();
		const { result } = relay(sessionId);
		const [store] = await waiting(sessionId, 1);
		if (!store) throw new Error("missing question");
		await answer(store.id, "skip");
		expect(await result).toEqual({
			ok: true,
			value: { action: "accept", content: {} },
		});
		expect(await resolutions(sessionId)).toHaveLength(1);
	});

	it("declines the form when any field is declined, and closes the rest unanswered", async () => {
		const sessionId = await session();
		const { result, events } = relay(sessionId, ASK_TWO);
		const [store] = await waiting(sessionId, 2);
		if (!store) throw new Error("missing question");

		await answer(store.id, "decline");
		expect(await result).toEqual({ ok: true, value: { action: "decline" } });
		expect(await resolutions(sessionId)).toEqual([
			[["decision", "decline"]],
			[
				[
					"withdrawn",
					"withdrawn: the form was declined on another of its questions",
				],
			],
		]);
		expect(events.at(-1)?.data?.action).toBe("decline");
		const needs = await Planner.getNeedsInput(base);
		expect(needs.ok && needs.value).toEqual([]);
	});

	it("asks a field again, saying why, when the answer does not fit it", async () => {
		const sessionId = await session();
		const { result, events } = relay(sessionId, {
			message: "How many workers?",
			fields: [
				{
					key: "workers",
					title: "Workers",
					required: true,
					type: "number",
					integer: true,
					minimum: 1,
				},
			],
		});
		const [first] = await waiting(sessionId, 1);
		if (!first) throw new Error("missing question");
		await answer(first.id, "lots");
		const [second] = await waiting(sessionId, 1);
		if (!second) throw new Error("missing question");
		expect(second.id).not.toBe(first.id);
		expect(parseQuestionBody(second.body).question).toContain(
			'Asked again: "lots" is not a whole number of at least 1.',
		);
		await answer(second.id, "4");
		expect(await result).toEqual({
			ok: true,
			value: { action: "accept", content: { workers: 4 } },
		});
		expect(events.map((e) => e.type)).toEqual([
			"elicitation_asked",
			"warning",
			"elicitation_answered",
		]);
	});

	it("closes every open question as withdrawn when the harness withdraws the form", async () => {
		const sessionId = await session();
		const { result, events, harness } = relay(sessionId, ASK_TWO);
		const [store] = await waiting(sessionId, 2);
		if (!store) throw new Error("missing question");
		await answer(store.id, "Memory");
		// The answered one keeps its answer; only the other is still open.
		await waiting(sessionId, 1);

		harness.abort();
		expect((await result).ok).toBe(false);
		expect(await resolutions(sessionId)).toEqual([
			[["decision", "Memory"]],
			[["withdrawn", "withdrawn by the harness (claude)"]],
		]);
		expect(events.map((e) => e.type)).toEqual([
			"elicitation_asked",
			"elicitation_withdrawn",
		]);
		const needs = await Planner.getNeedsInput(base);
		expect(needs.ok && needs.value).toEqual([]);
	});

	it("closes its questions as withdrawn when the claim stops", async () => {
		const sessionId = await session();
		const { result, events, stop } = relay(sessionId, ASK_TWO);
		await waiting(sessionId, 2);
		stop.abort();
		expect((await result).ok).toBe(false);
		expect(await resolutions(sessionId)).toEqual([
			[["withdrawn", "withdrawn: the loop stopped this claim"]],
			[["withdrawn", "withdrawn: the loop stopped this claim"]],
		]);
		expect(events.at(-1)?.type).toBe("elicitation_cancelled");
	});

	it("stops, cancelling the form, when something outside the claim withdraws one of its questions, and reads no field from it", async () => {
		const sessionId = await session();
		const { result, events } = relay(sessionId, ASK_TWO);
		const [store] = await waiting(sessionId, 2);
		if (!store) throw new Error("missing question");
		const closed = await Planner.addActivity(base, {
			sessionId,
			type: "withdrawn",
			context: `answers ${store.id}`,
			body: "Redis",
		});
		if (!closed.ok) throw closed.error;
		const relayed = await result;
		expect(!relayed.ok && relayed.error.message).toBe(
			"withdrawn outside this claim",
		);
		expect(await resolutions(sessionId)).toEqual([
			[["withdrawn", "Redis"]],
			[["withdrawn", "withdrawn outside this claim"]],
		]);
		expect(events.map((e) => e.type)).toEqual([
			"elicitation_asked",
			"elicitation_withdrawn",
		]);
	});

	it("asks a form with no fields for a yes, and accepts it with nothing filled", async () => {
		const sessionId = await session();
		const { result } = relay(sessionId, {
			message: "Open the dashboard?",
			fields: [],
		});
		const [confirm] = await waiting(sessionId, 1);
		if (!confirm) throw new Error("missing question");
		expect(parseQuestionBody(confirm.body).choices).toEqual([
			"accept",
			"decline",
		]);
		await answer(confirm.id, "accept");
		expect(await result).toEqual({
			ok: true,
			value: { action: "accept", content: {} },
		});
	});
});
