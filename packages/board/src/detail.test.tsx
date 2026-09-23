/** @jsxImportSource @opentui/react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Planner, type TaskComment } from "@cabane/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { RefObject } from "react";
import type { BoardActivity } from "./activity";
import {
	actorName,
	cardRowLine,
	cardStatusGlyph,
	cardStatusLine,
	Detail,
	formatElapsed,
	relativeTime,
	stripTitleHeading,
} from "./detail";
import type { ActivityCard } from "./ports";
import { SPINNER_FRAMES } from "./spinner";
import { dropDb, freshDb } from "./test-db";
import { renderTest } from "./testing";

const TEST_BASE = join(import.meta.dir, ".test-detail");

const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

// The detail view loads its brief in a useEffect, so pump the renderer until the async content lands.
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

test("Detail renders the assembled brief for a seeded task", async () => {
	const added = await Planner.addTask(TEST_BASE, {
		title: "Render the detail",
		description: "The folded brief body appears here.",
		state: "next",
	});
	expect(added.ok).toBe(true);
	if (!added.ok) return;

	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Detail
			basePath={TEST_BASE}
			taskId={added.value.id}
			task={added.value}
			scrollRef={nullRef}
		/>,
		{ width: 100, height: 30 },
	);
	try {
		// Real assembleContext read path → the title and description flow through the markdown render.
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("appears"),
		);
		expect(frame).toContain("Render the detail");
		expect(frame).toContain("appears");
	} finally {
		destroy();
	}
});

test("Detail shows a loop status line for a task with an active loop", async () => {
	const added = await Planner.addTask(TEST_BASE, {
		title: "Looped task",
		description: "Body.",
		state: "in_progress",
	});
	expect(added.ok).toBe(true);
	if (!added.ok) return;

	const loop = loopCard({ taskShortId: added.value.shortId ?? "JAKE-1" });
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Detail
			basePath={TEST_BASE}
			taskId={added.value.id}
			task={added.value}
			cards={[loop]}
			scrollRef={nullRef}
		/>,
		{ width: 100, height: 30 },
	);
	try {
		// Wait for the brief body — layout is settled once the async content lands.
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("Body"),
		);
		expect(frame).toContain("loop · implement · iteration 3 · $0.42");
	} finally {
		destroy();
	}
});

test("Detail renders the awaiting-input question block above the brief", async () => {
	const added = await Planner.addTask(TEST_BASE, {
		title: "Blocked task",
		description: "The brief body.",
		state: "in_progress",
	});
	expect(added.ok).toBe(true);
	if (!added.ok) return;

	const questions: BoardActivity.AwaitingQuestion[] = [
		{
			taskId: added.value.id,
			sessionId: "sess-1",
			questionActivityId: "act-1",
			question: "Which auth flow should the CLI use?",
		},
	];
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Detail
			basePath={TEST_BASE}
			taskId={added.value.id}
			task={added.value}
			questions={questions}
			scrollRef={nullRef}
		/>,
		{ width: 100, height: 30 },
	);
	try {
		// Wait for the brief body — layout is settled once the async content lands.
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("The brief body"),
		);
		expect(frame).toContain("? awaiting input: Which auth flow should the CLI");
		expect(frame).toContain("answer: cabane needs-input");
	} finally {
		destroy();
	}
});

test("cardStatusLine covers paused and stale-agnostic running text", () => {
	const running = loopCard({ detail: ["verify", "iteration 2", "$1.50"] });
	// No frame threaded: the detail view echoes the sidebar, which animates these same cards.
	expect(cardStatusLine(running)).toBe("● loop · verify · iteration 2 · $1.50");
	expect(cardStatusLine({ ...running, status: "paused" })).toBe(
		"⏸ loop · paused",
	);
});

test("Detail falls back to a plain error message when the task is missing", async () => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Detail
			basePath={TEST_BASE}
			taskId="01H000000000000000000MISSING"
			scrollRef={nullRef}
		/>,
		{ width: 100, height: 30 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.toLowerCase().includes("found"),
		);
		expect(frame.toLowerCase()).toContain("found");
	} finally {
		destroy();
	}
});

test("stripTitleHeading drops the leading `# ` heading and its blank line, nothing else", () => {
	expect(stripTitleHeading("# Title\n\nBody line\n## Sub")).toBe(
		"Body line\n## Sub",
	);
	// Leading blank lines before the heading are tolerated.
	expect(stripTitleHeading("\n# Title\nBody")).toBe("Body");
	// No h1 heading -> untouched (h2 is NOT the duplicated title).
	expect(stripTitleHeading("## Section\nBody")).toBe("## Section\nBody");
	expect(stripTitleHeading("plain text")).toBe("plain text");
});

test("Detail hides the brief's duplicate `# ` title and shows the trimmed footer", async () => {
	const added = await Planner.addTask(TEST_BASE, {
		title: "Unique Sunflower Title",
		description: "Recognizable body content.",
		state: "next",
	});
	expect(added.ok).toBe(true);
	if (!added.ok) return;

	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Detail
			basePath={TEST_BASE}
			taskId={added.value.id}
			task={added.value}
			scrollRef={nullRef}
		/>,
		{ width: 100, height: 24 },
	);
	const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
		f.includes("Recognizable body content."),
	);
	destroy();

	// Header shows the title once; the brief's own `# ` heading is stripped, so exactly one occurrence.
	const occurrences = frame.split("Unique Sunflower Title").length - 1;
	expect(occurrences).toBe(1);
	// Trimmed footer: app-specific keys + `? help`, none of the vim-obvious ones.
	expect(frame).toContain("? help");
	expect(frame).not.toContain("j/k scroll");
});

// --- Pure function tests for new helpers ---

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

test("Detail renders the activity block when cards are provided", async () => {
	const added = await Planner.addTask(TEST_BASE, {
		title: "Task with runs",
		description: "Body.",
		state: "in_progress",
	});
	expect(added.ok).toBe(true);
	if (!added.ok) return;

	const cards: ActivityCard[] = [
		runCard({ id: "r1", taskId: added.value.id, hasEvents: true }),
		runCard({
			id: "r2",
			label: "investigate",
			status: "completed",
			taskId: added.value.id,
			finishedAt: new Date().toISOString(),
			durationMs: 134000,
			hasEvents: true,
		}),
	];
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Detail
			basePath={TEST_BASE}
			taskId={added.value.id}
			task={added.value}
			cards={cards}
			scrollRef={nullRef}
		/>,
		{ width: 100, height: 30 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("Body"),
		);
		expect(frame).toContain("activity");
		expect(frame).toContain("scout");
		expect(frame).toContain("investigate");
		// Footer should include the "o events" hint when a card has events.
		expect(frame).toContain("o events");
	} finally {
		destroy();
	}
});

test("Detail renders comments section when comments are provided", async () => {
	const added = await Planner.addTask(TEST_BASE, {
		title: "Task with comments",
		description: "Body.",
		state: "next",
	});
	expect(added.ok).toBe(true);
	if (!added.ok) return;

	const comments: TaskComment[] = [
		{
			id: "c1",
			taskId: added.value.id,
			author: "david",
			authorType: "human",
			content: "Let's go with option B",
			createdAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
		},
		{
			id: "c2",
			taskId: added.value.id,
			author: "claude",
			authorType: "ai",
			content: "Implemented option B per feedback.",
			createdAt: new Date(Date.now() - 86400_000).toISOString(),
		},
	];
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Detail
			basePath={TEST_BASE}
			taskId={added.value.id}
			task={added.value}
			comments={comments}
			scrollRef={nullRef}
		/>,
		{ width: 100, height: 30 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("Body"),
		);
		expect(frame).toContain("comments · 2");
		expect(frame).toContain("david");
		expect(frame).toContain("option B");
	} finally {
		destroy();
	}
});

test("Detail does not show the o events hint when no card has events", async () => {
	const added = await Planner.addTask(TEST_BASE, {
		title: "Task without activity",
		description: "Body content here.",
		state: "next",
	});
	expect(added.ok).toBe(true);
	if (!added.ok) return;

	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<Detail
			basePath={TEST_BASE}
			taskId={added.value.id}
			task={added.value}
			scrollRef={nullRef}
		/>,
		{ width: 100, height: 30 },
	);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("Body content here"),
		);
		// The footer line should not contain the "o events" hint.
		const footerLine = frame.split("\n").find((l) => l.includes("? help"));
		expect(footerLine).toBeDefined();
		expect(footerLine).not.toContain("o events");
	} finally {
		destroy();
	}
});

test("actorName names an actor URI by its last segment and passes anything else through", () => {
	expect(actorName("cabane://actor/agent/claude")).toBe("claude");
	expect(actorName("cabane://actor/human/david-paquet")).toBe("david-paquet");
	expect(actorName("david")).toBe("david");
});

test("Detail names a comment's author, not its actor URI, on a raised block", async () => {
	const added = await Planner.addTask(TEST_BASE, {
		title: "Task with an agent comment",
		description: "Body.",
		state: "next",
	});
	expect(added.ok).toBe(true);
	if (!added.ok) return;
	const comments: TaskComment[] = [
		{
			id: "c1",
			taskId: added.value.id,
			author: "cabane://actor/agent/claude",
			authorType: "ai",
			content: "Picked this up, tests next.",
			createdAt: new Date(Date.now() - 60_000).toISOString(),
		},
	];
	const { renderOnce, captureCharFrame, captureSpans, destroy } =
		await renderTest(
			<Detail
				basePath={TEST_BASE}
				taskId={added.value.id}
				task={added.value}
				comments={comments}
				scrollRef={nullRef}
			/>,
			{ width: 40, height: 30 },
		);
	try {
		const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("Picked this up"),
		);
		expect(frame).toContain("claude · 1m ago");
		expect(frame).not.toContain("cabane://actor");
		const body = captureSpans()
			.lines.flatMap((line) => line.spans)
			.find((span) => span.text.includes("Picked this up"));
		expect(body?.bg.toInts().slice(0, 3)).toEqual([0x1c, 0x1c, 0x1c]);
	} finally {
		destroy();
	}
});
