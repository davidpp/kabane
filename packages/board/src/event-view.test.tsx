/** @jsxImportSource @opentui/react */
// The transcript's head. A card that carries a plan gets it pinned above the scrollbox — the point
// being that it survives the events scrolling under it — and a host card, which has no such thing,
// keeps the one-line header it always had.
import { describe, expect, it } from "bun:test";
import { ok } from "@cabane/core";
import type { ScrollBoxRenderable } from "@opentui/core";
import { createRef } from "react";
import { EventView } from "./event-view";
import type {
	ActivityCard,
	ActivityEvent,
	ActivitySource,
	PlanEntry,
} from "./ports";
import { pumpUntil, renderTest } from "./testing";

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
