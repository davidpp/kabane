/** @jsxImportSource @opentui/react */
// The transcript's head. A card that carries a plan gets it pinned above the scrollbox — the point
// being that it survives the events scrolling under it — and a host card, which has no such thing,
// keeps the one-line header it always had. Then the transcript's look against DESIGN.md: each turn
// opens on its prompt as a raised block, not a rule; glyphs carry the hues; the text keeps a hanging
// indent at forty columns.
import { describe, expect, it } from "bun:test";
import { ok } from "@cabane/core";
import {
	type CapturedSpan,
	RGBA,
	type ScrollBoxRenderable,
	TextAttributes,
} from "@opentui/core";
import { createRef } from "react";
import { EventView, promptLines, toolParts } from "./event-view";
import type {
	ActivityCard,
	ActivityEvent,
	ActivitySource,
	PlanEntry,
} from "./ports";
import { pumpUntil, renderTest } from "./testing";
import { Theme } from "./theme";

const T0 = "2026-09-12T10:00:00.000Z";

const PLAN: readonly PlanEntry[] = [
	{ content: "read the issue", status: "completed" },
	{ content: "create the subtasks", status: "in_progress" },
	{ content: "link the blockers", status: "pending" },
];

const copilotCard: ActivityCard = {
	id: "copilot",
	kind: "copilot",
	label: "copilot",
	status: "running",
	startedAt: T0,
	detail: [],
	hasEvents: true,
};

const hostCard: ActivityCard = {
	id: "r1",
	kind: "runs",
	label: "scout",
	status: "completed",
	startedAt: T0,
	finishedAt: T0,
	detail: [],
	hasEvents: true,
};

// More events than the scrollbox can show, so scrolling it has something to hide.
const lines: ActivityEvent[] = Array.from({ length: 30 }, (_, i) => ({
	seq: i + 1,
	at: T0,
	type: "text",
	summary: `line ${String(i + 1).padStart(2, "0")}`,
}));

const source = (card: ActivityCard): ActivitySource => ({
	load: async () => ok([card]),
	card: async () => ok(card),
	events: async (_id, afterSeq) => ok(lines.filter((e) => e.seq > afterSeq)),
});

describe("EventView", () => {
	it("pins the plan above the scrollbox, so it is still there once the events have scrolled past", async () => {
		const scrollRef = createRef<ScrollBoxRenderable>();
		const setup = await renderTest(
			<EventView
				cardId="copilot"
				initialCard={copilotCard}
				source={source(copilotCard)}
				resolveShortId={() => undefined}
				scrollRef={scrollRef}
				plan={PLAN}
			/>,
			{ width: 80, height: 16 },
		);
		const { renderOnce, captureCharFrame, destroy } = setup;
		const until = (p: (f: string) => boolean) =>
			pumpUntil(renderOnce, captureCharFrame, p);
		try {
			// The pending glyph is the transcript's own — no event row draws one. The plan is up a
			// frame before the first poll answers, so wait for both.
			const frame = await until(
				(f) => f.includes("○ link the blockers") && f.includes("line 01"),
			);
			expect(frame).toContain("✓ read the issue");
			expect(frame).toContain("create the subtasks");
			// Above the events, not among them.
			expect(frame.indexOf("read the issue")).toBeLessThan(
				frame.indexOf("line 01"),
			);

			scrollRef.current?.scrollBy(20);
			const scrolled = await until((f) => !f.includes("line 01"));
			expect(scrolled).toContain("○ link the blockers");
			expect(scrolled).toContain("✓ read the issue");
		} finally {
			destroy();
		}
	});

	it("a host card has no plan to pin and keeps the one-line header", async () => {
		const scrollRef = createRef<ScrollBoxRenderable>();
		const setup = await renderTest(
			<EventView
				cardId="r1"
				initialCard={hostCard}
				source={source(hostCard)}
				resolveShortId={() => undefined}
				scrollRef={scrollRef}
			/>,
			{ width: 80, height: 16 },
		);
		const { renderOnce, captureCharFrame, destroy } = setup;
		try {
			const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
				f.includes("line 01"),
			);
			expect(frame).toMatch(/scout · — · completed · 0s/);
			// Nothing between the header and the first event.
			expect(frame).not.toContain("○");
			expect(frame.indexOf("scout ·")).toBeLessThan(frame.indexOf("line 01"));
		} finally {
			destroy();
		}
	});
});

const rgb = (hex: string): number[] => RGBA.fromHex(hex).toInts().slice(0, 3);
const ints = (color: RGBA): number[] => color.toInts().slice(0, 3);

const spanWith = (
	spans: readonly CapturedSpan[],
	text: string,
): CapturedSpan | undefined => spans.find((span) => span.text.includes(text));

const PROMPT = "split JREP-1 into subtasks and link the blockers between them";

const turn: ActivityEvent[] = [
	{ seq: 1, at: T0, type: "prompt", summary: PROMPT },
	{ seq: 2, at: T0, type: "tool_use", summary: "Read src/app.tsx" },
	{ seq: 3, at: T0, type: "tool_result", summary: "ok" },
	{
		seq: 4,
		at: T0,
		type: "text",
		summary:
			"Split it in three: the pane, the transcript, and the plan block, linked in that order.",
	},
	{ seq: 5, at: T0, type: "error", summary: "harness exited" },
];

const turnSource: ActivitySource = {
	load: async () => ok([copilotCard]),
	card: async () => ok(copilotCard),
	events: async (_id, afterSeq) => ok(turn.filter((e) => e.seq > afterSeq)),
};

