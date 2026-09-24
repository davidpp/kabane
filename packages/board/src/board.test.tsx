/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { TASK_STATE_DISPLAY, type Task } from "@cabane/core";
import { type CapturedSpan, type RGBA, TextAttributes } from "@opentui/core";
import { BoardActivity } from "./activity";
import {
	activityStrip,
	Board,
	cardBadge,
	EMPTY_HINTS,
	headerFilters,
	heldColumns,
	markedLabel,
	moreBadge,
	rowMeta,
	rowStyle,
	shortIdIndex,
} from "./board";
import type { BoardData } from "./data";
import { Keymap } from "./keymap";
import type { BoardNav } from "./nav";
import {
	DispatchOverlay,
	HelpSheet,
	overlayRowStyle,
	sheetLines,
	sheetLineWidth,
} from "./overlay";
import type { ActivityCard, TriggerDescriptor } from "./ports";
import { renderTest } from "./testing";
import { Theme } from "./theme";

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

// OpenTUI draws an unset foreground as explicit white, which vanishes on a light terminal. An idle
// title carries no meaning of its own, so it must be the terminal's own foreground (SGR 39).
test("Board draws an idle row's title in the terminal's own foreground, not white", async () => {
	const { renderOnce, captureCharFrame, captureSpans, destroy } =
		await renderTest(
			<Board sections={fixture} expanded={new Set()} selectedId={null} />,
			{ width: 120, height: 20 },
		);
	try {
		await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("Wire the board"),
		);
		const spans = captureSpans().lines.flatMap((line) => line.spans);
		const titleSpan = spans.find((s) => s.text.includes("Wire the board"));
		expect(titleSpan?.fg.intent).toBe("default");
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
		expect(frame).toContain("/auth · 1 match  esc clear · ? help");
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
	const selected = rowStyle(true, "#eab308", Theme.DARK);
	expect(selected.bg).toBeDefined();
	expect(selected.idFg).toBeDefined();
	// The title cell is the one that was invisible under INVERSE — it must carry an explicit fg.
	expect(selected.titleFg).toBeDefined();
	expect(selected.metaFg).toBeDefined();
	expect(selected.caretFg).toBeDefined();
	// Selection is colors only — no attributes field means TextAttributes.INVERSE can never be set.
	expect(selected).not.toHaveProperty("attributes");

	const idle = rowStyle(false, "#eab308", Theme.DARK);
	expect(idle.bg).toBeUndefined();
	expect(idle.idFg).toBe("#eab308");
	// The terminal's own foreground, not an unset one: OpenTUI draws unset as white.
	expect(idle.titleFg).toBe(Theme.DARK.defaultFg);
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
	const selected = overlayRowStyle(true, Theme.DARK);
	expect(selected.bg).toBe(Theme.DARK.surface.selected);
	expect(selected.fg).toBe(Theme.DARK.text);
	expect(selected).not.toHaveProperty("attributes");

	const idle = overlayRowStyle(false, Theme.DARK);
	expect(idle.bg).toBeDefined();
	expect(idle.bg).not.toBe(Theme.DARK.surface.selected);
	expect(idle.fg).toBeDefined();
});

test("the ? sheet lists the view's own keys under its name, then the ones that work everywhere", async () => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<HelpSheet context="detail" situation={{ linked: false }} />,
		{ width: 120, height: 40 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("everywhere"),
		);
		const rows = frame.split("\n");
		const at = (text: string): number =>
			rows.findIndex((row) => row.includes(text));
		expect(at("detail")).toBeGreaterThanOrEqual(0);
		expect(at("detail")).toBeLessThan(at("everywhere"));
		// Every detail key reads once, and none of the board's own rows leak in.
		for (const binding of Keymap.CONTEXTS.detail.bindings)
			expect({
				label: binding.label,
				rows: rows.filter(
					(row) =>
						row.trimStart().startsWith(binding.key) &&
						row.includes(binding.label),
				).length,
			}).toEqual({ label: binding.label, rows: 1 });
		expect(frame).not.toContain("fold subtasks");
		// Short enough for the pane, so the sheet's own row only says how to close it.
		expect(frame).toContain("? esc close");
		expect(frame).not.toContain("j/k scroll ·");
	} finally {
		destroy();
	}
});

test("every ? sheet row reads whole at forty columns", () => {
	for (const context of ["board", "detail", "transcript", "sidebar"] as const)
		for (const line of sheetLines(Keymap.sheet(context)))
			expect({ context, line, fits: sheetLineWidth(line) <= 38 }).toEqual({
				context,
				line,
				fits: true,
			});
});

