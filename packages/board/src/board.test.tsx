/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { TASK_STATE_DISPLAY, type Task } from "@cabane/core";
import { BoardActivity } from "./activity";
import {
	activityStrip,
	Board,
	cardBadge,
	moreBadge,
	rowStyle,
	SELECTED_BG,
	SELECTED_FG,
} from "./board";
import type { BoardData } from "./data";
import { DispatchOverlay, HelpOverlay, overlayRowStyle } from "./overlay";
import type { ActivityCard, TriggerDescriptor } from "./ports";
import { renderTest } from "./testing";

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

const pumpUntil = async (
	renderOnce: () => Promise<void>,
	captureCharFrame: () => string,
	predicate: (frame: string) => boolean,
): Promise<string> => {
	let frame = "";
	for (let pass = 0; pass < 40; pass++) {
		await renderOnce();
		frame = captureCharFrame();
		if (predicate(frame)) break;
		await sleep(20);
	}
	return frame;
};

const task = (over: Partial<Task> = {}): Task => ({
	id: "01H000000000000000000000AA",
	shortId: "JAKE-42",
	title: "Wire the board",
	kind: "issue",
	state: "next",
	priority: "high",
	provenance: { source: "human", discoveredAt: new Date().toISOString() },
	needsReview: false,
	tags: [],
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
	...over,
});

const section = (
	state: BoardData.SectionState,
	rows: BoardData.BoardRow[],
): BoardData.BoardSection => ({
	state,
	label: TASK_STATE_DISPLAY[state].label,
	rows,
});

const fixture: BoardData.BoardSection[] = [
	section("next", [{ task: task(), children: [] }]),
];

test("Board renders a section header and a row's shortId, title, and kind", async () => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={fixture}
			expanded={new Set()}
			selectedId={null}
			scopeLabel="acme/widget"
		/>,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("JAKE-42"),
		);
		expect(frame).toContain("JAKE-42");
		expect(frame).toContain("Wire the board");
		// Section header: lowercased label · count.
		expect(frame).toContain("next · 1");
		expect(frame).toContain("· issue");
	} finally {
		destroy();
	}
});

test("Board expands a parent's subtasks under it with a caret, indented and showing their own state", async () => {
	const parent = task({ id: "p", shortId: "JAKE-1", title: "parent task" });
	const child = task({
		id: "c",
		shortId: "JAKE-2",
		title: "child task",
		state: "done",
		parentTaskId: "p",
	});
	const sections = [section("next", [{ task: parent, children: [child] }])];
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board sections={sections} expanded={new Set(["p"])} selectedId="p" />,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("JAKE-2"),
		);
		// Expanded caret on the parent, child visible with its own (differing) state.
		expect(frame).toContain("▾");
		expect(frame).toContain("JAKE-2");
		expect(frame).toContain("child task");
		expect(frame).toContain("· done");
	} finally {
		destroy();
	}
});

test("Board shows a collapsed caret for a parent whose subtasks are hidden", async () => {
	const parent = task({ id: "p", shortId: "JAKE-1", title: "parent task" });
	const child = task({ id: "c", shortId: "JAKE-2", parentTaskId: "p" });
	const sections = [section("next", [{ task: parent, children: [child] }])];
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board sections={sections} expanded={new Set()} selectedId="p" />,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("JAKE-1"),
		);
		expect(frame).toContain("▸");
		// The collapsed child is not rendered.
		expect(frame).not.toContain("JAKE-2");
	} finally {
		destroy();
	}
});

// Small-screen fix: one truncated line per row, never a wrap into a second line.
test("Board truncates long titles to a single line at a narrow (60-col) width", async () => {
	const longTitle =
		"This is a really long task title that must not wrap onto a second line at sixty columns";
	const sections = [
		section("next", [{ task: task({ title: longTitle }), children: [] }]),
	];
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board sections={sections} expanded={new Set()} selectedId={null} />,
		{ width: 60, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("JAKE-42"),
		);
		// The full title never renders; it is cut with an ellipsis.
		expect(frame).not.toContain(longTitle);
		expect(frame).toContain("…");
		// No rendered line exceeds the frame width — proof there is no wrap.
		const widest = Math.max(...frame.split("\n").map((line) => line.length));
		expect(widest).toBeLessThanOrEqual(60);
	} finally {
		destroy();
	}
});