const mountTurn = async (width: number) => {
	const setup = await renderTest(
		<EventView
			cardId="copilot"
			initialCard={copilotCard}
			source={turnSource}
			resolveShortId={() => undefined}
			scrollRef={createRef<ScrollBoxRenderable>()}
		/>,
		{ width, height: 24 },
	);
	const frame = await pumpUntil(setup.renderOnce, setup.captureCharFrame, (f) =>
		f.includes("harness exited"),
	);
	return { ...setup, frame };
};

describe("the transcript's look", () => {
	it("opens the turn on its prompt as a raised block, never a rule", async () => {
		const { frame, captureSpans, destroy } = await mountTurn(40);
		try {
			expect(frame).not.toContain("──");
			const spans = captureSpans().lines.flatMap((line) => line.spans);
			const prompt = spanWith(spans, "split JREP-1");
			expect(prompt && ints(prompt.bg)).toEqual(rgb(Theme.DARK.surface.raised));
			// Wrapped rather than cut: the whole question is on screen at forty columns.
			expect(frame).toContain("between them");
		} finally {
			destroy();
		}
	});

	it("gives the glyphs the hues and the tool's arguments the aside", async () => {
		const { captureSpans, destroy } = await mountTurn(80);
		try {
			const spans = captureSpans().lines.flatMap((line) => line.spans);
			const gear = spanWith(spans, "⚙");
			expect(gear && ints(gear.fg)).toEqual(rgb(Theme.DARK.working));
			const name = spanWith(spans, "Read");
			expect(name?.fg.intent).toBe("default");
			const args = spanWith(spans, "src/app.tsx");
			expect(args && ints(args.fg)).toEqual(rgb(Theme.DARK.muted));
			expect((args?.attributes ?? 0) & TextAttributes.ITALIC).toBeTruthy();
			const failed = spanWith(spans, "harness exited");
			expect(failed && ints(failed.fg)).toEqual(rgb(Theme.DARK.failed));
			// A running card heads in the working hue, not the accent.
			const status = spanWith(spans, "running");
			expect(status && ints(status.fg)).toEqual(rgb(Theme.DARK.working));
		} finally {
			destroy();
		}
	});

	it("wraps the agent's text under itself, not back to column 0", async () => {
		const { frame, destroy } = await mountTurn(40);
		try {
			const rows = frame.split("\n");
			const first = rows.findIndex((row) => row.includes("Split it in"));
			const next = rows[first + 1] ?? "";
			// The continuation starts under the text, past the time and the glyph.
			expect(next.slice(0, 11).trim()).toBe("");
			expect(next.trim().length).toBeGreaterThan(0);
		} finally {
			destroy();
		}
	});

	it("puts a waiting question on the raised surface, its body in the text color", async () => {
		const setup = await renderTest(
			<EventView
				cardId="copilot"
				initialCard={copilotCard}
				source={turnSource}
				resolveShortId={() => undefined}
				scrollRef={createRef<ScrollBoxRenderable>()}
				permission={{
					id: "p1",
					title: "kabane_edit JREP-1",
					options: [{ id: "once", label: "Allow once" }],
				}}
			/>,
			{ width: 40, height: 24 },
		);
		try {
			await pumpUntil(setup.renderOnce, setup.captureCharFrame, (f) =>
				f.includes("kabane_edit JREP-1"),
			);
			const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
			const body = spanWith(spans, "kabane_edit JREP-1");
			expect(body && ints(body.bg)).toEqual(rgb(Theme.DARK.surface.raised));
			expect(body && ints(body.fg)).toEqual(rgb(Theme.DARK.text));
		} finally {
			setup.destroy();
		}
	});

	it("says loading in the chrome's lowercase while the card is unknown", async () => {
		const setup = await renderTest(
			<EventView
				cardId="copilot"
				initialCard={undefined}
				source={{ load: async () => ok([]), card: async () => ok(null) }}
				resolveShortId={() => undefined}
				scrollRef={createRef<ScrollBoxRenderable>()}
			/>,
			{ width: 40, height: 10 },
		);
		try {
			const frame = await pumpUntil(
				setup.renderOnce,
				setup.captureCharFrame,
				(f) => f.includes("loading"),
			);
			expect(frame).toContain("loading…");
			expect(frame).not.toContain("Loading");
		} finally {
			setup.destroy();
		}
	});
});

describe("promptLines", () => {
	it("wraps at word boundaries, keeps the prompt's own breaks, and drops blank lines", () => {
		expect(promptLines("split this\n\ninto subtasks", 40, 3)).toEqual([
			"split this",
			"into subtasks",
		]);
		expect(promptLines("one two three four", 9, 3)).toEqual([
			"one two",
			"three",
			"four",
		]);
	});

	it("holds a long prompt to its rows and says there was more", () => {
		// A full last row gives its last cell to the ellipsis; a short one gains it.
		expect(promptLines("a b c d e f g h", 3, 2)).toEqual(["a b", "c …"]);
		expect(promptLines("aa bb cc dd", 6, 1)).toEqual(["aa bb…"]);
		expect(promptLines("", 10, 3)).toEqual([""]);
	});
});

describe("toolParts", () => {
	it("splits a tool from what it was called on, and leaves a quoted command whole", () => {
		expect(toolParts("Read src/app.tsx")).toEqual({
			name: "Read",
			args: "src/app.tsx",
		});
		expect(toolParts("mcp__kabane__kabane_list")).toEqual({
			name: "mcp__kabane__kabane_list",
			args: "",
		});
		expect(toolParts("`git status --short`")).toEqual({
			name: "`git status --short`",
			args: "",
		});
	});
});
