import { describe, expect, it } from "bun:test";
import type {
	AgentActivity,
	AgentSession,
	Task,
	TaskComment,
	TaskWorkLog,
} from "@cabane/core";
import type { BoardData } from "./data";
import { DetailModel } from "./detail-model";

const task = (over: Partial<Task> = {}): Task => ({
	id: "t1",
	shortId: "CAB-1",
	title: "Render the detail as parts",
	kind: "issue",
	state: "in_progress",
	priority: "normal",
	provenance: { source: "human", discoveredAt: "2026-09-20T10:00:00.000Z" },
	tags: [],
	needsReview: false,
	createdAt: "2026-09-20T10:00:00.000Z",
	updatedAt: "2026-09-20T10:00:00.000Z",
	...over,
});

const comment = (over: Partial<TaskComment>): TaskComment => ({
	id: "c",
	taskId: "t1",
	author: "david",
	authorType: "human",
	content: "a comment",
	createdAt: "2026-09-21T10:00:00.000Z",
	...over,
});

const activity = (over: Partial<AgentActivity>): AgentActivity => ({
	id: "a",
	sessionId: "s1",
	type: "progress",
	ephemeral: false,
	body: "did a thing",
	createdAt: "2026-09-21T11:00:00.000Z",
	...over,
});

const session: AgentSession = {
	id: "s1",
	taskId: "t1",
	agent: "claude",
	state: "active",
	startedAt: "2026-09-21T09:00:00.000Z",
	lastActivityAt: "2026-09-21T12:00:00.000Z",
};

const workLog = (over: Partial<TaskWorkLog>): TaskWorkLog => ({
	id: "w",
	taskId: "t1",
	refs: [
		{
			uri: "commit:6f2a9c1d0e3b4a5f",
			addedAt: "2026-09-21T13:00:00.000Z",
		},
	],
	createdAt: "2026-09-21T13:00:00.000Z",
	...over,
});

const records = (
	over: Partial<BoardData.DetailRecords> = {},
): BoardData.DetailRecords => ({
	task: task(),
	comments: [],
	workLogs: [],
	sessions: [],
	links: [],
	neighbors: [],
	upstream: [],
	...over,
});

// A session that asked two questions and had one of them answered.
const askedTwice = (): BoardData.DetailRecords =>
	records({
		sessions: [
			{
				session,
				activities: [
					activity({
						id: "q1",
						type: "question",
						body: "Tabs or one scroll?",
						createdAt: "2026-09-21T10:00:00.000Z",
					}),
					activity({
						id: "d1",
						type: "decision",
						body: "tabs",
						context: "answers q1",
						createdAt: "2026-09-21T10:05:00.000Z",
					}),
					activity({
						id: "q2",
						type: "question",
						body: "Which tab opens first?",
						createdAt: "2026-09-21T10:10:00.000Z",
					}),
				],
			},
		],
	});

describe("openQuestions", () => {
	it("pins the questions nothing answers yet, and only those", () => {
		expect(DetailModel.openQuestions(askedTwice())).toEqual([
			{ id: "q2", question: "Which tab opens first?" },
		]);
	});

	it("adds the host's questions the records do not carry, once each", () => {
		const open = DetailModel.openQuestions(askedTwice(), [
			{
				taskId: "t1",
				sessionId: "s1",
				questionActivityId: "q2",
				question: "Which tab opens first?",
			},
			{
				taskId: "t1",
				sessionId: "s9",
				questionActivityId: "h1",
				question: "Ship it?",
			},
		]);
		expect(open.map((q) => q.id)).toEqual(["q2", "h1"]);
	});

	it("still pins the host's questions while the records load", () => {
		expect(
			DetailModel.openQuestions(undefined, [
				{
					taskId: "t1",
					sessionId: "s9",
					questionActivityId: "h1",
					question: "Ship it?",
				},
			]),
		).toEqual([{ id: "h1", question: "Ship it?" }]);
	});
});