// The JJAK-1017 regression guard: INVERSE on unset colors rendered the selected card as invisible
// white-on-white. captureSpans reads the styled cells, so we can prove the selected row's title sits on
// the explicit dark highlight with a distinct fg — the caret is NOT the selection marker anymore.
test("Board renders the selected row's title on the highlight background, not invisible INVERSE", async () => {
	const { renderOnce, captureCharFrame, captureSpans, destroy } =
		await renderTest(
			<Board
				sections={fixture}
				expanded={new Set()}
				selectedId={fixture[0]?.rows[0]?.task.id ?? null}
			/>,
			{ width: 120, height: 20 },
		);
	try {
		await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("Wire the board"),
		);
		const spans = captureSpans().lines.flatMap((line) => line.spans);
		const titleSpan = spans.find((s) => s.text.includes("Wire the board"));
		expect(titleSpan).toBeDefined();
		expect(titleSpan?.bg.toInts().slice(0, 3)).toEqual([0x2f, 0x2f, 0x2f]);
		expect(titleSpan?.fg.toInts().slice(0, 3)).not.toEqual([0x2f, 0x2f, 0x2f]);
	} finally {
		destroy();
	}
});

// Two rows in different sections so search frames can prove non-matching rows AND their emptied
// sections disappear.
const searchFixture: BoardData.BoardSection[] = [
	section("next", [
		{
			task: task({ id: "a", shortId: "JAKE-10", title: "auth login flow" }),
			children: [],
		},
	]),
	section("in_progress", [
		{
			task: task({
				id: "b",
				shortId: "JAKE-11",
				title: "board polish",
				state: "in_progress",
			}),
			children: [],
		},
	]),
];

test("Board in search-typing mode shows the `/ query▌` footer line and live-filters rows", async () => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={searchFixture}
			expanded={new Set()}
			selectedId="a"
			search={{ mode: "typing", query: "auth" }}
		/>,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("/auth▌"),
		);
		expect(frame).toContain("/auth▌");
		// Matching row visible, non-matching row and its section header gone.
		expect(frame).toContain("JAKE-10");
		expect(frame).not.toContain("JAKE-11");
		expect(frame).not.toContain("in progress");
	} finally {
		destroy();
	}
});

test("Board with a committed filter shows the match-count summary and only matching rows", async () => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={searchFixture}
			expanded={new Set()}
			selectedId="a"
			search={{ mode: "committed", query: "auth" }}
		/>,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("esc clear"),
		);
		expect(frame).toContain('search: "auth" · 1 match · esc clear');
		expect(frame).toContain("JAKE-10");
		expect(frame).not.toContain("JAKE-11");
	} finally {
		destroy();
	}
});

test("Board renders a muted `no matches` state when the query matches nothing", async () => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={searchFixture}
			expanded={new Set()}
			selectedId={null}
			search={{ mode: "typing", query: "zzz" }}
		/>,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("no matches"),
		);
		expect(frame).toContain("no matches");
		expect(frame).toContain("/zzz▌");
		expect(frame).not.toContain("JAKE-10");
		expect(frame).not.toContain("JAKE-11");
	} finally {
		destroy();
	}
});

// --- In-flight badges (JJAK-1027) ---

// A host "loop" card as Jake would project it: keyed by the issue shortId, phase + iteration first.
const activeLoop = (over: Partial<ActivityCard> = {}): ActivityCard => ({
	id: `loop-${over.taskShortId ?? "JAKE-42"}`,
	kind: "loops",
	label: "loop",
	status: "running",
	taskShortId: "JAKE-42",
	startedAt: new Date().toISOString(),
	detail: ["implement 3"],
	...over,
});

const question = (taskId: string): BoardActivity.AwaitingQuestion => ({
	taskId,
	sessionId: "s1",
	questionActivityId: "q1",
	question: "Which auth flow?",
});

