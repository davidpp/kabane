import { describe, expect, it } from "bun:test";
import type { BoardActivity } from "./activity";
import { ElicitationForm } from "./elicitation-form";
import type { BoardNav } from "./nav";
import type { ActivityCard } from "./ports";
import { ProgramStatus } from "./program-status";

const idle: ProgramStatus.Input = {
	copilot: { turn: "idle", asks: [] },
	questions: [],
	cards: [],
};

const PERMISSION: BoardNav.CopilotAsk = {
	type: "permission",
	request: { id: "t0", title: "Bash rm -rf build", options: [] },
};
const FORM: BoardNav.CopilotAsk = {
	type: "elicitation",
	request: { id: "form-1", message: "Which store?", fields: [] },
	draft: ElicitationForm.start(),
};

const question = (
	over: Partial<BoardActivity.AwaitingQuestion> = {},
): BoardActivity.AwaitingQuestion => ({
	taskId: "t1",
	taskShortId: "JREP-1",
	sessionId: "s-loop",
	questionActivityId: "q1",
	question: "Keep the old cache?",
	choices: ["Keep", "Drop"],
	multiSelect: false,
	allowFreeform: false,
	agent: "claude",
	askedAt: "2026-11-04T10:00:00.000Z",
	...over,
});

const loop = (over: Partial<ActivityCard> = {}): ActivityCard => ({
	id: "loop:r1",
	kind: "loops",
	label: "loop",
	status: "running",
	taskShortId: "JREP-1",
	startedAt: "2026-11-04T10:00:00.000Z",
	detail: [],
	sessionIds: ["s-loop"],
	...over,
});

const LOOP_ID = ProgramStatus.recordId("loop:r1");

describe("ProgramStatus.reports", () => {
	it("says nothing while nothing runs or waits", () => {
		expect(ProgramStatus.reports(idle)).toEqual(new Map());
		expect(
			ProgramStatus.reports({
				...idle,
				cards: [loop({ status: "completed" })],
			}),
		).toEqual(new Map());
	});

	it("a copilot permission blocks the board on a permission, with the request as the copilot's record", () => {
		const reports = ProgramStatus.reports({
			...idle,
			copilot: { turn: "running", asks: [PERMISSION] },
		});
		expect([...reports]).toEqual([
			[
				ProgramStatus.ROOT,
				{
					state: "blocked",
					kind: "permission",
					app: "kabane",
					message: "1 needs input",
				},
			],
			[
				"copilot",
				{
					state: "blocked",
					kind: "permission",
					id: "copilot",
					app: "kabane",
					title: "copilot",
					message: "Bash rm -rf build",
				},
			],
		]);
	});

	it("a form and a session question are questions; a mix of kinds names none", () => {
		const forms = ProgramStatus.reports({
			...idle,
			copilot: { turn: "running", asks: [FORM] },
			questions: [question()],
		});
		expect(forms.get(ProgramStatus.ROOT)).toMatchObject({
			state: "blocked",
			kind: "question",
			message: "2 need input",
		});
		const mixed = ProgramStatus.reports({
			...idle,
			copilot: { turn: "running", asks: [PERMISSION, FORM] },
		});
		expect(mixed.get(ProgramStatus.ROOT)).not.toHaveProperty("kind");
		expect(mixed.get("copilot")).toMatchObject({ message: "2 need input" });
	});

	it("a card's question blocks its own record; a question no card owns counts at the root only", () => {
		const reports = ProgramStatus.reports({
			...idle,
			questions: [
				question({ permission: true }),
				question({ questionActivityId: "q2", sessionId: "s-other" }),
			],
			cards: [loop()],
		});
		expect([...reports.keys()]).toEqual([ProgramStatus.ROOT, LOOP_ID]);
		expect(reports.get(ProgramStatus.ROOT)).toMatchObject({
			message: "2 need input",
		});
		expect(reports.get(LOOP_ID)).toEqual({
			state: "blocked",
			kind: "permission",
			id: LOOP_ID,
			app: "kabane",
			title: "loop JREP-1",
			message: "Keep the old cache?",
		});
	});

	it("working while a copilot turn or a host card runs, and a stale or paused card is not working", () => {
		const one = ProgramStatus.reports({
			...idle,
			copilot: { turn: "running", asks: [] },
		});
		expect(one.get(ProgramStatus.ROOT)).toEqual({
			state: "working",
			app: "kabane",
			message: "copilot working",
		});
		const two = ProgramStatus.reports({
			...idle,
			copilot: { turn: "running", asks: [] },
			cards: [
				loop(),
				loop({ id: "loop:r2", stale: true }),
				loop({ id: "p", status: "paused" }),
			],
		});
		expect(two.get(ProgramStatus.ROOT)).toMatchObject({
			message: "2 working",
		});
		expect([...two.keys()]).toEqual([ProgramStatus.ROOT, "copilot", LOOP_ID]);
	});

	it("clips a record's text to one line inside its budget", () => {
		const reports = ProgramStatus.reports({
			...idle,
			copilot: {
				turn: "running",
				asks: [
					{
						...FORM,
						request: {
							...FORM.request,
							message: `Pick\none\t${"é".repeat(3000)}`,
						},
					},
				],
			},
		});
		const message = reports.get("copilot");
		const text = message && "message" in message ? (message.message ?? "") : "";
		expect(text.startsWith("Pick one é")).toBe(true);
		expect(text.endsWith("…")).toBe(true);
		expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(2048);
	});
});

describe("ProgramStatus.recordId", () => {
	it("keeps an id the protocol takes, and hashes one it does not, the same way every time", () => {
		expect(ProgramStatus.recordId("copilot")).toBe("copilot");
		expect(LOOP_ID).toMatch(/^card_[0-9a-f]{16}$/);
		expect(ProgramStatus.recordId("loop:r1")).toBe(LOOP_ID);
		expect(ProgramStatus.recordId("x".repeat(33))).toMatch(/^card_/);
	});
});

describe("ProgramStatus.changes", () => {
	const sentOf = (reports: ReadonlyMap<string, unknown>) =>
		new Map([...reports].map(([key, report]) => [key, JSON.stringify(report)]));

	it("writes only what changed, and nothing when nothing moved", () => {
		const waiting = ProgramStatus.reports({
			...idle,
			copilot: { turn: "running", asks: [PERMISSION] },
		});
		expect(ProgramStatus.changes(new Map(), waiting)).toHaveLength(2);
		expect(ProgramStatus.changes(sentOf(waiting), waiting)).toEqual([]);
	});

	it("clears a record that went, children before the root", () => {
		const waiting = ProgramStatus.reports({
			...idle,
			copilot: { turn: "running", asks: [PERMISSION] },
		});
		expect(ProgramStatus.changes(sentOf(waiting), new Map())).toEqual([
			{ key: "copilot", report: { state: "clear", id: "copilot" } },
			{ key: ProgramStatus.ROOT, report: { state: "clear" } },
		]);
	});
});
