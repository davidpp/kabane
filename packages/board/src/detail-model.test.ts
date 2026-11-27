import { describe, expect, it } from "bun:test";
import type {
	EntryKind,
	Task,
	TaskEntry,
	TaskLink,
	TaskWorkLog,
	UpstreamLink,
} from "@kabane/core";
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

const entry = (over: Partial<TaskEntry>): TaskEntry => ({
	id: "c",
	taskId: "t1",
	kind: "comment",
	author: "david",
	authorType: "human",
	content: "a comment",
	createdAt: "2026-09-21T10:00:00.000Z",
	...over,
});

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
	entries: [],
	kinds: [],
	workLogs: [],
	links: [],
	neighbors: [],
	upstream: [],
	subtasks: [],
	contextRefs: [],
	questions: [],
	checklist: [],
	kindLabel: over.task?.kind ?? "issue",
	attributes: [],
	...over,
});

const awaiting = (id = "q2", question = "Which tab opens first?") => ({
	taskId: "t1",
	cardId: "s1",
	id,
	question,
	taskShortId: "MILL-1",
	choices: [],
	multiSelect: false,
	allowFreeform: true,
	agent: "claude",
	askedAt: "2026-10-10T00:00:00.000Z",
});

describe("openQuestions", () => {
	it("has no questions without the host's queue", () => {
		expect(DetailModel.openQuestions()).toEqual([]);
	});
	it("stops pinning a question when the host removes it from awaiting", () => {
		const first = awaiting();
		const second = awaiting("h1", "Ship it?");
		expect(DetailModel.openQuestions([first, second])).toEqual([
			{ id: "q2", question: first.question },
			{ id: "h1", question: second.question },
		]);
		expect(DetailModel.openQuestions([second])).toEqual([
			{ id: "h1", question: second.question },
		]);
	});
	it("adds the host's questions once each", () => {
		const first = awaiting();
		const second = awaiting("h1", "Ship it?");
		expect(
			DetailModel.openQuestions([first, second, first, second]).map(
				(q) => q.id,
			),
		).toEqual(["q2", "h1"]);
	});
	it("pins the host's questions without needing records", () => {
		expect(DetailModel.openQuestions([awaiting("h1", "Ship it?")])).toEqual([
			{ id: "h1", question: "Ship it?" },
		]);
	});
	it("leaves the question pinned in a banner over the view to the banner", () => {
		expect(
			DetailModel.openQuestions([awaiting(), awaiting("h1", "Ship it?")], "q2"),
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

const link = (
	id: string,
	sourceId: string,
	type: TaskLink["type"],
	targetId: string,
): TaskLink => ({
	id,
	sourceId,
	targetId,
	type,
	createdAt: "2026-09-20T10:00:00.000Z",
});

const linear = (identifier: string, provider = "linear"): UpstreamLink => ({
	id: `u-${identifier}`,
	taskId: "t1",
	provider,
	externalId: identifier.toLowerCase(),
	identifier,
	url: `https://linear.app/x/issue/${identifier}`,
	title: "Desk detail view",
	createdAt: "2026-09-20T10:00:00.000Z",
	updatedAt: "2026-09-20T10:00:00.000Z",
});

const neighbor = (id: string, state: Task["state"] = "next"): Task =>
	task({ id, shortId: id.toUpperCase(), title: `Issue ${id}`, state });

describe("relations", () => {
	// Every link type, from both of its ends: the group the other end lands in, read from t1's side.
	const groupsOf = (...links: TaskLink[]) =>
		DetailModel.relations(
			records({
				links,
				neighbors: [
					"a",
					"b",
					"c",
					"d",
					"e",
					"f",
					"g",
					"h",
					"i",
					"j",
					"k",
					"l",
					"m",
				].map((id) => neighbor(id)),
			}),
		).map((group) => [group.name, group.lines.map((line) => line.id)]);

	it("reads every link type in its direction, as the agent brief's Position section does", () => {
		expect(
			groupsOf(
				link("1", "a", "parent", "t1"),
				link("2", "t1", "parent", "b"),
				link("3", "t1", "child", "c"),
				link("4", "d", "child", "t1"),
				link("5", "e", "blocks", "t1"),
				link("6", "t1", "blocked_by", "f"),
				link("7", "t1", "blocks", "g"),
				link("8", "h", "blocked_by", "t1"),
				link("9", "t1", "follows", "i"),
				link("10", "j", "follows", "t1"),
				link("11", "k", "related", "t1"),
				link("12", "t1", "duplicate", "l"),
				link("13", "m", "duplicate", "t1"),
			),
		).toEqual([
			["parent", ["a", "c"]],
			["subtask", ["b", "d"]],
			["blocked by", ["e", "f"]],
			["blocks", ["g", "h"]],
			["follows", ["i"]],
			["followed by", ["j"]],
			["related", ["k"]],
			["duplicate of", ["l"]],
			["duplicated by", ["m"]],
		]);
	});

	it("lists the parent field as the parent, an issue once per group, and no child already a subtask", () => {
		const groups = DetailModel.relations(
			records({
				task: task({ parentTaskId: "p" }),
				links: [
					link("1", "t1", "child", "p"),
					link("2", "t1", "blocks", "a"),
					link("3", "a", "blocked_by", "t1"),
					link("4", "t1", "parent", "s"),
				],
				neighbors: [neighbor("p"), neighbor("a"), neighbor("s")],
				subtasks: [task({ id: "s", parentTaskId: "t1" })],
			}),
		);
		expect(
			groups.map((group) => [group.name, group.lines.map((l) => l.id)]),
		).toEqual([
			["parent", ["p"]],
			["blocks", ["a"]],
		]);
	});

	it("draws a linked issue as a subtask row, and one missing from the records as its id and unknown", () => {
		const [group] = DetailModel.relations(
			records({
				links: [
					link("1", "t1", "related", "a"),
					link("2", "t1", "related", "01HMISSING000000000000000"),
					link("3", "t1", "related", "c"),
				],
				neighbors: [neighbor("a", "done"), neighbor("c", "cancelled")],
			}),
		);
		expect(group?.lines).toEqual([
			{
				id: "a",
				key: "link:related:a",
				shortId: "A",
				title: "Issue a",
				done: true,
				cancelled: false,
				state: undefined,
				known: true,
			},
			{
				id: "01HMISSING000000000000000",
				key: "link:related:01HMISSING000000000000000",
				shortId: "01HMISSI",
				title: "",
				done: false,
				cancelled: false,
				state: "unknown",
				known: false,
			},
			{
				id: "c",
				key: "link:related:c",
				shortId: "C",
				title: "Issue c",
				done: false,
				cancelled: true,
				state: "cancelled",
				known: true,
			},
		]);
	});

	it("is the last block on now, external issues included, and absent with no links", () => {
		const block = DetailModel.now(
			records({
				links: [link("1", "t1", "related", "a")],
				neighbors: [neighbor("a")],
				upstream: [linear("DSK-12")],
			}),
		).at(-1);
		expect(block?.name).toBe("links");
		expect(block && "upstream" in block ? block.upstream : []).toEqual([
			{
				id: "u-DSK-12",
				provider: "linear",
				identifier: "DSK-12",
				title: "Desk detail view",
			},
		]);
		expect(DetailModel.now(records()).map((b) => b.name)).toEqual([]);
	});

	it("opens nothing on its own: links alone leave the detail opening on the description", () => {
		const linked = records({
			links: [link("1", "t1", "related", "a")],
			neighbors: [neighbor("a")],
		});
		expect(DetailModel.openingTab(linked)).toBe("description");
		expect(DetailModel.tabs(linked)[0]).toEqual({ tab: "now", empty: false });
	});

	it("gives the cursor the subtasks, then each linked issue the records carry, never an unknown or external one", () => {
		expect(
			DetailModel.openable(
				records({
					task: task({ parentTaskId: "p" }),
					links: [
						link("1", "t1", "blocks", "a"),
						link("2", "t1", "related", "01HMISSING000000000000000"),
					],
					neighbors: [neighbor("p"), neighbor("a")],
					subtasks: [task({ id: "s", parentTaskId: "t1" })],
					upstream: [linear("DSK-12")],
				}),
			),
		).toEqual([
			{ key: "subtask:s", taskId: "s" },
			{ key: "link:parent:p", taskId: "p" },
			{ key: "link:blocks:a", taskId: "a" },
		]);
	});
});

describe("trail", () => {
	it("leads with the parent and each open blocker with its state, then counts the rest", () => {
		const parts = DetailModel.trail(
			records({
				task: task({ parentTaskId: "p" }),
				links: [
					link("1", "b1", "blocks", "t1"),
					link("2", "t1", "blocked_by", "b2"),
					link("3", "t1", "follows", "b3"),
					link("4", "t1", "blocked_by", "b4"),
					link("5", "t1", "blocked_by", "01HMISSING000000000000000"),
					link("6", "t1", "blocks", "d1"),
					link("7", "d2", "follows", "t1"),
					link("8", "t1", "related", "r1"),
					link("9", "t1", "duplicate", "x1"),
					link("10", "t1", "parent", "s1"),
				],
				neighbors: [
					neighbor("p"),
					neighbor("b1", "done"),
					neighbor("b2", "in_progress"),
					neighbor("b3", "next"),
					neighbor("b4", "cancelled"),
					neighbor("d1"),
					neighbor("d2"),
					neighbor("r1"),
					neighbor("x1"),
					neighbor("s1"),
				],
				upstream: [linear("DSK-12"), linear("DSK-13"), linear("42", "github")],
			}),
		);
		expect(parts).toEqual([
			{ kind: "parent", shortId: "P", taskId: "p" },
			{ kind: "blocker", shortId: "B2", state: "in progress", taskId: "b2" },
			{ kind: "blocker", shortId: "B3", state: "next", taskId: "b3" },
			{ kind: "count", label: "blocked by", count: 3, target: "links" },
			{ kind: "count", label: "blocks", count: 2, target: "links" },
			{ kind: "count", label: "related", count: 1, target: "links" },
			{ kind: "count", label: "duplicate", count: 1, target: "links" },
			{ kind: "count", label: "◆ linear", count: 2, target: "links" },
			{ kind: "count", label: "◆ github", count: 1, target: "links" },
		]);
		expect(parts.map(DetailModel.partText).join(DetailModel.TRAIL_SEP)).toBe(
			"↑ P · ⊘ B2 in progress · ⊘ B3 next · blocked by 3 · blocks 2 · related 1 · duplicate 1 · ◆ linear 2 · ◆ github 1",
		);
	});

	it("has a parent missing from the records, with nothing to open, and no subtasks", () => {
		expect(
			DetailModel.trail(
				records({
					task: task({ parentTaskId: "01HGONE00000000000000000" }),
					subtasks: [task({ id: "s", parentTaskId: "t1" })],
				}),
			),
		).toEqual([{ kind: "parent", shortId: "01HGONE0" }]);
	});

	it("is empty for a task that sits nowhere", () => {
		expect(DetailModel.trail(records())).toEqual([]);
	});

	it("keeps whole parts at forty columns, the parent and open blockers first, and says the rest with `…`", () => {
		const parts = DetailModel.trail(
			records({
				task: task({ parentTaskId: "p" }),
				links: [
					link("1", "t1", "blocked_by", "b"),
					link("2", "t1", "blocks", "d1"),
					link("3", "t1", "blocks", "d2"),
					link("4", "t1", "blocks", "d3"),
				],
				neighbors: [
					task({ id: "p", shortId: "JCAB-229" }),
					task({ id: "b", shortId: "JCAB-228", state: "in_progress" }),
					neighbor("d1"),
					neighbor("d2"),
					neighbor("d3"),
				],
			}),
		);
		// The header's room at forty columns: its padding takes two.
		const at40 = DetailModel.fitTrail(parts, 38);
		expect(at40.parts.map(DetailModel.partText)).toEqual([
			"↑ JCAB-229",
			"⊘ JCAB-228 in progress",
		]);
		expect(at40.more).toBe(true);
		expect(DetailModel.fitTrail(parts, 98)).toEqual({ parts, more: false });
		// Too tight for the `…`: a count gives way to it, the parent and a blocker never do.
		const related: DetailModel.TrailPart = {
			kind: "count",
			label: "related",
			count: 1,
			target: "links",
		};
		const counted = DetailModel.fitTrail([...parts, related], 47);
		expect(counted).toEqual({ parts: parts.slice(0, 2), more: true });
		expect(DetailModel.fitTrail(parts, 35)).toEqual({
			parts: parts.slice(0, 2),
			more: true,
		});
	});
});

describe("timeline", () => {
	it("keeps every entry, newest first, typed ones and lifted ones too", () => {
		const said = DetailModel.timeline(
			records({
				entries: [
					entry({ id: "old", createdAt: "2026-09-20T10:00:00.000Z" }),
					entry({
						id: "handoff",
						kind: "handoff",
						createdAt: "2026-09-21T10:00:00.000Z",
					}),
					entry({ id: "new", createdAt: "2026-09-22T10:00:00.000Z" }),
				],
			}),
		);
		expect(said.map((e) => e.id)).toEqual(["new", "handoff", "old"]);
	});

	it("puts the higher id first when two entries share a millisecond, as the lifted block does", () => {
		const tied = records({
			kinds: [
				{
					name: "handoff",
					title: "Handoff",
					template: "",
					projection: { latest: { after: "description", framing: "f" } },
				},
			],
			entries: [
				entry({ id: "01A", kind: "handoff", content: "first" }),
				entry({ id: "01B", kind: "handoff", content: "second" }),
			],
		});
		expect(DetailModel.timeline(tied).map((e) => e.content)).toEqual([
			"second",
			"first",
		]);
		expect(DetailModel.lifted(tied)[0]?.body).toBe("second");
	});

	it("labels an entry with its kind, declared or not, and a plain comment with none", () => {
		expect(DetailModel.kindLabel(entry({ kind: "handoff" }))).toBe("handoff");
		expect(DetailModel.kindLabel(entry({ kind: "review" }))).toBe("review");
		expect(DetailModel.kindLabel(entry({}))).toBeUndefined();
	});
});

describe("lifted", () => {
	const latest = (
		name: string,
		after: "description" | "discussion",
	): EntryKind => ({
		name,
		title: name === "handoff" ? "Handoff" : "Verdict",
		template: "",
		projection: { latest: { after, framing: `What a ${name} is.` } },
	});
	const HANDOFF = latest("handoff", "description");
	const at = (hour: number) => `2026-09-21T${hour}:00:00.000Z`;

	it("lifts each latest kind's newest entry, counting the older ones, by the brief's anchors", () => {
		const lifted = DetailModel.lifted(
			records({
				kinds: [
					latest("verdict", "discussion"),
					HANDOFF,
					{ ...latest("review", "discussion"), projection: "discussion" },
				],
				entries: [
					entry({ id: "h1", kind: "handoff", createdAt: at(10) }),
					entry({ id: "v1", kind: "verdict", createdAt: at(11) }),
					entry({ id: "r1", kind: "review", createdAt: at(12) }),
					entry({
						id: "h2",
						kind: "handoff",
						author: "kabane://actor/agent/claude",
						content: "  the newer one\n",
						createdAt: at(13),
					}),
					entry({ id: "c1", createdAt: at(14) }),
				],
			}),
		);
		expect(lifted).toEqual([
			{
				id: "h2",
				kind: "handoff",
				title: "Handoff",
				framing: "What a handoff is.",
				author: "claude",
				at: at(13),
				body: "the newer one",
				earlier: 1,
			},
			{
				id: "v1",
				kind: "verdict",
				title: "Verdict",
				framing: "What a verdict is.",
				author: "david",
				at: at(11),
				body: "a comment",
				earlier: 0,
			},
		]);
	});

	it("lifts nothing for a kind no entry has, or when no module declares a latest kind", () => {
		expect(DetailModel.lifted(records({ kinds: [HANDOFF] }))).toEqual([]);
		expect(
			DetailModel.lifted(
				records({ entries: [entry({ kind: "handoff", createdAt: at(10) })] }),
			),
		).toEqual([]);
	});

	it("counts a lifted entry as the now tab's content, never the description's", () => {
		const handedOff = records({
			task: task({ description: undefined }),
			kinds: [HANDOFF],
			entries: [entry({ kind: "handoff" })],
		});
		expect(DetailModel.tabs(handedOff).slice(0, 2)).toEqual([
			{ tab: "now", empty: false },
			{ tab: "description", empty: true },
		]);
		expect(
			DetailModel.tabs(records({ entries: [entry({ kind: "handoff" })] }))[0],
		).toEqual({ tab: "now", empty: true });
	});
});

describe("log", () => {
	it("puts every work log on one line, newest first, a session ref under its label", () => {
		const lines = DetailModel.log(
			records({
				workLogs: [
					workLog({
						id: "01S1",
						refs: [
							{
								uri: "session:01S1",
								label: "claude",
								addedAt: "2026-09-21T09:00:00.000Z",
							},
						],
						createdAt: "2026-09-21T09:00:00.000Z",
					}),
					workLog({ id: "w1", note: "landed the tabs" }),
				],
			}),
		);
		expect(lines).toEqual([
			{
				id: "w1",
				glyph: "•",
				kind: "",
				text: "commit 6f2a9c1 · landed the tabs",
				at: "2026-09-21T13:00:00.000Z",
				failed: false,
			},
			{
				id: "01S1",
				glyph: "•",
				kind: "",
				text: "claude",
				at: "2026-09-21T09:00:00.000Z",
				failed: false,
			},
		]);
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
					entries: [entry({ id: "c1" }), entry({ id: "c2" })],
				}),
				1,
			),
		).toEqual([
			{ tab: "now", empty: true },
			{ tab: "description", empty: false },
			{ tab: "comments", count: 2, empty: false },
			{ tab: "log", count: 1, empty: false },
		]);
		expect(DetailModel.tabs(undefined).map((t) => t.empty)).toEqual([
			true,
			true,
			true,
			true,
		]);
	});

	it("fits forty columns whole with padded cells and full labels", () => {
		const bar = DetailModel.tabBar(
			[
				{ tab: "now", empty: false },
				{ tab: "description", empty: false },
				{ tab: "comments", count: 12, empty: false },
				{ tab: "log", count: 140, empty: false },
			],
			40,
		);
		expect(bar.pad).toBe(1);
		expect(bar.cells.map((c) => c.text)).toEqual([
			"now",
			"description",
			"comments 12",
			"log 140",
		]);
		expect(DetailModel.barWidth(bar)).toBeLessThanOrEqual(40);
	});

	it("shortens a label before it drops the padding, and never cuts one", () => {
		const summaries: DetailModel.TabSummary[] = [
			{ tab: "now", empty: false },
			{ tab: "description", empty: false },
			{ tab: "comments", count: 3, empty: false },
			{ tab: "log", count: 9, empty: false },
		];
		const short = DetailModel.tabBar(summaries, 33);
		expect(short.cells[1]?.text).toBe("about");
		expect(short.pad).toBe(1);
		const tight = DetailModel.tabBar(summaries, 26);
		expect(tight.pad).toBe(0);
		expect(DetailModel.barWidth(tight)).toBeLessThanOrEqual(26);
	});

	it("steps through the tabs wrapping at either end, and a digit names one", () => {
		expect(DetailModel.stepTab("now", 1)).toBe("description");
		expect(DetailModel.stepTab("now", -1)).toBe("log");
		expect(DetailModel.stepTab("log", 1)).toBe("now");
		expect(DetailModel.tabAt(1)).toBe("now");
		expect(DetailModel.tabAt(2)).toBe("description");
		expect(DetailModel.tabAt(4)).toBe("log");
		expect(DetailModel.tabAt(5)).toBeUndefined();
	});
});

describe("actorName", () => {
	it("names an actor URI by its last segment and passes anything else through", () => {
		expect(DetailModel.actorName("kabane://actor/agent/claude")).toBe("claude");
		expect(DetailModel.actorName("kabane://actor/human/david-paquet")).toBe(
			"david-paquet",
		);
		expect(DetailModel.actorName("david")).toBe("david");
	});
});

describe("subtasks and curated context", () => {
	const child = (id: string, state: Task["state"], title: string): Task =>
		task({ id, shortId: id.toUpperCase(), state, title, parentTaskId: "t1" });

	it("each subtask says whether it is done, names an open one's state, and keeps a cancelled one", () => {
		const lines = DetailModel.subtasks(
			records({
				subtasks: [
					child("c-1", "done", "Shipped"),
					child("c-2", "in_progress", "Working"),
					child("c-3", "cancelled", "Dropped"),
				],
			}),
		);
		expect(
			lines.map(({ shortId, done, cancelled, state }) => ({
				shortId,
				done,
				cancelled,
				state,
			})),
		).toEqual([
			{ shortId: "C-1", done: true, cancelled: false, state: undefined },
			{ shortId: "C-2", done: false, cancelled: false, state: "in progress" },
			{ shortId: "C-3", done: false, cancelled: true, state: "cancelled" },
		]);
	});

	it("a context ref reads as its kind, its label and its ref, never its content", () => {
		const lines = DetailModel.contextRefs(
			records({
				contextRefs: [
					{
						id: "r1",
						taskId: "t1",
						uri: "obsidian:prds/kabane.md",
						kind: "PRD",
						label: " Kabane PRD ",
						addedAt: "2026-09-20T10:00:00.000Z",
					},
					{
						id: "r2",
						taskId: "t1",
						uri: "docs/research/ai-in-the-tui.md",
						kind: "research",
						label: "",
						addedAt: "2026-09-21T10:00:00.000Z",
					},
				],
			}),
		);
		expect(lines).toEqual([
			{
				id: "r1",
				kind: "PRD",
				label: "Kabane PRD",
				uri: "obsidian:prds/kabane.md",
			},
			{
				id: "r2",
				kind: "research",
				label: undefined,
				uri: "docs/research/ai-in-the-tui.md",
			},
		]);
	});

	it("subtasks fill the now tab and curated context the description", () => {
		const bare = records({ task: task({ description: undefined }) });
		const empty = (r: BoardData.DetailRecords) =>
			DetailModel.tabs(r)
				.slice(0, 2)
				.map((t) => t.empty);
		expect(empty(bare)).toEqual([true, true]);
		expect(empty({ ...bare, subtasks: [child("c-1", "next", "one")] })).toEqual(
			[false, true],
		);
		expect(
			empty({
				...bare,
				contextRefs: [
					{
						id: "r1",
						taskId: "t1",
						uri: "docs/a.md",
						kind: "doc",
						addedAt: "2026-09-20T10:00:00.000Z",
					},
				],
			}),
		).toEqual([true, false]);
	});
});

describe("the now tab", () => {
	const HANDOFF: EntryKind = {
		name: "handoff",
		title: "Handoff",
		template: "",
		projection: { latest: { after: "description", framing: "f" } },
	};
	const item = (id: string): BoardData.DetailRecords["checklist"][number] => ({
		id,
		taskId: "t1",
		text: "a step",
		done: false,
		rank: "a",
		createdAt: "2026-09-20T10:00:00.000Z",
		updatedAt: "2026-09-20T10:00:00.000Z",
		updatedBy: "david",
		version: 1,
		visibility: "shared",
		handle: "CAB-1.1",
		ordinal: 1,
	});

	it("holds the checklist, the subtasks, then each lifted kind by name, each block named and the empty ones left out", () => {
		const blocks = DetailModel.now(
			records({
				checklist: [item("k1")],
				kinds: [HANDOFF],
				entries: [entry({ id: "h1", kind: "handoff" })],
				subtasks: [task({ id: "c1", parentTaskId: "t1" })],
			}),
		);
		// The checklist and the subtasks first, so they stay above the lifted entry however long it is.
		expect(blocks.map((b) => b.name)).toEqual([
			"checklist",
			"subtasks",
			"lifted:handoff",
		]);
		expect(DetailModel.now(records())).toEqual([]);
	});

	it("opens on now when anything is in force, otherwise on the description", () => {
		expect(DetailModel.openingTab(records({ checklist: [item("k1")] }))).toBe(
			"now",
		);
		expect(
			DetailModel.openingTab(
				records({ task: task({ description: "Only the ask." }) }),
			),
		).toBe("description");
	});
});

describe("what changed between two reads", () => {
	const HANDOFF: EntryKind = {
		name: "handoff",
		title: "Handoff",
		template: "",
		projection: { latest: { after: "description", framing: "f" } },
	};
	const item = (
		id: string,
		over: Partial<BoardData.DetailRecords["checklist"][number]> = {},
	): BoardData.DetailRecords["checklist"][number] => ({
		id,
		taskId: "t1",
		text: "a step",
		done: false,
		rank: "a",
		createdAt: "2026-09-20T10:00:00.000Z",
		updatedAt: "2026-09-20T10:00:00.000Z",
		updatedBy: "david",
		version: 1,
		visibility: "shared",
		handle: "CAB-1.1",
		ordinal: 1,
		...over,
	});
	const question = (
		id: string,
		status: "open" | "answered",
	): BoardData.DetailRecords["questions"][number] => ({
		id,
		taskId: "t1",
		status,
		askedBy: "claude",
		createdAt: "2026-09-20T10:00:00.000Z",
		updatedAt: "2026-09-20T10:00:00.000Z",
		updatedBy: "claude",
		version: 1,
		visibility: "shared",
		body: "Tabs or one scroll?",
		...(status === "answered" ? { answer: "tabs", answeredBy: "david" } : {}),
		handle: "CAB-1:1",
		ordinal: 1,
		title: "Render the detail as parts",
		priority: "normal",
		state: "in_progress",
	});
	const NONE: DetailModel.OwnWrites = {
		ticked: new Map(),
		answered: new Set(),
	};
	const base = records({
		checklist: [item("k1"), item("k2")],
		kinds: [HANDOFF],
		entries: [entry({ id: "h1", kind: "handoff" })],
		questions: [question("q1", "answered"), question("q2", "open")],
		subtasks: [task({ id: "c1", parentTaskId: "t1", state: "next" })],
	});

	it("names nothing when the records read the same", () => {
		expect(DetailModel.changed(base, { ...base }, NONE)).toEqual([]);
	});

	it("names the lifted kind whose newest entry is another one, and not for a plain comment", () => {
		const handedOff = {
			...base,
			entries: [...base.entries, entry({ id: "h2", kind: "handoff" })],
		};
		expect(DetailModel.changed(base, handedOff, NONE)).toEqual([
			"lifted:handoff",
		]);
		const commented = {
			...base,
			entries: [...base.entries, entry({ id: "c9" })],
		};
		expect(DetailModel.changed(base, commented, NONE)).toEqual([]);
	});

	it("names the checklist when an item is ticked, added, removed or reworded elsewhere", () => {
		const tick = {
			...base,
			checklist: [item("k1", { done: true }), item("k2")],
		};
		const added = { ...base, checklist: [...base.checklist, item("k3")] };
		const removed = { ...base, checklist: [item("k2")] };
		const reworded = {
			...base,
			checklist: [item("k1", { text: "another step" }), item("k2")],
		};
		for (const after of [tick, added, removed, reworded])
			expect(DetailModel.changed(base, after, NONE)).toEqual(["checklist"]);
	});

	it("does not name a tick or an answer this board wrote itself", () => {
		const tick = {
			...base,
			checklist: [item("k1", { done: true }), item("k2")],
		};
		expect(
			DetailModel.changed(base, tick, {
				ticked: new Map([["k1", true]]),
				answered: new Set(),
			}),
		).toEqual([]);
		const answered = {
			...base,
			questions: [question("q1", "answered"), question("q2", "answered")],
		};
		expect(DetailModel.changed(base, answered, NONE)).toEqual(["decisions"]);
		expect(
			DetailModel.changed(base, answered, {
				ticked: new Map(),
				answered: new Set(["q2"]),
			}),
		).toEqual([]);
	});

	it("names the subtasks when one changes state or is filed, and a first block that appears", () => {
		const moved = {
			...base,
			subtasks: [task({ id: "c1", parentTaskId: "t1", state: "done" })],
		};
		expect(DetailModel.changed(base, moved, NONE)).toEqual(["subtasks"]);
		const empty = records();
		expect(
			DetailModel.changed(empty, records({ checklist: [item("k1")] }), NONE),
		).toEqual(["checklist"]);
	});

	it("names the subtasks when one is renamed", () => {
		const renamed = {
			...base,
			subtasks: [
				task({ id: "c1", parentTaskId: "t1", state: "next", title: "Renamed" }),
			],
		};
		expect(DetailModel.changed(base, renamed, NONE)).toEqual(["subtasks"]);
	});

	it("names the links when one is made or removed, or a linked issue changes state or title", () => {
		const linked = {
			...base,
			links: [link("l1", "t1", "blocked_by", "b")],
			neighbors: [neighbor("b", "in_progress")],
		};
		expect(DetailModel.changed(linked, { ...linked }, NONE)).toEqual([]);
		expect(DetailModel.changed(base, linked, NONE)).toEqual(["links"]);
		const another = {
			...linked,
			links: [...linked.links, link("l2", "t1", "related", "r")],
			neighbors: [...linked.neighbors, neighbor("r")],
		};
		expect(DetailModel.changed(linked, another, NONE)).toEqual(["links"]);
		const cleared = { ...linked, neighbors: [neighbor("b", "done")] };
		expect(DetailModel.changed(linked, cleared, NONE)).toEqual(["links"]);
		const renamed = {
			...linked,
			neighbors: [{ ...neighbor("b", "in_progress"), title: "Renamed" }],
		};
		expect(DetailModel.changed(linked, renamed, NONE)).toEqual(["links"]);
		const external = { ...linked, upstream: [linear("DSK-12")] };
		expect(DetailModel.changed(linked, external, NONE)).toEqual(["links"]);
		// Removing the last link leaves no block to mark.
		expect(DetailModel.changed(linked, base, NONE)).toEqual([]);
	});

	it("names the decisions when one made is withdrawn or removed, while others stand", () => {
		const two = {
			...base,
			questions: [question("q1", "answered"), question("q3", "answered")],
		};
		const withdrawn = {
			...two,
			questions: [
				question("q1", "answered"),
				{ ...question("q3", "answered"), status: "withdrawn" as const },
			],
		};
		const removed = { ...two, questions: [question("q1", "answered")] };
		expect(DetailModel.changed(two, withdrawn, NONE)).toEqual(["decisions"]);
		expect(DetailModel.changed(two, removed, NONE)).toEqual(["decisions"]);
	});

	it("never names a block that is gone", () => {
		expect(DetailModel.changed(base, { ...base, checklist: [] }, NONE)).toEqual(
			[],
		);
	});

	it("marks the now tab in the bar, which still fits forty columns", () => {
		const summaries = DetailModel.tabs(
			records({ entries: [entry({ id: "c1" })] }),
			3,
			true,
		);
		expect(summaries[0]).toEqual({ tab: "now", empty: true, fresh: true });
		const bar = DetailModel.tabBar(summaries, 40);
		expect(bar.cells[0]?.fresh).toBe(true);
		expect(bar.cells[1]?.text).toBe("description");
		expect(DetailModel.barWidth(bar)).toBe(39);
	});
});

describe("when a fresh block is seen", () => {
	const onScreen = () => true;

	it("counts a block seen once it has stayed on screen for the whole dwell", () => {
		const first = DetailModel.dwell(
			new Map(),
			new Set(["checklist"]),
			onScreen,
			0,
		);
		expect(first.seen).toEqual([]);
		const early = DetailModel.dwell(
			first.since,
			new Set(["checklist"]),
			onScreen,
			DetailModel.SEEN_MS - 1,
		);
		expect(early.seen).toEqual([]);
		expect(
			DetailModel.dwell(
				early.since,
				new Set(["checklist"]),
				onScreen,
				DetailModel.SEEN_MS,
			).seen,
		).toEqual(["checklist"]);
	});

	it("starts again from nothing for a block scrolled away or no longer fresh", () => {
		const both = new Set<DetailModel.BlockName>(["checklist", "subtasks"]);
		const start = DetailModel.dwell(new Map(), both, onScreen, 0);
		// The checklist stops being fresh while the subtasks stay; then it comes back.
		const gone = DetailModel.dwell(
			start.since,
			new Set(["subtasks"]),
			onScreen,
			1000,
		);
		expect([...gone.since.keys()]).toEqual(["subtasks"]);
		const back = DetailModel.dwell(gone.since, both, onScreen, 2000);
		const later = DetailModel.dwell(
			back.since,
			both,
			onScreen,
			DetailModel.SEEN_MS,
		);
		expect(later.seen).toEqual(["subtasks"]);
		const away = DetailModel.dwell(later.since, both, () => false, 4000);
		expect(away.since.size).toBe(0);
	});
});
