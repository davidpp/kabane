// The decisions on the board's state: `u`'s filter and its place in the esc chain, and a decision
// asked on the detail view with the copilot form's keys, through the one key router.
import { describe, expect, it } from "bun:test";
import type { QuestionView } from "@cabane/questions";
import { BoardDecisions } from "./decisions";
import { BoardNav } from "./nav";
import type { CopilotPermission } from "./ports";
import { Fixtures } from "./stories/fixtures";

const { task, section } = Fixtures;

const WAITING = task({ id: "w", shortId: "JREP-7", state: "waiting" });
const PARENT = task({ id: "p", shortId: "JREP-1" });
const CHILD = task({ id: "c", shortId: "JREP-2", parentTaskId: "p" });
const OTHER = task({ id: "o", shortId: "JREP-3" });

const SECTIONS = [
	section("next", [
		{ task: PARENT, children: [CHILD] },
		{ task: OTHER, children: [] },
	]),
	section("waiting", [{ task: WAITING, children: [] }]),
];

const STORE = Fixtures.decision(WAITING, 1, "Which store?", {
	choices: ["SQLite", "Redis"],
	recommended: "SQLite",
	allowFreeform: false,
});
const CHECKS = Fixtures.decision(WAITING, 2, "Which checks?", {
	choices: ["Lint", "Tests"],
	multiSelect: true,
	allowFreeform: true,
});
const NAME = Fixtures.decision(WAITING, 3, "What is it called?", {});

const board = (): BoardNav.BoardState =>
	BoardDecisions.withCounts(
		BoardNav.init(SECTIONS, { scoped: true }),
		new Map([
			["c", 1],
			["w", 2],
		]),
	);

// The detail view of WAITING with `rows` its questions, as its records bring them.
const detail = (rows: QuestionView[]): BoardNav.BoardState =>
	BoardDecisions.withOpen(
		{ ...board(), view: { type: "detail", taskId: "w" } },
		"w",
		rows,
	);

type Reduced = { state: BoardNav.BoardState; effect: BoardNav.Effect };

// A key pressed once what is on screen has been read (BoardNav.ARM_MS).
const press = (s: BoardNav.BoardState, name: string): Reduced =>
	BoardNav.reduceKey(
		BoardNav.sight(s, 0),
		name.length === 1 ? { name, sequence: name } : { name },
		BoardNav.ARM_MS,
	);

const keys = (s: BoardNav.BoardState, ...names: string[]): Reduced =>
	names.reduce<Reduced>((r, name) => press(r.state, name), {
		state: s,
		effect: { type: "none" },
	});

const rowIds = (s: BoardNav.BoardState) =>
	BoardNav.visibleRows(s).map((r) => r.task.shortId);

const asking = (s: BoardNav.BoardState) => {
	const shown = BoardDecisions.shown(s);
	return (
		shown && {
			handle: shown.decision.handle,
			field: shown.decision.request.fields[shown.draft.at]?.title,
			error: shown.draft.error,
		}
	);
};

describe("u: the issues waiting on a decision", () => {
	it("narrows the list to the tasks with one, keeping a subtask's parent, and back", () => {
		const s = board();
		expect(rowIds(s)).toEqual(["JREP-1", "JREP-3", "JREP-7"]);
		const on = press(s, "u").state;
		expect(on.decisions.only).toBe(true);
		expect(rowIds(on)).toEqual(["JREP-1", "JREP-2", "JREP-7"]);
		expect(rowIds(press(on, "u").state)).toEqual([
			"JREP-1",
			"JREP-3",
			"JREP-7",
		]);
	});

	it("keeps a visible row selected when a reload drops the selected issue's last decision", () => {
		const on = { ...press(board(), "u").state, selectedId: "w" };
		// The poll after its last answer: its section moved, and its count is gone.
		const moved = [
			section("next", [
				{ task: PARENT, children: [CHILD] },
				{ task: OTHER, children: [] },
				{ task: { ...WAITING, state: "next" }, children: [] },
			]),
		];
		const next = BoardNav.withSections(on, moved, new Map([["c", 1]]));
		expect(rowIds(next)).toEqual(["JREP-1", "JREP-2"]);
		expect(BoardNav.visibleRows(next).map((r) => r.task.id)).toContain(
			next.selectedId ?? "",
		);
		expect(press(next, "return").state.view.type).toBe("detail");
	});

	it("is cleared by esc after the marks and a committed search, before the announcement and the scope", () => {
		let s: BoardNav.BoardState = {
			...press(board(), "u").state,
			marked: new Set(["w"]),
			search: { mode: "committed", query: "jrep" },
			announcement: "kabane 1.0.0 is out",
		};
		const order: string[] = [];
		for (let i = 0; i < 5; i++) {
			const before = s;
			s = press(s, "escape").state;
			order.push(
				before.marked.size > s.marked.size
					? "marks"
					: before.search.mode !== s.search.mode
						? "search"
						: before.decisions.only !== s.decisions.only
							? "decisions"
							: before.announcement !== s.announcement
								? "announcement"
								: before.scoped !== s.scoped
									? "scope"
									: "nothing",
			);
		}
		expect(order).toEqual([
			"marks",
			"search",
			"decisions",
			"announcement",
			"scope",
		]);
	});
});