describe("summary", () => {
	it("says the state, a priority other than normal, the kind, the assignee, and review in the accent", () => {
		expect(
			DetailModel.summary(
				task({ priority: "high", assignee: "claude", needsReview: true }),
			),
		).toEqual([
			{ text: "in progress", request: false },
			{ text: "high", request: false },
			{ text: "issue", request: false },
			{ text: "@claude", request: false },
			{ text: "needs review", request: true },
		]);
		expect(DetailModel.summary(task()).map((p) => p.text)).toEqual([
			"in progress",
			"issue",
		]);
	});
});

describe("position", () => {
	it("names the parent, each blocker with its state, what it blocks, and the linked issue", () => {
		const lines = DetailModel.position(
			records({
				task: task({ parentTaskId: "p" }),
				links: [
					{
						id: "l1",
						sourceId: "b1",
						targetId: "t1",
						type: "blocks",
						createdAt: "2026-09-20T10:00:00.000Z",
					},
					{
						id: "l2",
						sourceId: "t1",
						targetId: "d1",
						type: "blocks",
						createdAt: "2026-09-20T10:00:00.000Z",
					},
					{
						id: "l3",
						sourceId: "t1",
						targetId: "b2",
						type: "blocked_by",
						createdAt: "2026-09-20T10:00:00.000Z",
					},
				],
				neighbors: [
					task({ id: "p", shortId: "CAB-0", title: "The PRD" }),
					task({ id: "b1", shortId: "CAB-2", title: "Theme", state: "done" }),
					task({
						id: "b2",
						shortId: "CAB-3",
						title: "Surfaces",
						state: "next",
					}),
					task({ id: "d1", shortId: "CAB-4", title: "Keys" }),
				],
				upstream: [
					{
						id: "u1",
						taskId: "t1",
						provider: "linear",
						externalId: "abc",
						identifier: "DSK-12",
						url: "https://linear.app/x/issue/DSK-12",
						title: "Desk detail view",
						createdAt: "2026-09-20T10:00:00.000Z",
						updatedAt: "2026-09-20T10:00:00.000Z",
					},
				],
			}),
		);
		expect(lines).toEqual([
			{ key: "parent", value: "CAB-0 The PRD" },
			{ key: "blocked by", value: "CAB-2 done · Theme" },
			{ key: "blocked by", value: "CAB-3 next · Surfaces" },
			{ key: "blocks", value: "CAB-4 Keys" },
			{ key: "linear", value: "DSK-12 Desk detail view" },
		]);
	});

	it("says nothing for a task that sits nowhere", () => {
		expect(DetailModel.position(records())).toEqual([]);
	});
});

describe("comments", () => {
	it("keeps every comment, newest first", () => {
		const said = DetailModel.comments(
			records({
				comments: [
					comment({ id: "old", createdAt: "2026-09-20T10:00:00.000Z" }),
					comment({ id: "new", createdAt: "2026-09-22T10:00:00.000Z" }),
				],
			}),
		);
		expect(said.map((c) => c.id)).toEqual(["new", "old"]);
	});
});

describe("log", () => {
	it("puts every session activity and work log on one line, newest first, and leaves the pinned question out", () => {
		const lines = DetailModel.log(
			records({
				...askedTwice(),
				sessions: [
					{
						session,
						activities: [
							...(askedTwice().sessions[0]?.activities ?? []),
							activity({
								id: "f1",
								type: "finding",
								severity: "P2",
								body: "the bar overflows at 38 columns\nwith a long count",
								createdAt: "2026-09-21T11:00:00.000Z",
							}),
							activity({
								id: "e1",
								type: "error",
								body: "tests failed",
								createdAt: "2026-09-21T12:00:00.000Z",
							}),
						],
					},
				],
				workLogs: [workLog({ id: "w1", note: "landed the tabs" })],
			}),
		);
		expect(lines.map((l) => l.id)).toEqual(["w1", "e1", "f1", "d1", "q1"]);
		const byId = new Map(lines.map((l) => [l.id, l]));
		expect(byId.get("w1")).toMatchObject({
			glyph: "•",
			text: "commit 6f2a9c1 · landed the tabs",
		});
		expect(byId.get("f1")).toMatchObject({
			glyph: "·",
			kind: "finding P2",
			text: "the bar overflows at 38 columns",
		});
		expect(byId.get("e1")).toMatchObject({ glyph: "✗", failed: true });
		expect(byId.get("q1")).toMatchObject({ text: "Tabs or one scroll?" });
		expect(lines.some((l) => l.id === "q2")).toBe(false);
	});

	it("takes its lines from a list of sources, so another source is one more item", () => {
		const extra: DetailModel.LogSource = () => [
			{
				id: "x",
				glyph: "·",
				kind: "event",
				text: "moved to next",
				at: "2026-09-23T10:00:00.000Z",
				failed: false,
			},
		];
		const lines = DetailModel.log(
			records({ workLogs: [workLog({ id: "w1" })] }),
			[...DetailModel.LOG_SOURCES, extra],
		);
		expect(lines.map((l) => l.id)).toEqual(["x", "w1"]);
	});
});