test("Board footer hints only the keys that do something: the row keys wait for a selected row", async () => {
	const empty = await renderTest(
		<Board sections={[]} expanded={new Set()} selectedId={null} />,
		{ width: 100, height: 12 },
	);
	try {
		const frame = await pumpUntil(
			empty.renderOnce,
			empty.captureCharFrame,
			(f) => f.includes("? help"),
		);
		expect(frame).toContain("/ search · ? help");
		expect(frame).not.toContain("d done");
	} finally {
		empty.destroy();
	}
	const rows = [
		section("next", [
			{
				task: task({ id: "a", shortId: "JAKE-1", title: "one" }),
				children: [],
			},
		]),
	];
	const selected = await renderTest(
		<Board sections={rows} expanded={new Set()} selectedId="a" />,
		{ width: 100, height: 12 },
	);
	try {
		const frame = await pumpUntil(
			selected.renderOnce,
			selected.captureCharFrame,
			(f) => f.includes("? help"),
		);
		expect(frame).toContain(
			"/ search · d done · v review · m mark · y copy brief · ? help",
		);
		// The vim-obvious ones live in the `?` sheet, not the footer.
		expect(frame).not.toContain("space fold");
		expect(frame).not.toContain("enter open");
	} finally {
		selected.destroy();
	}
});

test("Board footer at forty columns drops whole hints from the end and keeps `? help`", async () => {
	const rows = [
		section("next", [
			{
				task: task({ id: "a", shortId: "JAKE-1", title: "one" }),
				children: [],
			},
		]),
	];
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board sections={rows} expanded={new Set()} selectedId="a" />,
		{ width: 40, height: 12 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("? help"),
		);
		const footer = frame.split("\n").find((row) => row.includes("? help"));
		expect(footer?.trimEnd()).toBe("/ search · d done · v review · ? help");
		expect(frame).not.toContain("…");
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
		/>,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("JAKE-50"),
		);
		// `open` stays quiet in the header, but it means UNRESOLVED: the parked someday row is on
		// screen, and neither closed section is.
		// Nothing filtered, so the header says only where it is: no `kind: all`, no `status: open`.
		expect(frame).toContain("kabane · acme/widget");
		expect(frame).not.toContain("kind:");
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

test("Board with nothing open and no filter says so, and where the first issue comes from", async () => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={[]}
			expanded={new Set()}
			selectedId={null}
			scopeLabel="repo"
		/>,
		{ width: 40, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("nothing open here."),
		);
		// Whole at 40 columns: a hint that wraps splits its sentence across two rows.
		for (const hint of EMPTY_HINTS)
			expect(frame.split("\n").some((row) => row.includes(hint))).toBe(true);
		expect(frame).not.toContain("no matches");
	} finally {
		destroy();
	}
});

test("Board under a kind filter that finds nothing says 'no matches', not that the scope is empty", async () => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board sections={[]} expanded={new Set()} selectedId={null} kind="issue" />,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("no matches"),
		);
		expect(frame).not.toContain("nothing open here.");
	} finally {
		destroy();
	}
});

// JCAB-30. A subtask whose parent never rendered it is promoted to depth 0; without a marker it reads
// as a genuine root item, which is false. These pin the marker, not just the row's presence.
const visibleRow = (
	task: Task,
	over: Partial<BoardNav.VisibleRow> = {},
): BoardNav.VisibleRow => ({
	task,
	depth: 0,
	parentId: null,
	hasChildren: false,
	expanded: false,
	...over,
});

test("rowMeta marks an orphaned subtask with its parent id, and a root row without one", () => {
	const root = visibleRow(task({ id: "r" }));
	const orphan = visibleRow(task({ id: "o", parentTaskId: "p" }));
	expect(rowMeta(root)).toBe(" · issue");
	expect(rowMeta(orphan, "JCAB-1")).toBe(" · issue · in JCAB-1");
	// The two must not be confusable — that is the whole point of the marker.
	expect(rowMeta(orphan, "JCAB-1")).not.toBe(rowMeta(root));
});

test("rowMeta falls back to a bare marker when the parent is not loaded, never guessing why", () => {
	const orphan = visibleRow(task({ id: "o", parentTaskId: "past-the-cap" }));
	expect(rowMeta(orphan)).toBe(" · issue · subtask");
});

