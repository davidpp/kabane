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
import { act, createRef, useEffect, useState } from "react";
import { EventView, promptLines } from "./event-view";
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

	it("polls a card again once the board's poll sees it in flight again", async () => {
		const { finishedAt: _over, ...running } = hostCard;
		let current: ActivityCard = { ...hostCard, status: "failed" };
		let shown: ActivityEvent[] = [
			{ seq: 1, at: T0, type: "text", summary: "before it died" },
		];
		const restartable: ActivitySource = {
			load: async () => ok([current]),
			card: async () => ok(current),
			events: async (_id, afterSeq) =>
				ok(shown.filter((e) => e.seq > afterSeq)),
		};
		const handle = { relaunch: (_card: ActivityCard): void => {} };
		const Polled = () => {
			const [card, setCard] = useState(current);
			useEffect(() => {
				handle.relaunch = setCard;
			}, []);
			return (
				<EventView
					cardId="r1"
					initialCard={card}
					source={restartable}
					resolveShortId={() => undefined}
					scrollRef={createRef<ScrollBoxRenderable>()}
				/>
			);
		};
		const { renderOnce, captureCharFrame, destroy } = await renderTest(
			<Polled />,
			{ width: 80, height: 16 },
		);
		const until = (p: (f: string) => boolean) =>
			pumpUntil(renderOnce, captureCharFrame, p);
		try {
			await until((f) => f.includes("before it died"));
			// The host restarts the work, and the board's own poll hands the view the running card.
			current = { ...running, status: "running" };
			shown = [
				...shown,
				{ seq: 2, at: T0, type: "text", summary: "after the restart" },
			];
			act(() => handle.relaunch(current));
			const frame = await until((f) => f.includes("after the restart"));
			expect(frame).toContain("before it died");
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
	// The agent's markdown lays out a frame after the plain rows around it.
	const frame = await pumpUntil(
		setup.renderOnce,
		setup.captureCharFrame,
		(f) => f.includes("harness exited") && f.includes("Split it in"),
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

	it("gives the glyphs the hues, and a tool call recedes with its arguments as the aside", async () => {
		const { captureSpans, destroy } = await mountTurn(80);
		try {
			const spans = captureSpans().lines.flatMap((line) => line.spans);
			// The copilot records no end for a read, so nothing says how it went.
			const gear = spanWith(spans, "⚙");
			expect(gear && ints(gear.fg)).toEqual(rgb(Theme.DARK.muted));
			const name = spanWith(spans, "Read");
			expect(name && ints(name.fg)).toEqual(rgb(Theme.DARK.secondary));
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
			// The continuation starts under the text, past the glyph.
			expect(next.slice(0, 2).trim()).toBe("");
			expect(next.trim().length).toBeGreaterThan(0);
		} finally {
			destroy();
		}
	});

	it("renders what the agent said as markdown, its code on the raised surface, at forty columns", async () => {
		const said: ActivityEvent[] = [
			{
				seq: 1,
				at: T0,
				type: "text",
				summary: "Run `bun test` **first**, then:\n\n```sh\nbun run check\n```",
			},
		];
		const setup = await renderTest(
			<EventView
				cardId="copilot"
				initialCard={copilotCard}
				source={sourceOf(copilotCard, said)}
				resolveShortId={() => undefined}
				scrollRef={createRef<ScrollBoxRenderable>()}
			/>,
			{ width: 40, height: 16 },
		);
		try {
			const frame = await pumpUntil(
				setup.renderOnce,
				setup.captureCharFrame,
				(f) => f.includes("bun run check") && f.includes("first"),
			);
			expect(frame).not.toContain("**");
			expect(frame).not.toContain("```");
			const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
			const inline = spanWith(spans, "bun test");
			expect(inline && ints(inline.fg)).toEqual(rgb(Theme.DARK.ink.code));
			const block = spanWith(spans, "bun run check");
			expect(block && ints(block.bg)).toEqual(rgb(Theme.DARK.surface.raised));
			// Under the glyph's column, as the plain rows are.
			const row = frame.split("\n").find((r) => r.includes("Run")) ?? "";
			expect(row.startsWith("  Run")).toBe(true);
		} finally {
			setup.destroy();
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
				permissions={[
					{
						id: "p1",
						title: "kabane_edit JREP-1",
						options: [{ id: "once", label: "Allow once" }],
					},
				]}
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

const AT = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();

const loopCard: ActivityCard = {
	id: "run-1",
	kind: "loops",
	label: "loop",
	status: "running",
	startedAt: T0,
	detail: [],
	hasEvents: true,
};

const HEREDOC = "`python3 - <<'EOF'\nimport sys\nprint(sys.argv)\nEOF`";

// A loop session's turn as events.jsonl holds it: each call opened, then ended with its detail.
const calls: ActivityEvent[] = [
	{ seq: 1, at: T0, type: "prompt", summary: "implement JREP-2" },
	{
		seq: 2,
		at: T0,
		type: "tool_call",
		summary: "Read src/pane.tsx",
		callId: "r1",
		detail: { kind: "read" },
	},
	{
		seq: 3,
		at: AT(300),
		type: "tool_completed",
		summary: "Read src/pane.tsx",
		callId: "r1",
		detail: { kind: "read", output: "export const Pane = () => null;" },
	},
	{
		seq: 4,
		at: AT(300),
		type: "tool_call",
		summary: "grep -rn wrap src",
		callId: "g1",
		detail: { kind: "search" },
	},
	{
		seq: 5,
		at: AT(900),
		type: "tool_completed",
		summary: "grep -rn wrap src",
		callId: "g1",
		detail: { kind: "search", output: "src/pane.tsx:3: wrap" },
	},
	{ seq: 6, at: AT(900), type: "text", summary: "Found where the pane wraps." },
	{
		seq: 7,
		at: AT(900),
		type: "tool_call",
		summary: HEREDOC,
		callId: "b1",
		detail: { kind: "execute" },
	},
	{
		seq: 8,
		at: AT(13_900),
		type: "tool_failed",
		summary: HEREDOC,
		callId: "b1",
		detail: {
			kind: "execute",
			input: "command: python3 - <<'EOF'\nimport sys\nprint(sys.argv)\nEOF",
			output: Array.from({ length: 30 }, (_, i) => `trace ${i + 1}`).join("\n"),
		},
	},
	{
		seq: 9,
		at: AT(14_000),
		type: "notice",
		summary: "warning: Auto mode unavailable",
	},
	{
		seq: 10,
		at: AT(14_000),
		type: "tool_call",
		summary: "Edit src/pane.tsx",
		callId: "e1",
		detail: { kind: "edit" },
	},
];

const sourceOf = (
	card: ActivityCard,
	events: readonly ActivityEvent[],
): ActivitySource => ({
	load: async () => ok([card]),
	card: async () => ok(card),
	events: async (_id, afterSeq) => ok(events.filter((e) => e.seq > afterSeq)),
});

const mountCalls = async (width: number, height = 24) => {
	const setup = await renderTest(
		<EventView
			cardId="run-1"
			initialCard={loopCard}
			source={sourceOf(loopCard, calls)}
			resolveShortId={() => undefined}
			scrollRef={createRef<ScrollBoxRenderable>()}
		/>,
		{ width, height },
	);
	// The last row, and the agent's markdown, which lays out a frame after the plain rows.
	const frame = await pumpUntil(
		setup.renderOnce,
		setup.captureCharFrame,
		(f) =>
			f.includes("Edit src/pane.tsx") &&
			f.includes("Found where the pane wraps."),
	);
	return { ...setup, frame };
};

const rowOf = (frame: string, text: string): number =>
	frame.split("\n").findIndex((row) => row.includes(text));

describe("tool calls in the transcript", () => {
	for (const width of [40, 120])
		it(`are one closed row each at ${width} columns, a read and a search one row for both`, async () => {
			const { frame, captureSpans, destroy } = await mountCalls(width);
			try {
				const rows = frame.split("\n").map((row) => row.trimEnd());
				expect(rows).toContain("▸ explored · 1 read, 1 search");
				expect(frame).not.toContain("Read src/pane.tsx");
				// A heredoc keeps to its first line, and the call's end is on its row, not one of its own.
				expect(rows).toContain("✗ `python3 - <<'EOF'… · 13s");
				expect(frame).not.toContain("import sys");
				expect(frame).not.toContain("trace 30");
				// Still running: the spinner, in the working hue.
				const spans = captureSpans().lines.flatMap((line) => line.spans);
				const edit =
					rows.find((row) => row.includes("Edit src/pane.tsx")) ?? "";
				expect(edit.startsWith("⠋ Edit")).toBe(true);
				const spinner = spanWith(spans, "⠋");
				expect(spinner && ints(spinner.fg)).toEqual(rgb(Theme.DARK.working));
				const failed = spanWith(spans, "✗");
				expect(failed && ints(failed.fg)).toEqual(rgb(Theme.DARK.failed));
				// The agent's words keep the terminal's foreground, above the tool rows' secondary.
				const said = spanWith(spans, "Found where");
				expect(said?.fg.intent).toBe("default");
				// A harness's warning: its own glyph, in the accent.
				const notice = spanWith(spans, "!");
				expect(notice && ints(notice.fg)).toEqual(rgb(Theme.DARK.accent));
			} finally {
				destroy();
			}
		});

	it("opens a call on a click, its input's head and its output's tail on the raised surface, and closes it again", async () => {
		const {
			frame,
			mockMouse,
			renderOnce,
			captureCharFrame,
			captureSpans,
			destroy,
		} = await mountCalls(40, 40);
		const until = (p: (f: string) => boolean) =>
			pumpUntil(renderOnce, captureCharFrame, p);
		try {
			await mockMouse.click(4, rowOf(frame, "python3"));
			const opened = await until((f) => f.includes("trace 30"));
			expect(opened).toContain("import sys");
			expect(opened).toContain("(21 earlier lines)");
			expect(opened).not.toContain("trace 21\n");
			const spans = captureSpans().lines.flatMap((line) => line.spans);
			const trace = spanWith(spans, "trace 30");
			expect(trace && ints(trace.bg)).toEqual(rgb(Theme.DARK.surface.raised));
			expect(trace && ints(trace.fg)).toEqual(rgb(Theme.DARK.failed));

			// Past the window in which a second click is a double click, which selects a word.
			await Bun.sleep(600);
			await mockMouse.click(4, rowOf(opened, "python3 - <<'EOF'…"));
			const closed = await until((f) => !f.includes("trace 30"));
			expect(closed).toContain("✗ `python3");
		} finally {
			destroy();
		}
	});

	it("opens a group on a click to the calls in it, each of which opens again", async () => {
		const { frame, mockMouse, renderOnce, captureCharFrame, destroy } =
			await mountCalls(40, 40);
		const until = (p: (f: string) => boolean) =>
			pumpUntil(renderOnce, captureCharFrame, p);
		try {
			await mockMouse.click(4, rowOf(frame, "explored"));
			const opened = await until((f) => f.includes("Read src/pane.tsx"));
			const rows = opened.split("\n").map((row) => row.trimEnd());
			expect(rows).toContain("▾ explored · 1 read, 1 search");
			expect(rows).toContain("  ✓ Read src/pane.tsx · 0.3s");
			expect(rows).toContain("  ✓ grep -rn wrap src · 0.6s");
			await mockMouse.click(6, rowOf(opened, "grep -rn"));
			const read = await until((f) => f.includes("src/pane.tsx:3: wrap"));
			expect(read).toContain("Found where the pane wraps.");
		} finally {
			destroy();
		}
	});

	it("keeps an opened row on its screen row while the stream follows its newest line", async () => {
		// On a card's tab the stream is pinned to its bottom: what a row opens would scroll the row
		// itself up and away from the click, but for the anchor.
		const said = (from: number, count: number): ActivityEvent[] =>
			Array.from({ length: count }, (_, i) => ({
				seq: from + i,
				at: T0,
				type: "text",
				summary: `said ${from + i}`,
			}));
		const failed = calls[7];
		if (!failed) throw new Error("the fixture lost its failed call");
		const events: ActivityEvent[] = [
			...said(1, 20),
			{ seq: 21, at: T0, type: "tool_call", summary: HEREDOC, callId: "b1" },
			{ ...failed, seq: 22 },
			...said(23, 4),
		];
		const setup = await renderTest(
			<EventView
				cardId="run-1"
				initialCard={loopCard}
				source={sourceOf(loopCard, events)}
				resolveShortId={() => undefined}
				scrollRef={createRef<ScrollBoxRenderable>()}
				tabbed
			/>,
			{ width: 40, height: 16 },
		);
		const until = (p: (f: string) => boolean) =>
			pumpUntil(setup.renderOnce, setup.captureCharFrame, p);
		try {
			const before = await until((f) => f.includes("said 26"));
			const y = rowOf(before, "python3");
			expect(y).toBeGreaterThan(2);
			await setup.mockMouse.click(4, y);
			const after = await until((f) => f.includes("import sys"));
			expect(rowOf(after, "python3 - <<'EOF'…")).toBe(y);
			// What it opened pushed the newer lines down, out of view, rather than the row up.
			expect(after).not.toContain("said 26");
		} finally {
			setup.destroy();
		}
	});

	it("does not anchor the last row while the stream follows it, so what it opens comes into view", async () => {
		const setup = await renderTest(
			<EventView
				cardId="run-1"
				initialCard={loopCard}
				source={sourceOf(loopCard, calls.slice(0, 8))}
				resolveShortId={() => undefined}
				scrollRef={createRef<ScrollBoxRenderable>()}
				tabbed
			/>,
			{ width: 40, height: 12 },
		);
		const until = (p: (f: string) => boolean) =>
			pumpUntil(setup.renderOnce, setup.captureCharFrame, p);
		try {
			const before = await until((f) => f.includes("python3"));
			await setup.mockMouse.click(4, rowOf(before, "python3"));
			const after = await until((f) => f.includes("trace 30"));
			expect(after).toContain("trace 30");
		} finally {
			setup.destroy();
		}
	});

	it("does not open a row when the mouse let go of a selection over it", async () => {
		const { frame, mockMouse, renderOnce, captureCharFrame, destroy } =
			await mountCalls(40, 40);
		try {
			const y = rowOf(frame, "python3");
			await mockMouse.drag(2, y, 20, y);
			for (let pass = 0; pass < 5; pass++) await renderOnce();
			expect(captureCharFrame()).not.toContain("import sys");
		} finally {
			destroy();
		}
	});
});

describe("an edit's diff", () => {
	const old = `${Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`).join("\n")}\n`;
	const edit: ActivityEvent[] = [
		{
			seq: 1,
			at: T0,
			type: "tool_call",
			summary: "Edit src/a.ts",
			callId: "e1",
			detail: { kind: "edit" },
		},
		{
			seq: 2,
			at: AT(200),
			type: "tool_completed",
			summary: "Edit src/a.ts",
			callId: "e1",
			detail: {
				kind: "edit",
				input: "old_string: const line2 = 2;",
				output: "The file has been updated.",
				diffs: [
					{
						path: "/repo/src/a.ts",
						oldText: old,
						newText: old.replace("line2 = 2;", "line2 = 22;"),
					},
				],
			},
		},
		{ seq: 3, at: AT(200), type: "text", summary: "Changed it." },
	];

	const openEdit = async (width: number) => {
		const setup = await renderTest(
			<EventView
				cardId="run-1"
				initialCard={loopCard}
				source={sourceOf(loopCard, edit)}
				resolveShortId={() => undefined}
				scrollRef={createRef<ScrollBoxRenderable>()}
			/>,
			{ width, height: 30 },
		);
		const closed = await pumpUntil(
			setup.renderOnce,
			setup.captureCharFrame,
			(f) => f.includes("Changed it."),
		);
		await setup.mockMouse.click(4, rowOf(closed, "Edit src/a.ts"));
		const opened = await pumpUntil(
			setup.renderOnce,
			setup.captureCharFrame,
			(f) => f.includes("line2 = 22;"),
		);
		return { ...setup, opened };
	};

	it("shows in place of the edit's input at 40 columns, one side under the other", async () => {
		const { opened, captureSpans, destroy } = await openEdit(40);
		try {
			const rows = opened.split("\n");
			const removed = rows.findIndex((row) =>
				row.includes("- const line2 = 2;"),
			);
			const added = rows.findIndex((row) =>
				row.includes("+ const line2 = 22;"),
			);
			expect(removed).toBeGreaterThan(-1);
			expect(added).toBe(removed + 1);
			expect(opened).not.toContain("old_string");
			expect(opened).toContain("The file has been updated.");
			const spans = captureSpans().lines.flatMap((line) => line.spans);
			const plus = spanWith(spans, "+");
			expect(plus && ints(plus.fg)).toEqual(rgb(Theme.DARK.done));
		} finally {
			destroy();
		}
	});

	it("goes side by side once the screen is wider than 120 columns", async () => {
		const { opened, destroy } = await openEdit(160);
		try {
			const row =
				opened.split("\n").find((r) => r.includes("const line2 = 2;")) ?? "";
			expect(row).toContain("const line2 = 22;");
		} finally {
			destroy();
		}
	});
});