describe("refLabel", () => {
	it("reads a work ref the way a person would", () => {
		const ref = (uri: string, label?: string) => ({
			uri,
			label,
			addedAt: "2026-09-21T13:00:00.000Z",
		});
		expect(DetailModel.refLabel(ref("commit:6f2a9c1d0e3b"))).toBe(
			"commit 6f2a9c1",
		);
		expect(DetailModel.refLabel(ref("branch:dp-jcab-89"))).toBe(
			"branch dp-jcab-89",
		);
		expect(DetailModel.refLabel(ref("url:https://example.com/a"))).toBe(
			"example.com/a",
		);
		expect(DetailModel.refLabel(ref("commit:abc", "the fix"))).toBe("the fix");
	});
});

describe("tabs and the tab bar", () => {
	it("counts what each tab holds and marks the empty ones", () => {
		expect(
			DetailModel.tabs(
				records({
					task: task({ description: "Some words." }),
					comments: [comment({ id: "c1" }), comment({ id: "c2" })],
				}),
				1,
			),
		).toEqual([
			{ tab: "description", empty: false },
			{ tab: "comments", count: 2, empty: false },
			{ tab: "log", count: 1, empty: false },
		]);
		expect(DetailModel.tabs(undefined).map((t) => t.empty)).toEqual([
			true,
			true,
			true,
		]);
	});

	it("fits forty columns whole with padded cells and full labels", () => {
		const bar = DetailModel.tabBar(
			[
				{ tab: "description", empty: false },
				{ tab: "comments", count: 12, empty: false },
				{ tab: "log", count: 140, empty: false },
			],
			40,
		);
		expect(bar.pad).toBe(1);
		expect(bar.cells.map((c) => c.text)).toEqual([
			"description",
			"comments 12",
			"log 140",
		]);
		expect(DetailModel.barWidth(bar)).toBeLessThanOrEqual(40);
	});

	it("shortens a label before it drops the padding, and never cuts one", () => {
		const summaries: DetailModel.TabSummary[] = [
			{ tab: "description", empty: false },
			{ tab: "comments", count: 3, empty: false },
			{ tab: "log", count: 9, empty: false },
		];
		const short = DetailModel.tabBar(summaries, 28);
		expect(short.cells[0]?.text).toBe("about");
		expect(short.pad).toBe(1);
		const tight = DetailModel.tabBar(summaries, 22);
		expect(tight.pad).toBe(0);
		expect(DetailModel.barWidth(tight)).toBeLessThanOrEqual(22);
	});

	it("steps through the tabs wrapping at either end, and a digit names one", () => {
		expect(DetailModel.stepTab("description", 1)).toBe("comments");
		expect(DetailModel.stepTab("description", -1)).toBe("log");
		expect(DetailModel.stepTab("log", 1)).toBe("description");
		expect(DetailModel.tabAt(1)).toBe("description");
		expect(DetailModel.tabAt(3)).toBe("log");
		expect(DetailModel.tabAt(4)).toBeUndefined();
	});
});

describe("actorName", () => {
	it("names an actor URI by its last segment and passes anything else through", () => {
		expect(DetailModel.actorName("cabane://actor/agent/claude")).toBe("claude");
		expect(DetailModel.actorName("cabane://actor/human/david-paquet")).toBe(
			"david-paquet",
		);
		expect(DetailModel.actorName("david")).toBe("david");
	});
});
