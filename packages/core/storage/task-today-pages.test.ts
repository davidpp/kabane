import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QUEUE_BYTES, serializedBytes } from "../task-output";
import { configureTestRuntime } from "../testing";
import { Planner } from "./index";
import type { TodayBucket } from "./task-selection";

let base: string;
const now = Date.parse("2025-01-15T17:00:00Z");
const opts = { now, zone: "America/New_York", scopeUri: "today-pages" };
beforeEach(async () => {
	configureTestRuntime();
	base = mkdtempSync(join(tmpdir(), "kabane-today-pages-"));
	expect((await Planner.init(base)).ok).toBe(true);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

it("reports complete empty buckets, then independently enumerates oversize buckets within the final combined budget", async () => {
	const empty = await Planner.getTodayPages(base, opts);
	expect(empty.ok).toBe(true);
	if (empty.ok)
		for (const bucket of ["overdue", "dueToday", "next"] as const) {
			expect(empty.value[bucket].items).toHaveLength(0);
			expect(empty.value[bucket].hasMore).toBe(false);
		}
	const expected: Record<TodayBucket, string[]> = {
		overdue: [],
		dueToday: [],
		next: [],
	};
	for (const bucket of ["overdue", "dueToday", "next"] as const)
		for (let i = 0; i < 105; i++) {
			const task = await Planner.addTask(base, {
				title: `Synthetic ${bucket} ${i} 🧭` + "\n\\漢".repeat(80),
				assignee: "a".repeat(4000),
				state: "next",
				scopeUri: "today-pages",
				deadline:
					bucket === "overdue"
						? "2025-01-14"
						: bucket === "dueToday"
							? "2025-01-15"
							: undefined,
			});
			expect(task.ok).toBe(true);
			if (task.ok) expected[bucket].push(task.value.id);
		}
	const legacy = await Planner.getToday(base, opts);
	expect(legacy.ok).toBe(true);
	if (legacy.ok) {
		expect(legacy.value.overdue).toHaveLength(105);
		expect(legacy.value.dueToday).toHaveLength(105);
		expect(legacy.value.next).toHaveLength(20);
	}
	const first = await Planner.getTodayPages(base, opts, { limit: 100 });
	expect(first.ok).toBe(true);
	if (!first.ok) return;
	expect(serializedBytes(first.value)).toBeLessThanOrEqual(QUEUE_BYTES);
	for (const bucket of ["overdue", "dueToday", "next"] as const) {
		const seen = first.value[bucket].items.map((item) => item.id);
		let cursor = first.value[bucket].nextCursor;
		expect(cursor).toBeDefined();
		let calls = 0;
		while (cursor && calls++ < 100) {
			const next = await Planner.getTodayPages(base, opts, {
				limit: 100,
				cursors: { [bucket]: cursor },
			});
			expect(next.ok).toBe(true);
			if (!next.ok) return;
			expect(serializedBytes(next.value)).toBeLessThanOrEqual(QUEUE_BYTES);
			seen.push(...next.value[bucket].items.map((item) => item.id));
			cursor = next.value[bucket].nextCursor;
		}
		expect(seen.sort()).toEqual(expected[bucket].sort());
		expect(new Set(seen).size).toBe(105);
	}
	const cursor = first.value.overdue.nextCursor;
	for (const changed of [
		{ now: now + 86400000 },
		{ zone: "UTC" },
		{ scopeUri: "other" },
		{ includeDone: true },
	]) {
		const result = await Planner.getTodayPages(
			base,
			{ ...opts, ...changed },
			{ cursors: { overdue: cursor } },
		);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("cursor");
	}
});

it("uses the owner's calendar day for calendar-date and instant deadlines and binds buckets", async () => {
	const options = {
		now: Date.parse("2025-01-16T02:00:00Z"),
		zone: "America/New_York",
	};
	for (const deadline of ["2025-01-15", "2025-01-16T01:00:00Z", "2025-01-16"])
		expect(
			(
				await Planner.addTask(base, {
					title: deadline,
					state: "next",
					deadline,
				})
			).ok,
		).toBe(true);
	const page = await Planner.getTodayPages(base, options, { limit: 1 });
	expect(page.ok).toBe(true);
	if (!page.ok) return;
	expect(page.value.overdue.items).toHaveLength(0);
	expect(page.value.dueToday.items).toHaveLength(1);
	expect(page.value.dueToday.hasMore).toBe(true);
	expect(page.value.next.items).toHaveLength(1);
	const result = await Planner.getTodayPages(base, options, {
		cursors: { next: page.value.dueToday.nextCursor },
	});
	expect(result.ok).toBe(false);
});