const activityWith = (
	cards: ActivityCard[] = [],
	questions: BoardActivity.AwaitingQuestion[] = [],
): BoardActivity.ActivityMap => {
	const map = BoardActivity.indexCards(cards);
	for (const q of questions)
		map.questionsByTaskId.set(q.taskId, [
			...(map.questionsByTaskId.get(q.taskId) ?? []),
			q,
		]);
	return map;
};

test("Board appends a loop badge to a row with an active loop and shows the header strip counts", async () => {
	const activity = activityWith(
		[activeLoop()],
		[question(fixture[0]?.rows[0]?.task.id ?? "")],
	);
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={fixture}
			expanded={new Set()}
			selectedId={null}
			activity={activity}
		/>,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("loop · implement 3"),
		);
		expect(frame).toContain("loop · implement 3");
		expect(frame).toContain("· ? input");
		// Header strip: counts on the right of the header line, only when non-zero.
		expect(frame).toContain("1 loop · 1 input");
	} finally {
		destroy();
	}
});

test("Board shows the paused badge without a spinner glyph and no header strip when idle", async () => {
	const activity = activityWith([activeLoop({ status: "paused" })]);
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={fixture}
			expanded={new Set()}
			selectedId={null}
			activity={activity}
		/>,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("loop · paused"),
		);
		expect(frame).toContain("⏸ loop · paused");
		expect(frame).toContain("1 loop");
	} finally {
		destroy();
	}
});

test("Board with no activity renders no strip and no badges (quiet by default)", async () => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={fixture}
			expanded={new Set()}
			selectedId={null}
			activity={BoardActivity.emptyActivity()}
		/>,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("JAKE-42"),
		);
		expect(frame).not.toContain("loop");
		expect(frame).not.toContain("input");
	} finally {
		destroy();
	}
});

// A badged row must still fit the frame — badge width counts against the title truncation.
test("Board keeps a badged row on a single line at a narrow (60-col) width", async () => {
	const longTitle =
		"This badged task has a really long title that must truncate instead of wrapping";
	const sections = [
		section("next", [{ task: task({ title: longTitle }), children: [] }]),
	];
	const activity = activityWith(
		[activeLoop()],
		[question(sections[0]?.rows[0]?.task.id ?? "")],
	);
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={sections}
			expanded={new Set()}
			selectedId={null}
			activity={activity}
		/>,
		{ width: 60, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("? input"),
		);
		expect(frame).toContain("? input");
		expect(frame).toContain("…");
		const widest = Math.max(...frame.split("\n").map((line) => line.length));
		expect(widest).toBeLessThanOrEqual(60);
	} finally {
		destroy();
	}
});

// Pure badge/strip contracts — no renderer needed.
test("cardBadge renders running/paused/stale variants with a constant-width glyph", () => {
	expect(cardBadge(activeLoop(), "⠹")).toEqual({
		text: " · ⠹ loop · implement 3",
		muted: false,
	});
	expect(cardBadge(activeLoop({ status: "paused" }), "⠹")).toEqual({
		text: " · ⏸ loop · paused",
		muted: false,
	});
	// Stale running: static idle glyph (no animation frame) and muted color.
	const stale = cardBadge(activeLoop({ stale: true }), "⠹");
	expect(stale.muted).toBe(true);
	expect(stale.text).toContain("⠋ loop · implement 3");
	// No detail yet — falls back to the status word.
	expect(
		cardBadge(activeLoop({ status: "pending", detail: [] }), "⠹").text,
	).toBe(" · ⠋ loop · pending");
	// Extra in-flight cards collapse to a count.
	expect(moreBadge(0, "⠹")).toBe("");
	expect(moreBadge(2, "⠹")).toBe(" · ⠹ +2");
});

test("activityStrip counts cards by kind (singular for one), omits zero parts, and is empty when idle", () => {
	expect(activityStrip(BoardActivity.emptyActivity(), "⠹")).toBe("");
	expect(activityStrip(activityWith([activeLoop()]), "⠹")).toBe(" · ⠹ 1 loop");
	expect(
		activityStrip(
			activityWith(
				[
					activeLoop(),
					activeLoop({ taskShortId: "JAKE-43" }),
					activeLoop({ id: "r1", kind: "runs", label: "scout", taskId: "t9" }),
					activeLoop({ id: "r2", kind: "runs", status: "completed" }),
				],
				[question("t1")],
			),
			"⠹",
		),
	).toBe(" · ⠹ 2 loops · 1 run · 1 input");
	expect(activityStrip(activityWith([], [question("t1")]), "⠹")).toBe(
		" · 1 input",
	);
});