test("rowMeta still shows a real subtask its own state, not a parent reference", () => {
	const child = task({ id: "c", state: "waiting", parentTaskId: "p" });
	// depth 1 means it IS rendering under its parent — the relationship is already on screen.
	expect(
		rowMeta(visibleRow(child, { depth: 1, parentId: "p" }), "JCAB-1"),
	).toBe(" · waiting");
});

test("shortIdIndex covers children and tasks in sections the filter is hiding", () => {
	const index = shortIdIndex([
		section("next", [
			{
				task: task({ id: "p", shortId: "JCAB-2" }),
				children: [task({ id: "c", shortId: "JCAB-3" })],
			},
		]),
		// Hidden under the `open` status filter, but still loaded — so still nameable.
		section("done", [
			{ task: task({ id: "d", shortId: "JCAB-1" }), children: [] },
		]),
	]);
	expect(index.get("d")).toBe("JCAB-1");
	expect(index.get("c")).toBe("JCAB-3");
});

test("Board renders an orphaned subtask distinguishably from a genuine top-level row", async () => {
	const sections: BoardData.BoardSection[] = [
		section("next", [
			{
				task: task({ id: "root", shortId: "JCAB-7", title: "A real root" }),
				children: [],
			},
			{
				task: task({
					id: "orph",
					shortId: "JCAB-9",
					title: "Orphaned child",
					parentTaskId: "p",
				}),
				children: [],
			},
		]),
		section("done", [
			{
				task: task({
					id: "p",
					shortId: "JCAB-1",
					title: "The done parent",
					state: "done",
				}),
				children: [],
			},
		]),
	];
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board sections={sections} expanded={new Set()} selectedId={null} />,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("JCAB-9"),
		);
		// The orphan is visible at all — the bug was that it rendered nowhere.
		expect(frame).toContain("Orphaned child");
		// ...and it names the parent that is not on screen (the done section is filtered out).
		expect(frame).toContain("Orphaned child · issue · in JCAB-1");
		// The genuine root carries no such marker.
		expect(frame).toContain("A real root · issue");
		expect(frame).not.toContain("A real root · issue · in");
	} finally {
		destroy();
	}
});

test("Board draws the mark glyph on a marked row and counts marks in the header", async () => {
	const a = task({ id: "a", shortId: "JAKE-1", title: "Marked one" });
	const b = task({ id: "b", shortId: "JAKE-2", title: "Plain one" });
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={[
				section("next", [
					{ task: a, children: [] },
					{ task: b, children: [] },
				]),
			]}
			expanded={new Set()}
			selectedId="b"
			marked={new Set(["a"])}
		/>,
		{ width: 100, height: 12 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("JAKE-2"),
		);
		// The mark gutter, held on the unmarked row too; no row is linked, so no link gutter at all.
		expect(frame).toContain("JAKE-1  ● Marked one");
		expect(frame).toContain("JAKE-2    Plain one");
		expect(frame).toContain("kabane · all scopes · 1 marked");
	} finally {
		destroy();
	}
});

test("markedLabel is quiet at zero", () => {
	expect(markedLabel(0)).toBe("");
	expect(markedLabel(3)).toBe(" · 3 marked");
});

test("Board glyphs the rows the copilot touched, and leaves the rest their full width", async () => {
	const changed = task({ id: "a", shortId: "JAKE-1", title: "Agent wrote it" });
	const untouched = task({
		id: "b",
		shortId: "JAKE-2",
		title: "Human wrote it",
	});
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={[
				section("next", [
					{ task: changed, children: [] },
					{ task: untouched, children: [] },
				]),
			]}
			expanded={new Set()}
			selectedId="b"
			touched={new Set(["a"])}
		/>,
		{ width: 100, height: 12 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("JAKE-2"),
		);
		expect(frame).toContain("JAKE-1  ✦ ai Agent wrote it");
		// Transient, so it holds no column: an untouched title starts where it always did.
		expect(frame).toContain("JAKE-2  Human wrote it");
	} finally {
		destroy();
	}
});

test("Board glyphs a row with a linked issue and keeps every title aligned", async () => {
	const linkedTask = task({ id: "a", shortId: "JAKE-1", title: "Team work" });
	const plain = task({ id: "b", shortId: "JAKE-2", title: "Local work" });
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={[
				section("next", [
					{ task: linkedTask, children: [] },
					{ task: plain, children: [] },
				]),
			]}
			expanded={new Set()}
			selectedId="b"
			linked={new Set(["a"])}
		/>,
		{ width: 100, height: 12 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("JAKE-2"),
		);
		expect(frame).toContain("JAKE-1  ◆ Team work");
		// The gutter holds its column on the row without a link, which is what makes the glyphs
		// scannable; nothing is marked, so the mark gutter costs nothing.
		expect(frame).toContain("JAKE-2    Local work");
	} finally {
		destroy();
	}
});

