import { describe, expect, it } from "bun:test";
import { TASK_STATE_DISPLAY, type Task } from "@cabane/core";
import { BoardContext } from "./context";
import { BoardData } from "./data";
import type { BoardNav } from "./nav";

const task = (over: Partial<Task> = {}): Task => ({
	id: "01H000000000000000000000AA",
	shortId: "JCAB-1",
	title: "A task",
	kind: "issue",
	state: "next",
	priority: "normal",
	provenance: { source: "human", discoveredAt: "2026-01-01T00:00:00.000Z" },
	needsReview: false,
	tags: [],
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	...over,
});

const sections = (
	byState: Partial<Record<BoardData.SectionState, Task[]>>,
): BoardData.BoardSection[] =>
	BoardData.SECTION_STATES.filter((state) => byState[state]?.length).map(
		(state) => ({
			state,
			label: TASK_STATE_DISPLAY[state].label,
			rows: (byState[state] ?? []).map((t) => ({ task: t, children: [] })),
		}),
	);

const epic = task({ id: "e", shortId: "JCAB-31", title: "Board copilot" });
const acp = task({ id: "a", shortId: "JCAB-34", title: "ACP client" });
const marks = task({ id: "m", shortId: "JCAB-35", title: "Marks" });

const state = (
	over: Partial<BoardNav.BoardState> = {},
): BoardNav.BoardState => ({
	sections: sections({ next: [epic], inbox: [acp, marks] }),
	selectedId: "e",
	expanded: new Set<string>(),
	kind: "all",
	status: "open",
	scoped: true,
	view: { type: "board" },
	search: { mode: "off" },
	dispatch: null,
	help: false,
	focus: "board",
	sidebar: { visible: true, selected: 0, itemCount: 0 },
	marked: new Set(["a", "m"]),
	copilot: {
		text: "",
		history: [],
		historyAt: 0,
		turn: "idle",
		shortcuts: [],
		actor: null,
	},
	undo: [],
	...over,
});

const scope: BoardData.ScopeInfo = {
	scopeUri: "jake://scope/cabane",
	label: "cabane",
};

const briefs = new Map([
	["e", "# JCAB-31\n\nThe PRD."],
	["a", "# JCAB-34\n\nThe client."],
	["m", "# JCAB-35\n\nThe marks."],
]);

describe("BoardContext.project", () => {
	it("carries scope, view, section, filter, selected, marked and briefs, selected first", () => {
		const ctx = BoardContext.project(state(), scope, briefs);
		expect(ctx).toEqual({
			scopeUri: "jake://scope/cabane",
			view: "board",
			section: "next",
			filter: { kind: "all", status: "open" },
			selected: { id: "e", shortId: "JCAB-31", title: "Board copilot" },
			marked: [
				{ id: "a", shortId: "JCAB-34", title: "ACP client" },
				{ id: "m", shortId: "JCAB-35", title: "Marks" },
			],
			briefs: [
				{ shortId: "JCAB-31", brief: "# JCAB-31\n\nThe PRD." },
				{ shortId: "JCAB-34", brief: "# JCAB-34\n\nThe client." },
				{ shortId: "JCAB-35", brief: "# JCAB-35\n\nThe marks." },
			],
			truncated: false,
		});
	});

	it("omits the scope on all scopes and the query when search is off", () => {
		const ctx = BoardContext.project(state({ scoped: false }), scope, briefs);
		expect(ctx.scopeUri).toBeUndefined();
		expect(ctx.filter.query).toBeUndefined();
	});

	it("in the detail view the open task is the selection", () => {
		const ctx = BoardContext.project(
			state({ view: { type: "detail", taskId: "a" }, marked: new Set() }),
			scope,
			briefs,
		);
		expect(ctx.view).toBe("detail");
		expect(ctx.selected?.shortId).toBe("JCAB-34");
		expect(ctx.section).toBe("inbox");
	});

	it("a marked task that is also selected appears once among the briefs", () => {
		const ctx = BoardContext.project(
			state({ marked: new Set(["e", "a"]) }),
			scope,
			briefs,
		);
		expect(ctx.briefs.map((b) => b.shortId)).toEqual(["JCAB-31", "JCAB-34"]);
	});

	it("caps one brief and flags the cut", () => {
		const long = "x".repeat(BoardContext.PER_BRIEF_CAP + 10);
		const ctx = BoardContext.project(
			state({ marked: new Set() }),
			scope,
			new Map([["e", long]]),
		);
		expect(ctx.briefs[0]?.brief.length).toBe(BoardContext.PER_BRIEF_CAP);
		expect(ctx.briefs[0]?.brief.endsWith("…")).toBe(true);
		expect(ctx.truncated).toBe(true);
	});

	it("drops the oldest marked briefs first when the total is over budget, never the selected one", () => {
		const fill = "y".repeat(BoardContext.PER_BRIEF_CAP);
		const many = Array.from({ length: 6 }, (_, i) =>
			task({ id: `t${i}`, shortId: `T-${i}`, title: `t${i}` }),
		);
		const s = state({
			sections: sections({ next: [epic], inbox: many }),
			marked: new Set(many.map((t) => t.id)),
		});
		const all = new Map([
			["e", fill],
			...many.map((t) => [t.id, fill] as const),
		]);
		const ctx = BoardContext.project(s, scope, all);
		// 4 briefs × 6000 = 24000 fits; the three oldest marks (t0..t2) are gone.
		expect(ctx.briefs.map((b) => b.shortId)).toEqual([
			"JCAB-31",
			"T-3",
			"T-4",
			"T-5",
		]);
		expect(ctx.truncated).toBe(true);
	});
});

describe("BoardContext.render", () => {
	it("renders a fixed-order field block, then the briefs under shortId headings", () => {
		const ctx = BoardContext.project(
			state({ search: { mode: "committed", query: "acp" } }),
			scope,
			briefs,
		);
		expect(BoardContext.render(ctx)).toBe(
			[
				"```cabane-board",
				"scope: jake://scope/cabane",
				"view: board",
				"section: next",
				'filter: kind=all status=open query="acp"',
				"selected: JCAB-31 · Board copilot",
				"marked: JCAB-34 · ACP client; JCAB-35 · Marks",
				"```",
				"",
				"### JCAB-31",
				"",
				"# JCAB-31",
				"",
				"The PRD.",
				"",
				"### JCAB-34",
				"",
				"# JCAB-34",
				"",
				"The client.",
				"",
				"### JCAB-35",
				"",
				"# JCAB-35",
				"",
				"The marks.",
				"",
			].join("\n"),
		);
	});

	it("says none for an empty working set and names a truncation", () => {
		const ctx: BoardContext.Context = {
			view: "board",
			filter: { kind: "issue", status: "review" },
			marked: [],
			briefs: [],
			truncated: true,
		};
		expect(BoardContext.render(ctx)).toBe(
			"```cabane-board\nscope: all\nview: board\nfilter: kind=issue status=review\nmarked: none\ntruncated: yes\n```\n",
		);
	});
});

describe("BoardContext.briefIds", () => {
	it("lists the selected task, then the marks oldest first, without repeating", () => {
		expect(
			BoardContext.briefIds(state({ marked: new Set(["m", "e", "a"]) })),
		).toEqual(["e", "m", "a"]);
		expect(BoardContext.briefIds(state({ selectedId: null }))).toEqual([
			"a",
			"m",
		]);
	});
});