test("rowStyle pairs an explicit bg with explicit fg on every selected cell and never emits INVERSE", () => {
	const selected = rowStyle(true, "#eab308");
	expect(selected.bg).toBeDefined();
	expect(selected.idFg).toBeDefined();
	// The title cell is the one that was invisible under INVERSE — it must carry an explicit fg.
	expect(selected.titleFg).toBeDefined();
	expect(selected.metaFg).toBeDefined();
	expect(selected.caretFg).toBeDefined();
	// Selection is colors only — no attributes field means TextAttributes.INVERSE can never be set.
	expect(selected).not.toHaveProperty("attributes");

	const idle = rowStyle(false, "#eab308");
	expect(idle.bg).toBeUndefined();
	expect(idle.idFg).toBe("#eab308");
	expect(idle.titleFg).toBeUndefined();
});

test("DispatchOverlay renders the title, the numbered host triggers, the preview, and the hint row", async () => {
	const triggers: TriggerDescriptor[] = [
		{
			id: "claude",
			label: "claude",
			description: "interactive session",
			source: "host",
			inputs: {},
			satisfiable: true,
		},
		{
			id: "scout",
			label: "scout",
			description: "recon recipe",
			source: "builtin",
			inputs: { depth: { type: "number", required: false, default: 2 } },
			satisfiable: true,
		},
		{
			id: "custom",
			label: "custom",
			description: "needs a field",
			inputs: { field: { type: "string", required: true } },
			satisfiable: false,
			hint: "run via: cabane dispatch custom -i …",
		},
	];
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<DispatchOverlay
			shortId="JAKE-42"
			overlay={{ taskId: "test", triggers, selected: 2, loading: false }}
		/>,
		{ width: 90, height: 24 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("dispatch JAKE-42"),
		);
		expect(frame).toContain("dispatch JAKE-42");
		expect(frame).toContain("1 claude");
		expect(frame).toContain("2 scout");
		expect(frame).toContain("3 custom");
		expect(frame).toContain("builtin");
		// Preview of the selected (unsatisfiable) trigger: description, inputs, hint.
		expect(frame).toContain("needs a field");
		expect(frame).toContain("field: string (required)");
		expect(frame).toContain("run via: cabane dispatch custom -i …");
		expect(frame).toContain("enter run · esc close");
	} finally {
		destroy();
	}
});

test("DispatchOverlay shows the loading and empty states", async () => {
	const loading = await renderTest(
		<DispatchOverlay
			shortId="JAKE-42"
			overlay={{ taskId: "test", triggers: [], selected: 0, loading: true }}
		/>,
		{ width: 80, height: 20 },
	);
	try {
		const frame = await pumpUntil(
			loading.renderOnce,
			loading.captureCharFrame,
			(f) => f.includes("loading triggers"),
		);
		expect(frame).toContain("loading triggers…");
	} finally {
		loading.destroy();
	}
	const empty = await renderTest(
		<DispatchOverlay
			shortId="JAKE-42"
			overlay={{ taskId: "test", triggers: [], selected: 0, loading: false }}
		/>,
		{ width: 80, height: 20 },
	);
	try {
		const frame = await pumpUntil(
			empty.renderOnce,
			empty.captureCharFrame,
			(f) => f.includes("nothing to dispatch"),
		);
		expect(frame).toContain("nothing to dispatch to");
	} finally {
		empty.destroy();
	}
});

test("overlayRowStyle: selection pairs the board's explicit bg+fg (never INVERSE); idle rows keep the backdrop bg", () => {
	const selected = overlayRowStyle(true);
	expect(selected.bg).toBe(SELECTED_BG);
	expect(selected.fg).toBe(SELECTED_FG);
	expect(selected).not.toHaveProperty("attributes");

	const idle = overlayRowStyle(false);
	expect(idle.bg).toBeDefined();
	expect(idle.bg).not.toBe(SELECTED_BG);
	expect(idle.fg).toBeDefined();
});