describe("a decision on the detail view", () => {
	it("holds a digit until it has been read, then answers with the choice and an empty reasoning", () => {
		const s = BoardNav.sight(detail([STORE, CHECKS]), 1000);
		const early = BoardNav.reduceKey(s, { name: "1", sequence: "1" }, 1100);
		expect(early.effect).toMatchObject({ type: "notice" });
		const picked = BoardNav.reduceKey(
			s,
			{ name: "1", sequence: "1" },
			1000 + BoardNav.ARM_MS,
		).state;
		expect(asking(picked)).toEqual({
			handle: "JREP-7:1",
			field: "Reasoning",
			error: undefined,
		});
		const sent = BoardDecisions.submit(picked, "  ");
		expect(sent.effect).toEqual({
			type: "answerDecision",
			questionId: STORE.id,
			handle: "JREP-7:1",
			answer: "SQLite",
		});
		// Answered here, the write landing: the next decision takes its place.
		expect(asking(sent.state)?.handle).toBe("JREP-7:2");
		// The write failed: it is asked again.
		expect(
			asking(BoardDecisions.withFailed(sent.state, STORE.id))?.handle,
		).toBe("JREP-7:1");
	});

	it("sends a multi-select's picks with its Other and the reasoning typed", () => {
		const toggled = keys(detail([CHECKS]), "space", "down", "space", "return");
		expect(asking(toggled.state)?.field).toBe("Other");
		const other = BoardDecisions.submit(toggled.state, "Docs");
		const sent = BoardDecisions.submit(other.state, "cheap ones first");
		expect(sent.effect).toEqual({
			type: "answerDecision",
			questionId: CHECKS.id,
			handle: "JREP-7:2",
			answer: "Lint, Tests, Docs",
			reasoning: "cheap ones first",
		});
	});

	it("refuses a decision left empty and asks it again from its first field, saying why", () => {
		const skipped = keys(detail([CHECKS]), "s").state;
		const other = BoardDecisions.submit(skipped, "");
		const refused = BoardDecisions.submit(other.state, "");
		expect(refused.effect.type).toBe("none");
		expect(asking(refused.state)).toEqual({
			handle: "JREP-7:2",
			field: "Answers",
			error: "pick an answer or type one",
		});
	});

	it("clears one under way with esc, and on an untouched one goes back to the board", () => {
		const under = press(detail([STORE]), "1").state;
		const cleared = press(under, "escape").state;
		expect(cleared.view.type).toBe("detail");
		expect(asking(cleared)?.field).toBe("Answer");
		expect(press(cleared, "escape").state.view.type).toBe("board");
	});

	it("does what esc does on a click on its esc hint: back to the board untouched, over once started", () => {
		const esc = { type: "decisionKey", name: "escape" } as const;
		const untouched = BoardNav.reduceMouse(detail([STORE]), esc).state;
		expect(untouched.view.type).toBe("board");
		const started = press(detail([STORE]), "1").state;
		const over = BoardNav.reduceMouse(started, esc).state;
		expect(over.view.type).toBe("detail");
		expect(asking(over)?.field).toBe("Answer");
	});

	it("leaves a typed first field the view's keys until enter asks for it, then keeps them", () => {
		const s = detail([NAME]);
		expect(BoardDecisions.reach(s)).toEqual({ key: "enter" });
		// `l` still walks the sections, `q` still leaves.
		expect(BoardNav.detailTab(press(s, "l").state.view)).toBe("comments");
		const typing = press(s, "return").state;
		expect(BoardDecisions.keysInHand(typing)).toBe(true);
		for (const name of ["l", "q", "?", "u"])
			expect(press(typing, name)).toEqual({
				state: BoardNav.sight(typing, 0),
				effect: { type: "none" },
			});
		expect(BoardDecisions.keysInHand(press(typing, "escape").state)).toBe(
			false,
		);
	});

	it("outranks the copilot's ask, whose keys tab reaches; the decision then names who has them", () => {
		const permission: CopilotPermission = {
			id: "p1",
			title: "kabane_edit JREP-7",
			options: [{ id: "once", label: "Allow once" }],
		};
		const s = BoardNav.withCopilotPermission(detail([STORE]), permission);
		expect(BoardNav.copilotOutranked(s)).toBe(true);
		expect(press(s, "1").effect.type).toBe("none");
		const copilot = press(s, "tab").state;
		expect(copilot.focus).toBe("copilot");
		expect(BoardDecisions.reach(copilot)).toEqual({
			key: "esc",
			holder: "the copilot",
		});
		expect(press(copilot, "1").effect).toEqual({
			type: "copilotAnswer",
			id: "p1",
			optionId: "once",
		});
	});

	it("waits behind a session question pinned over the view", () => {
		const s: BoardNav.BoardState = {
			...detail([STORE]),
			view: {
				type: "detail",
				taskId: "w",
				banner: { question: Fixtures.question(7, ["Yes", "No"]) },
			},
		};
		expect(BoardDecisions.shown(s)).toBeUndefined();
		expect(BoardDecisions.waiting(s)).toBe(1);
	});
});