// The glyph is a column the title no longer has. If it were missing from `fixed`, a long title would
// be one character too wide and wrap — which is the whole failure mode a 40-column split cares about.
test("Board keeps a linked row on a single line at a narrow (40-col) width", async () => {
	const longTitle =
		"This linked task has a really long title that must truncate rather than wrap at forty columns";
	const sections = [
		section("next", [
			{ task: task({ id: "a", title: longTitle }), children: [] },
		]),
	];
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={sections}
			expanded={new Set()}
			selectedId={null}
			linked={new Set(["a"])}
		/>,
		{ width: 40, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("JAKE-42"),
		);
		expect(frame).toContain("◆");
		expect(frame).toContain("…");
		const widest = Math.max(...frame.split("\n").map((line) => line.length));
		expect(widest).toBeLessThanOrEqual(40);
	} finally {
		destroy();
	}
});

test("the footer offers O only while the selected row has a linked issue", async () => {
	const linkedTask = task({ id: "a", shortId: "JAKE-1", title: "Team work" });
	const plain = task({ id: "b", shortId: "JAKE-2", title: "Local work" });
	const sections = [
		section("next", [
			{ task: linkedTask, children: [] },
			{ task: plain, children: [] },
		]),
	];

	const onLinked = await renderTest(
		<Board
			sections={sections}
			expanded={new Set()}
			selectedId="a"
			linked={new Set(["a"])}
		/>,
		{ width: 100, height: 12 },
	);
	try {
		const frame = await pumpUntil(
			onLinked.renderOnce,
			onLinked.captureCharFrame,
			(f) => f.includes("JAKE-2"),
		);
		expect(frame).toContain("O open issue");
	} finally {
		onLinked.destroy();
	}

	const onPlain = await renderTest(
		<Board
			sections={sections}
			expanded={new Set()}
			selectedId="b"
			linked={new Set(["a"])}
		/>,
		{ width: 100, height: 12 },
	);
	try {
		const frame = await pumpUntil(
			onPlain.renderOnce,
			onPlain.captureCharFrame,
			(f) => f.includes("JAKE-2"),
		);
		expect(frame).not.toContain("O open issue");
	} finally {
		onPlain.destroy();
	}
});

// A span's color as `#rrggbb`, to compare with the dark ramp the render-only tests get.
const hexOf = (color: RGBA): string =>
	`#${color
		.toInts()
		.slice(0, 3)
		.map((c) => c.toString(16).padStart(2, "0"))
		.join("")}`;

const spansOf = (capture: () => { lines: { spans: CapturedSpan[] }[] }) =>
	capture().lines.flatMap((line) => line.spans);

test("heldColumns holds a gutter only while a visible row puts a glyph in it", () => {
	const rows: BoardNav.VisibleRow[] = [
		{
			task: task({ id: "a" }),
			depth: 0,
			parentId: null,
			hasChildren: false,
			expanded: false,
		},
		{
			task: task({ id: "b" }),
			depth: 0,
			parentId: null,
			hasChildren: false,
			expanded: false,
		},
	];
	expect(heldColumns(rows, new Set(), new Set())).toEqual({
		mark: false,
		link: false,
	});
	expect(heldColumns(rows, new Set(["a"]), new Set(["b"]))).toEqual({
		mark: true,
		link: true,
	});
	// A mark on a row the filter hides holds nothing: the column is for the rows on screen.
	expect(heldColumns(rows, new Set(["gone"]), new Set())).toEqual({
		mark: false,
		link: false,
	});
});

test("headerFilters is quiet unfiltered and names each filter in force", () => {
	expect(headerFilters("all", "open")).toBe("");
	expect(headerFilters("issue", "open")).toBe(" · kind: issue");
	expect(headerFilters("all", "done")).toBe(" · status: done");
	expect(headerFilters("task", "review")).toBe(
		" · kind: task · status: review",
	);
});

test("rowStyle paints a touched row on the raised surface with an explicit fg; selection still wins", () => {
	const touched = rowStyle(false, "#9ca3af", Theme.DARK, true);
	expect(touched.bg).toBe(Theme.DARK.surface.raised);
	expect(touched.titleFg).toBe(Theme.DARK.text);
	expect(touched.idFg).toBe("#9ca3af");
	const both = rowStyle(true, "#9ca3af", Theme.DARK, true);
	expect(both.bg).toBe(Theme.DARK.surface.selected);
});