test("HelpOverlay renders the grouped full keybinding list with its close hint", async () => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<HelpOverlay />,
		{ width: 90, height: 40 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("keyboard shortcuts"),
		);
		expect(frame).toContain("keyboard shortcuts");
		expect(frame).toContain("navigate");
		expect(frame).toContain("task state");
		expect(frame).toContain("actions");
		// The vim-obvious keys live HERE, not in the footer.
		expect(frame).toContain("expand/collapse subtasks");
		expect(frame).toContain("dispatch (host triggers)");
		// The status filter is discoverable here only — like `i`, it is off the trimmed footer.
		expect(frame).toContain("cycle status (open · done+cancelled · review)");
		expect(frame).toContain("? / esc close");
	} finally {
		destroy();
	}
});

test("Board footer shows only the app-specific hints, ending in `? help`", async () => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board sections={[]} expanded={new Set()} selectedId={null} />,
		{ width: 100, height: 12 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("? help"),
		);
		expect(frame).toContain(
			"a dispatch · / search · d done · v review · y copy · b sidebar · ? help",
		);
		// The vim-obvious ones are gone from the footer.
		expect(frame).not.toContain("space expand");
		expect(frame).not.toContain("enter open");
	} finally {
		destroy();
	}
});

const statusFixture: BoardData.BoardSection[] = [
	section("next", [
		{
			task: task({ id: "a", shortId: "JAKE-50", title: "open work" }),
			children: [],
		},
	]),
	section("someday", [
		{
			task: task({
				id: "sd",
				shortId: "JAKE-52",
				title: "parked idea",
				state: "someday",
			}),
			children: [],
		},
	]),
	section("done", [
		{
			task: task({
				id: "df",
				shortId: "JAKE-51",
				title: "shipped unverified",
				state: "done",
				needsReview: true,
			}),
			children: [],
		},
	]),
	section("cancelled", [
		{
			task: task({
				id: "cx",
				shortId: "JAKE-53",
				title: "abandoned work",
				state: "cancelled",
			}),
			children: [],
		},
	]),
];

test("Board at the default status shows the unresolved sections — someday included — and hides the archive", async () => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={statusFixture}
			expanded={new Set()}
			selectedId="a"
			scopeLabel="acme/widget"
			filterLabel="kind: all"
		/>,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("JAKE-50"),
		);
		// `open` stays quiet in the header, but it means UNRESOLVED: the parked someday row is on
		// screen, and neither closed section is.
		expect(frame).toContain("cabane · acme/widget · kind: all");
		expect(frame).not.toContain("status:");
		expect(frame).toContain("JAKE-52");
		expect(frame).not.toContain("JAKE-51");
		expect(frame).not.toContain("JAKE-53");
	} finally {
		destroy();
	}
});

test("Board under status done shows the chip and BOTH archive sections with no query typed", async () => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={statusFixture}
			expanded={new Set()}
			selectedId="df"
			scopeLabel="acme/widget"
			filterLabel="kind: all"
			status="done"
		/>,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("JAKE-51"),
		);
		expect(frame).toContain("status: done");
		// done AND cancelled — the closed bucket, not the state name.
		expect(frame).toContain("JAKE-51");
		expect(frame).toContain("JAKE-53");
		expect(frame).not.toContain("JAKE-50");
		expect(frame).not.toContain("JAKE-52");
	} finally {
		destroy();
	}
});

test("Board under status review says 'no matches' rather than going blank when nothing is flagged", async () => {
	const unflagged: BoardData.BoardSection[] = [
		section("next", [
			{
				task: task({ id: "a", shortId: "JAKE-50", title: "open work" }),
				children: [],
			},
		]),
	];
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={unflagged}
			expanded={new Set()}
			selectedId={null}
			status="review"
		/>,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("no matches"),
		);
		expect(frame).toContain("status: review");
		expect(frame).toContain("no matches");
		expect(frame).not.toContain("JAKE-50");
	} finally {
		destroy();
	}
});
