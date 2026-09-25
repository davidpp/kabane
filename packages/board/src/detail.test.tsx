/** @jsxImportSource @opentui/react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Planner, type Result, type Task } from "@cabane/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { RefObject } from "react";
import type { BoardActivity } from "./activity";
import { BoardData } from "./data";
import {
	cardRowLine,
	cardStatusGlyph,
	cardStatusLine,
	Detail,
	formatElapsed,
	relativeTime,
} from "./detail";
import type { DetailModel } from "./detail-model";
import type { ActivityCard } from "./ports";
import { SPINNER_FRAMES } from "./spinner";
import { dropDb, freshDb } from "./test-db";
import { renderTest } from "./testing";

const TEST_BASE = join(import.meta.dir, ".test-detail");

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

// Markdown lands a frame or two after the first render, so pump until the content is on screen.
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

const nullRef: RefObject<ScrollBoxRenderable | null> = { current: null };

beforeEach(async () => {
	await freshDb(TEST_BASE);
});

afterEach(() => {
	dropDb(TEST_BASE);
});

const seed = async (
	over: Partial<Parameters<typeof Planner.addTask>[1]> = {},
) => {
	const added = await Planner.addTask(TEST_BASE, {
		title: "Render the detail",
		description: "The description reads here.",
		state: "next",
		...over,
	});
	if (!added.ok) throw added.error;
	return added.value;
};

// The records the app hands the view, read the way it reads them.
const recordsOf = (task: Task): Promise<Result<BoardData.DetailRecords>> =>
	BoardData.taskDetail(TEST_BASE, task.id);

const mount = async (
	task: Task,
	{
		tab,
		width = 100,
		height = 30,
		cards,
		questions,
	}: {
		tab?: DetailModel.Tab;
		width?: number;
		height?: number;
		cards?: ActivityCard[];
		questions?: BoardActivity.AwaitingQuestion[];
	} = {},
) =>
	renderTest(
		<Detail
			taskId={task.id}
			task={task}
			records={await recordsOf(task)}
			tab={tab}
			cards={cards}
			questions={questions}
			scrollRef={nullRef}
		/>,
		{ width, height },
	);

const rows = (frame: string): string[] => frame.split("\n");
const onOneRow = (frame: string, text: string): boolean =>
	rows(frame).some((row) => row.includes(text));

// A host "loop" card the way Jake would project one: label + three detail lines.
const loopCard = (over: Partial<ActivityCard> = {}): ActivityCard => ({
	id: "loop-JAKE-1",
	kind: "loops",
	label: "loop",
	status: "running",
	taskShortId: "JAKE-1",
	startedAt: new Date().toISOString(),
	detail: ["implement", "iteration 3", "$0.42"],
	...over,
});

// A host "run" card: label is the recipe name, no detail lines.
const runCard = (over: Partial<ActivityCard> = {}): ActivityCard => ({
	id: "r1",
	kind: "runs",
	label: "scout",
	status: "running",
	taskId: "t1",
	startedAt: new Date().toISOString(),
	detail: [],
	...over,
});

test("Detail opens on the description, with the title once, the task at a glance and the tab bar", async () => {
	const task = await seed({ title: "Unique Sunflower Title" });
	const { renderOnce, captureCharFrame, destroy } = await mount(task);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("The description reads here."),
		);
		expect(frame.split("Unique Sunflower Title").length - 1).toBe(1);
		expect(frame).toContain("next · task");
		expect(onOneRow(frame, "description")).toBe(true);
		expect(frame).toContain("comments 0");
		expect(frame).toContain("log 0");
		// The agent brief is not drawn: none of its headings reach the screen.
		expect(frame).not.toContain("## ");
		expect(frame).not.toContain("Description\n");
		// Trimmed footer: app-specific keys + `? help`, none of the vim-obvious ones.
		expect(frame).toContain("h/l tabs");
		expect(frame).toContain("? help");
		expect(frame).not.toContain("j/k scroll");
	} finally {
		destroy();
	}
});

test("Detail says so when a task has no description", async () => {
	const task = await seed({ description: undefined });
	const { renderOnce, captureCharFrame, destroy } = await mount(task);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("no description"),
		);
		expect(frame).toContain("no description");
	} finally {
		destroy();
	}
});

test("Detail shows a loop status line for a task with an active loop", async () => {
	const task = await seed({ state: "in_progress" });
	const loop = loopCard({ taskShortId: task.shortId ?? "JAKE-1" });
	const { renderOnce, captureCharFrame, destroy } = await mount(task, {
		cards: [loop],
	});
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("reads here"),
		);
		expect(frame).toContain("loop · implement · iteration 3 · $0.42");
	} finally {
		destroy();
	}
});

test("Detail pins a waiting question above the tabs, with no answer hint for a command that does not exist", async () => {
	const task = await seed({ state: "in_progress" });
	const questions: BoardActivity.AwaitingQuestion[] = [
		{
			taskId: task.id,
			sessionId: "sess-1",
			questionActivityId: "act-1",
			question: "Which auth flow should the CLI use?",
		},
	];
	const { renderOnce, captureCharFrame, destroy } = await mount(task, {
		questions,
	});
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("reads here"),
		);
		const question = rows(frame).findIndex((r) =>
			r.includes("? Which auth flow should the CLI use?"),
		);
		const bar = rows(frame).findIndex((r) => r.includes("comments 0"));
		expect(question).toBeGreaterThan(-1);
		expect(question).toBeLessThan(bar);
		expect(frame).not.toContain("answer:");
		expect(frame).not.toContain("needs-input");
	} finally {
		destroy();
	}
});

test("Detail falls back to a plain error message when the task is missing", async () => {
	const records = await BoardData.taskDetail(
		TEST_BASE,
		"01H000000000000000000MISSING",
	);
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Detail
			taskId="01H000000000000000000MISSING"
			records={records}
			scrollRef={nullRef}
		/>,
		{ width: 100, height: 30 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.toLowerCase().includes("found"),
		);
		expect(frame.toLowerCase()).toContain("not found");
	} finally {
		destroy();
	}
});

test("Detail shows loading until the records arrive", async () => {
	const task = await seed();
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Detail taskId={task.id} task={task} scrollRef={nullRef} />,
		{ width: 100, height: 30 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("loading"),
		);
		expect(frame).toContain("loading");
		expect(frame).toContain("Render the detail");
	} finally {
		destroy();
	}
});

test("Detail's log heads with the host's cards and offers the o events hint", async () => {
	const task = await seed({ state: "in_progress" });
	const cards: ActivityCard[] = [
		runCard({ id: "r1", taskId: task.id, hasEvents: true }),
		runCard({
			id: "r2",
			label: "investigate",
			status: "completed",
			taskId: task.id,
			finishedAt: new Date().toISOString(),
			durationMs: 134000,
			hasEvents: true,
		}),
	];
	const { renderOnce, captureCharFrame, destroy } = await mount(task, {
		tab: "log",
		cards,
	});
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("investigate"),
		);
		expect(frame).toContain("scout");
		expect(frame).toContain("investigate · completed · 2m14s");
		expect(frame).toContain("log 2");
		expect(frame).toContain("o events");
	} finally {
		destroy();
	}
});

test("Detail's log puts work logs and session activity on one line each, newest first, and pins the open question instead", async () => {
	const task = await seed({ state: "in_progress" });
	const session = await Planner.startSession(TEST_BASE, {
		taskId: task.id,
		agent: "claude",
	});
	if (!session.ok) throw session.error;
	const add = async (
		draft: Omit<Parameters<typeof Planner.addActivity>[1], "sessionId">,
	) => {
		const added = await Planner.addActivity(TEST_BASE, {
			sessionId: session.value.id,
			...draft,
		});
		if (!added.ok) throw added.error;
		await sleep(5);
		return added.value;
	};
	await add({ type: "progress", body: "read the brief" });
	const q = await add({ type: "question", body: "Tabs or one scroll?" });
	await add({ type: "decision", body: "tabs", context: `answers ${q.id}` });
	await add({ type: "question", body: "Which tab opens first?" });
	await add({ type: "error", body: "the gate failed on biome" });
	const logged = await Planner.addWorkLog(TEST_BASE, {
		taskId: task.id,
		refs: [{ uri: "commit:6f2a9c1d0e3b4a5f" }],
		note: "landed the tabs",
	});
	if (!logged.ok) throw logged.error;

	const { renderOnce, captureCharFrame, captureSpans, destroy } = await mount(
		task,
		{ tab: "log" },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("landed the tabs"),
		);
		expect(frame).toContain("• commit 6f2a9c1 · landed the tabs");
		expect(frame).toContain("✗ error the gate failed on biome");
		expect(frame).toContain("· decision tabs");
		expect(frame).toContain("· question Tabs or one scroll?");
		expect(frame).toContain("· progress read the brief");
		// The open question is pinned above the tabs and nowhere else.
		expect(frame.split("Which tab opens first?").length - 1).toBe(1);
		expect(frame).toContain("? Which tab opens first?");
		const commit = rows(frame).findIndex((r) => r.includes("landed the tabs"));
		const progress = rows(frame).findIndex((r) => r.includes("read the brief"));
		expect(commit).toBeLessThan(progress);
		const error = captureSpans()
			.lines.flatMap((line) => line.spans)
			.find((span) => span.text.includes("the gate failed"));
		expect(error?.fg.toInts().slice(0, 3)).toEqual([0xef, 0x44, 0x44]);
	} finally {
		destroy();
	}
});

test("Detail's comments tab shows every comment whole, newest first", async () => {
	const task = await seed();
	for (const [author, content] of [
		["david", "Let's go with option B\nbecause it keeps the scan."],
		["cabane://actor/agent/claude", "Implemented option B per feedback."],
	] as const) {
		const added = await Planner.addComment(TEST_BASE, {
			taskId: task.id,
			author,
			authorType: author === "david" ? "human" : "ai",
			content,
		});
		if (!added.ok) throw added.error;
		await sleep(5);
	}
	const { renderOnce, captureCharFrame, destroy } = await mount(task, {
		tab: "comments",
	});
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("keeps the scan"),
		);
		expect(frame).toContain("comments 2");
		expect(frame).toContain("because it keeps the scan.");
		expect(frame).not.toContain("cabane://actor");
		const agent = rows(frame).findIndex((r) => r.includes("claude ·"));
		const human = rows(frame).findIndex((r) => r.includes("david ·"));
		expect(agent).toBeGreaterThan(-1);
		expect(agent).toBeLessThan(human);
	} finally {
		destroy();
	}
});

test("Detail heads a comment with a raised author band at forty columns, and sets what was said on the terminal's own background", async () => {
	const task = await seed();
	const added = await Planner.addComment(TEST_BASE, {
		taskId: task.id,
		author: "cabane://actor/agent/claude",
		authorType: "ai",
		content: "Picked this up, `bun test` next.",
	});
	if (!added.ok) throw added.error;
	const { renderOnce, captureCharFrame, captureSpans, destroy } = await mount(
		task,
		{ tab: "comments", width: 40 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("Picked this up"),
		);
		expect(frame).toContain("claude · just now");
		const spans = captureSpans().lines.flatMap((line) => line.spans);
		const bgOf = (text: string) =>
			spans.find((span) => span.text.includes(text))?.bg.toInts();
		expect(bgOf("claude")?.slice(0, 3)).toEqual([0x1c, 0x1c, 0x1c]);
		expect(bgOf("Picked this up")?.[3]).toBe(0);
		// Inline code keeps a surface of its own, so it still reads as code under the band.
		expect(bgOf("bun test")?.slice(0, 3)).toEqual([0x26, 0x26, 0x26]);
	} finally {
		destroy();
	}
});

test("Detail sets a quote and a code block on panels, with no line drawn beside or across them", async () => {
	const task = await seed({
		description:
			"> the cube is ported\n\n```sh\nbunx vite\n```\n\n---\n\nafter the rule",
	});
	const { renderOnce, captureCharFrame, captureSpans, destroy } =
		await mount(task);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("after the rule"),
		);
		expect(frame).not.toMatch(/[│─]/);
		const spans = captureSpans().lines.flatMap((line) => line.spans);
		for (const text of ["the cube is ported", "bunx vite"])
			expect({
				text,
				bg: spans
					.find((span) => span.text.includes(text))
					?.bg.toInts()
					.slice(0, 3),
			}).toEqual({ text, bg: [0x1c, 0x1c, 0x1c] });
	} finally {
		destroy();
	}
});

test("Detail's tab bar reads whole at forty columns and paints the active tab", async () => {
	const task = await seed();
	const { renderOnce, captureCharFrame, captureSpans, destroy } = await mount(
		task,
		{ tab: "comments", width: 40 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("no comments"),
		);
		expect(onOneRow(frame, " description  comments 0  log 0 ")).toBe(true);
		const active = captureSpans()
			.lines.flatMap((line) => line.spans)
			.find((span) => span.text.includes("comments"));
		expect(active?.bg.toInts().slice(0, 3)).toEqual([0x2f, 0x2f, 0x2f]);
	} finally {
		destroy();
	}
});

test("Detail hands a click on a tab to onTab", async () => {
	const task = await seed();
	const clicked: DetailModel.Tab[] = [];
	const { renderOnce, captureCharFrame, mockMouse, destroy } = await renderTest(
		<Detail
			taskId={task.id}
			task={task}
			records={await recordsOf(task)}
			onTab={(tab) => clicked.push(tab)}
			scrollRef={nullRef}
		/>,
		{ width: 40, height: 24 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("reads here"),
		);
		const y = rows(frame).findIndex((r) => r.includes("log 0"));
		const x = rows(frame)[y]?.indexOf("log 0") ?? -1;
		expect(y).toBeGreaterThan(-1);
		await mockMouse.click(x + 1, y);
		await renderOnce();
		expect(clicked).toEqual(["log"]);
	} finally {
		destroy();
	}
});

test("Detail does not show the o events hint when no card has events", async () => {
	const task = await seed();
	const { renderOnce, captureCharFrame, destroy } = await mount(task);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("reads here"),
		);
		const footerLine = frame.split("\n").find((l) => l.includes("? help"));
		expect(footerLine).toBeDefined();
		expect(footerLine).not.toContain("o events");
	} finally {
		destroy();
	}
});

// --- Pure helpers ---

test("cardStatusLine covers paused and stale-agnostic running text", () => {
	const running = loopCard({ detail: ["verify", "iteration 2", "$1.50"] });
	// No frame threaded: the detail view echoes the sidebar, which animates these same cards.
	expect(cardStatusLine(running)).toBe("● loop · verify · iteration 2 · $1.50");
	expect(cardStatusLine({ ...running, status: "paused" })).toBe(
		"⏸ loop · paused",
	);
});

test("cardStatusLine uses spinnerFrame when provided and the card is not stale", () => {
	const line = cardStatusLine(loopCard(), "⠹");
	expect(line).toBe("⠹ loop · implement · iteration 3 · $0.42");
});

test("cardStatusLine uses SPINNER_IDLE when the card is stale even if spinnerFrame is provided", () => {
	const line = cardStatusLine(loopCard({ stale: true }), "⠹");
	expect(line).toBe(
		`${SPINNER_FRAMES[0]} loop · implement · iteration 3 · $0.42`,
	);
});

test("cardStatusGlyph returns animated frame for running/pending, • for completed, ✗ for failed, ⏸ paused", () => {
	expect(cardStatusGlyph("running", "⠹")).toBe("⠹");
	expect(cardStatusGlyph("pending", "⠹")).toBe("⠹");
	expect(cardStatusGlyph("completed")).toBe("•");
	expect(cardStatusGlyph("failed")).toBe("✗");
	expect(cardStatusGlyph("paused")).toBe("⏸");
});

test("formatElapsed formats durations correctly", () => {
	expect(formatElapsed(undefined)).toBe("");
	expect(formatElapsed(5000)).toBe("5s");
	expect(formatElapsed(0)).toBe("0s");
	expect(formatElapsed(134000)).toBe("2m14s");
	expect(formatElapsed(60000)).toBe("1m");
	expect(formatElapsed(3600000)).toBe("1h");
	expect(formatElapsed(3780000)).toBe("1h3m");
});

test("cardRowLine formats a complete card line", () => {
	expect(cardRowLine(runCard(), "⠹")).toBe("⠹ scout · running");
	expect(
		cardRowLine(runCard({ status: "completed", durationMs: 134000 })),
	).toBe("• scout · completed · 2m14s");
});

test("relativeTime formats relative timestamps", () => {
	const now = Date.now();
	expect(relativeTime(new Date(now - 30_000).toISOString(), now)).toBe(
		"just now",
	);
	expect(relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe(
		"5m ago",
	);
	expect(relativeTime(new Date(now - 3 * 3600_000).toISOString(), now)).toBe(
		"3h ago",
	);
	expect(relativeTime(new Date(now - 2 * 86400_000).toISOString(), now)).toBe(
		"2d ago",
	);
});

test("Detail at 40 columns: the subtask count pinned, and the subtasks and context under the description, each once and whole", async () => {
	const parent = await seed({ title: "Parent plan" });
	for (const [title, state] of [
		["First step", "done"],
		["Second step", "in_progress"],
		["Third step", "next"],
	] as const) {
		const child = await seed({ title, state, parentTaskId: parent.id });
		expect(child.parentTaskId).toBe(parent.id);
	}
	for (const [uri, kind, label] of [
		["obsidian:prds/cabane.md", "PRD", "Cabane PRD"],
		["docs/adr.md", "ADR", undefined],
	] as const) {
		const added = await Planner.addContextRef(TEST_BASE, {
			taskId: parent.id,
			uri,
			kind,
			label,
		});
		expect(added.ok).toBe(true);
	}
	const { renderOnce, captureCharFrame, destroy } = await mount(parent, {
		width: 40,
		height: 30,
	});
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("Third step"),
		);
		expect(onOneRow(frame, "subtasks 3 · 1 done")).toBe(true);
		for (const text of [
			"First step",
			"Second step",
			"Third step",
			"Cabane PRD",
		])
			expect(frame.split(text).length - 1).toBe(1);
		// The state is held at the row's right, so a long title never pushes it off.
		const working = rows(frame).find((row) => row.includes("Second step"));
		expect(working?.trimEnd().endsWith("in progress")).toBe(true);
		expect(onOneRow(frame, "ADR docs/adr.md")).toBe(true);
		for (const row of rows(frame))
			expect(row.trimEnd().length).toBeLessThanOrEqual(40);
	} finally {
		destroy();
	}
});