test("Board shows the kind in the header only while a kind filter is on", async () => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Board
			sections={fixture}
			expanded={new Set()}
			selectedId={null}
			scopeLabel="acme/widget"
			kind="issue"
		/>,
		{ width: 120, height: 20 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("JAKE-42"),
		);
		expect(frame).toContain("kabane · acme/widget · kind: issue");
	} finally {
		destroy();
	}
});

test("Board draws a bay's label bold in the terminal's foreground and its count muted", async () => {
	const { renderOnce, captureCharFrame, captureSpans, destroy } =
		await renderTest(
			<Board sections={fixture} expanded={new Set()} selectedId={null} />,
			{ width: 120, height: 20 },
		);
	try {
		await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("next · 1"),
		);
		const spans = spansOf(captureSpans);
		const label = spans.find((span) => span.text.trim() === "next");
		const count = spans.find((span) => span.text.includes("· 1"));
		expect(label && label.attributes & TextAttributes.BOLD).toBeTruthy();
		expect(label?.fg.intent).toBe("default");
		expect(count && hexOf(count.fg)).toBe(Theme.DARK.muted);
	} finally {
		destroy();
	}
});

test("Board draws in-flight badges in the working hue and keeps the accent for input", async () => {
	const activity = activityWith(
		[activeLoop()],
		[question(fixture[0]?.rows[0]?.task.id ?? "")],
	);
	const { renderOnce, captureCharFrame, captureSpans, destroy } =
		await renderTest(
			<Board
				sections={fixture}
				expanded={new Set()}
				selectedId={null}
				activity={activity}
			/>,
			{ width: 120, height: 20 },
		);
	try {
		await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("loop · implement 3"),
		);
		const spans = spansOf(captureSpans);
		const badge = spans.find((span) => span.text.includes("loop · implement"));
		const input = spans.find((span) => span.text.includes("? input"));
		expect(badge && hexOf(badge.fg)).toBe(Theme.DARK.working);
		expect(input && hexOf(input.fg)).toBe(Theme.DARK.accent);
	} finally {
		destroy();
	}
});

test("Board footer draws each key in the bar's foreground and its label muted", async () => {
	const { renderOnce, captureCharFrame, captureSpans, destroy } =
		await renderTest(
			<Board sections={[]} expanded={new Set()} selectedId={null} />,
			{ width: 100, height: 12 },
		);
	try {
		await pumpUntil(renderOnce, captureCharFrame, (f) => f.includes("? help"));
		const spans = spansOf(captureSpans);
		// Adjacent cells of one style capture as one span: a label runs on into the separator after it.
		const key = spans.find((span) => span.text === "/");
		const label = spans.find((span) => span.text.startsWith(" search"));
		expect(key && hexOf(key.fg)).toBe(Theme.DARK.text);
		expect(label && hexOf(label.fg)).toBe(Theme.DARK.muted);
	} finally {
		destroy();
	}
});

test("the ? sheet at 40x24: frameless along the bottom, scrollable, and a key that does nothing right now is faint", async () => {
	const { renderOnce, captureCharFrame, captureSpans, destroy } =
		await renderTest(
			<HelpSheet context="board" situation={{ selection: false }} />,
			{ width: 40, height: 24 },
		);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("board"),
		);
		for (const corner of ["┌", "┐", "└", "┘", "│", "─"])
			expect(frame).not.toContain(corner);
		const rows = frame.split("\n");
		// The board's keys run past a 24-row pane, so the sheet says it scrolls; the header row
		// above it stays the view's.
		expect(rows.some((row) => row.includes("j/k scroll · ? esc close"))).toBe(
			true,
		);
		expect(rows[0]?.trim()).toBe("");
		const spans = spansOf(captureSpans);
		const title = spans.find((span) => span.text.trim() === "board");
		expect(title && hexOf(title.bg)).toBe(Theme.DARK.surface.overlay);
		expect(title && title.attributes & TextAttributes.BOLD).toBeTruthy();
		// `d` needs a selected row and there is none: faint, not gone.
		const done = spans.find(
			(span) => span.text.startsWith("d ") && span.text.includes("done"),
		);
		expect(done && hexOf(done.fg)).toBe(Theme.DARK.faint);
		// `/` works with nothing selected: its key reads brighter than its label.
		const search = spans.find((span) => span.text.trim() === "/");
		expect(search && hexOf(search.fg)).toBe(Theme.DARK.text);
	} finally {
		destroy();
	}
});
