import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDb } from "@cabane/sqlite";
import type { DbProvider } from "../db/port";
import { Runtime, withDb } from "../runtime";
import type { TaskDraft } from "../schemas";
import { QUEUE_BYTES, serializedBytes } from "../task-output";
import { configureTestRuntime } from "../testing";
import { TABLES } from "./helpers";
import { Planner } from "./index";
import { Oplog } from "./oplog";

let base: string;
beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "kabane-pages-"));
	configureTestRuntime();
	expect((await Planner.init(base)).ok).toBe(true);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));
const add = async (draft: TaskDraft = { title: "needle" }) => {
	const result = await Planner.addTask(base, draft);
	expect(result.ok).toBe(true);
	return result.ok ? result.value : undefined;
};
const tie = async () => {
	expect(
		(
			await withDb(base, (db) =>
				db.run(
					`UPDATE ${TABLES.tasks} SET created_at = '2025-01-01T00:00:00.000Z'`,
				),
			)
		).ok,
	).toBe(true);
};

describe("concise task pages", () => {
	for (const count of [0, 1, 20, 100, 105])
		it(`enumerates ${count} tied candidates exactly once`, async () => {
			const ids: string[] = [];
			for (let i = 0; i < count; i++) {
				const task = await add({
					title: `needle ${i}`,
					state: "next",
					scopeUri: "pages",
				});
				if (task) ids.push(task.id);
			}
			await tie();
			let cursor: string | undefined;
			const seen: string[] = [];
			let calls = 0;
			do {
				const page = await Planner.queryTaskPage(
					base,
					{ scopeUri: "pages" },
					{ cursor },
				);
				expect(page.ok).toBe(true);
				if (!page.ok) return;
				expect(serializedBytes(page.value)).toBeLessThanOrEqual(QUEUE_BYTES);
				expect(page.value.items.length).toBeLessThanOrEqual(20);
				expect(page.value.hasMore).toBe(page.value.nextCursor !== undefined);
				seen.push(...page.value.items.map((item) => item.id));
				cursor = page.value.nextCursor;
				calls++;
			} while (cursor && calls < 10);
			expect(seen).toEqual(ids.sort());
			expect(new Set(seen).size).toBe(count);
			const max = await Planner.queryTaskPage(
				base,
				{ scopeUri: "pages" },
				{ limit: 100 },
			);
			expect(max.ok).toBe(true);
			if (max.ok) {
				expect(max.value.items).toHaveLength(Math.min(count, 100));
				expect(max.value.hasMore).toBe(count > 100);
			}
		});
	it("shrinks pages at escaped-byte boundaries without skipping the rejected next row", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 105; i++) {
			const task = await add({
				title: '\n🧭漢字\\"'.repeat(60),
				kind: "issue",
				assignee: "a".repeat(5000),
				scopeUri: "pages",
				state: "next",
			});
			if (task) ids.push(task.id);
		}
		await tie();
		let cursor: string | undefined;
		const seen: string[] = [];
		for (let call = 0; call < 30; call++) {
			const page = await Planner.queryTaskPage(
				base,
				{ scopeUri: "pages" },
				{ limit: 100, cursor },
			);
			expect(page.ok).toBe(true);
			if (!page.ok) return;
			expect(serializedBytes(page.value)).toBeLessThanOrEqual(QUEUE_BYTES);
			expect(page.value.items.length).toBeLessThan(100);
			expect(
				page.value.items.every((item) =>
					item.truncatedFields?.includes("title"),
				),
			).toBe(true);
			seen.push(...page.value.items.map((item) => item.id));
			cursor = page.value.nextCursor;
			if (!cursor) break;
		}
		expect(seen).toEqual(ids.sort());
	});
	it("binds filters/scope and rejects malformed, oversized, and invalid parameters", async () => {
		for (let i = 0; i < 3; i++)
			await add({
				title: "needle",
				scopeUri: "pages",
				state: "next",
				priority: "high",
				assignee: "agent",
				tags: ["tag"],
			});
		const query = {
			scopeUri: "pages",
			state: "next" as const,
			priority: "high" as const,
			assignee: "agent",
			tag: "tag",
		};
		const first = await Planner.queryTaskPage(base, query, { limit: 1 });
		if (!first.ok) return;
		expect(first.value.items).toHaveLength(1);
		const cursor = first.value.nextCursor;
		for (const changed of [
			{ scopeUri: "other" },
			{ state: "waiting" as const },
			{ assignee: "other" },
			{ tag: "other" },
			{ priority: "low" as const },
		])
			expect(
				(
					await Planner.queryTaskPage(
						base,
						{ ...query, ...changed },
						{ cursor },
					)
				).ok,
			).toBe(false);
		for (const limit of [0, -1, 1.5, 101, Infinity, NaN])
			expect((await Planner.queryTaskPage(base, {}, { limit })).ok).toBe(false);
		for (const bad of ["", "{bad", "x".repeat(701), '{"v":2}'])
			expect((await Planner.queryTaskPage(base, {}, { cursor: bad })).ok).toBe(
				false,
			);
		const filtered = await Planner.queryTaskPage(base, {
			...query,
			assignee: "none",
		});
		if (filtered.ok) expect(filtered.value.items).toHaveLength(0);
	});
	it("tolerates unrelated-scope writes but rejects relevant updates, insertions, deletions and predicate changes", async () => {
		const a = await add({ title: "needle", scopeUri: "pages", state: "next" });
		await add({ title: "needle", scopeUri: "pages", state: "next" });
		const unrelated = await add({
			title: "elsewhere",
			scopeUri: "other",
			state: "next",
		});
		if (!a || !unrelated) return;
		const first = await Planner.queryTaskPage(
			base,
			{ scopeUri: "pages", state: "next" },
			{ limit: 1 },
		);
		if (!first.ok) return;
		const cursor = first.value.nextCursor;
		expect(cursor).toBeDefined();
		await Planner.updateTask(base, unrelated.id, {
			description: "unrelated edit",
		});
		expect(
			(
				await Planner.queryTaskPage(
					base,
					{ scopeUri: "pages", state: "next" },
					{ cursor },
				)
			).ok,
		).toBe(true);
		await Planner.updateTask(base, a.id, { description: "relevant edit" });
		const stale = await Planner.queryTaskPage(
			base,
			{ scopeUri: "pages", state: "next" },
			{ cursor },
		);
		expect(stale.ok).toBe(false);
		if (!stale.ok) expect(stale.error.message).toContain("Stale");
		for (const change of ["insert", "delete", "enter", "leave"] as const) {
			const initial = await Planner.queryTaskPage(
				base,
				{ scopeUri: "pages", state: "next" },
				{ limit: 1 },
			);
			if (!initial.ok) return;
			if (change === "insert")
				await add({ title: "needle", scopeUri: "pages", state: "next" });
			if (change === "delete") await Planner.deleteTask(base, a.id);
			if (change === "enter")
				await Planner.updateTask(base, unrelated.id, { scopeUri: "pages" });
			if (change === "leave")
				await Planner.updateTask(base, unrelated.id, { scopeUri: "other" });
			expect(
				(
					await Planner.queryTaskPage(
						base,
						{ scopeUri: "pages", state: "next" },
						{ cursor: initial.value.nextCursor },
					)
				).ok,
			).toBe(false);
		}
	});
	it("search uses the same ranking, stable ties, static continuation and relevant fingerprint", async () => {
		const a = await add({
			title: "needle needle",
			description: "needle",
			scopeUri: "pages",
		});
		await add({ title: "haystack", description: "needle", scopeUri: "pages" });
		await add({ title: "needle", scopeUri: "pages" });
		const other = await add({ title: "haystack", scopeUri: "other" });
		if (!a || !other) return;
		const legacy = await Planner.searchTasks(base, "needle", {
			scopeUri: "pages",
			limit: 100,
		});
		if (!legacy.ok) return;
		const first = await Planner.searchTaskPage(
			base,
			"needle",
			{ scopeUri: "pages" },
			{ limit: 1 },
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.items[0]?.id).toBe(legacy.value[0]?.id);
		const seen = first.value.items.map((item) => item.id);
		let cursor = first.value.nextCursor;
		while (cursor) {
			const page = await Planner.searchTaskPage(
				base,
				"needle",
				{ scopeUri: "pages" },
				{ limit: 1, cursor },
			);
			expect(page.ok).toBe(true);
			if (!page.ok) return;
			seen.push(...page.value.items.map((item) => item.id));
			cursor = page.value.nextCursor;
		}
		expect(seen.sort()).toEqual(legacy.value.map((task) => task.id).sort());
		await Planner.updateTask(base, other.id, { assignee: "unrelated" });
		expect(
			(
				await Planner.searchTaskPage(
					base,
					"needle",
					{ scopeUri: "pages" },
					{ cursor: first.value.nextCursor },
				)
			).ok,
		).toBe(true);
		expect(
			(
				await Planner.searchTaskPage(
					base,
					"haystack",
					{ scopeUri: "pages" },
					{ cursor: first.value.nextCursor },
				)
			).ok,
		).toBe(false);
		await Planner.updateTask(base, a.id, { description: "changed rank" });
		expect(
			(
				await Planner.searchTaskPage(
					base,
					"needle",
					{ scopeUri: "pages" },
					{ cursor: first.value.nextCursor },
				)
			).ok,
		).toBe(false);
	});
	it("stales search only when an unrelated corpus-statistics write actually changes ranking", async () => {
		const a = await add({
			title: "needle",
			description: "x",
			scopeUri: "pages",
		});
		const b = await add({
			title: "needle needle needle needle",
			description: "x ".repeat(16),
			scopeUri: "pages",
		});
		const outside = await add({ title: "x", scopeUri: "other" });
		if (!a || !b || !outside) return;
		const first = await Planner.searchTaskPage(
			base,
			"needle",
			{ scopeUri: "pages" },
			{ limit: 1 },
		);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.items[0]?.id).toBe(a.id);
		await Planner.updateTask(base, outside.id, {
			description: "x ".repeat(1000),
		});
		const ranked = await Planner.searchTasks(base, "needle", {
			scopeUri: "pages",
		});
		expect(ranked.ok).toBe(true);
		if (ranked.ok) expect(ranked.value[0]?.id).toBe(b.id);
		const continued = await Planner.searchTaskPage(
			base,
			"needle",
			{ scopeUri: "pages" },
			{ cursor: first.value.nextCursor },
		);
		expect(continued.ok).toBe(false);
		if (!continued.ok) expect(continued.error.message).toContain("Stale");
	});
	it("does not falsely claim no mutation if an external identity replacement races the post-write read", async () => {
		const task = await add({ title: "Racing identity", state: "next" });
		if (!task) return;
		const provider = SqliteDb.provider();
		let reads = 0;
		const racing: DbProvider = {
			withDb: (path, fn) =>
				provider.withDb(path, (db) => {
					if (++reads === 3)
						db.run(`UPDATE ${TABLES.tasks} SET short_id = ? WHERE id = ?`, [
							"X".repeat(20000),
							task.id,
						]);
					return fn(db);
				}),
		};
		Runtime.configure({ provider: racing, timezone: () => "UTC" });
		try {
			const result = await Planner.updateTaskReceipt(base, task.id, {
				state: "done",
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.message).toContain("Task was updated");
				expect(result.error.message).not.toContain("no mutation occurred");
				expect(result.error.message).toContain("before retrying");
			}
			const updated = await Planner.getTask(base, task.id);
			expect(updated.ok).toBe(true);
			if (updated.ok) expect(updated.value?.state).toBe("done");
		} finally {
			configureTestRuntime();
		}
	});
	it("label-only changes stale shared list/search/today fingerprints without version/clock bumps", async () => {
		const first = await add({
			title: "needle",
			state: "next",
			scopeUri: "pages",
		});
		const second = await add({
			title: "needle",
			state: "next",
			scopeUri: "pages",
		});
		if (!first || !second) return;
		const list = await Planner.queryTaskPage(
			base,
			{ scopeUri: "pages" },
			{ limit: 1 },
		);
		const search = await Planner.searchTaskPage(
			base,
			"needle",
			{ scopeUri: "pages" },
			{ limit: 1 },
		);
		const today = await Planner.getTodayPages(
			base,
			{ scopeUri: "pages" },
			{ limit: 1 },
		);
		if (!list.ok || !search.ok || !today.ok) return;
		expect(list.value.nextCursor).toBeDefined();
		expect(search.value.nextCursor).toBeDefined();
		expect(today.value.next.nextCursor).toBeDefined();
		expect(
			(
				await withDb(base, (db) =>
					db.run(
						`UPDATE ${TABLES.tasks} SET short_id = 'JPAG-99' WHERE id = ?`,
						[first.id],
					),
				)
			).ok,
		).toBe(true);
		const results = [
			await Planner.queryTaskPage(
				base,
				{ scopeUri: "pages" },
				{ cursor: list.value.nextCursor },
			),
			await Planner.searchTaskPage(
				base,
				"needle",
				{ scopeUri: "pages" },
				{ cursor: search.value.nextCursor },
			),
			await Planner.getTodayPages(
				base,
				{ scopeUri: "pages" },
				{ cursors: { next: today.value.next.nextCursor } },
			),
		];
		for (const result of results) {
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).toContain("Stale cursor");
		}
	});
	it("preflights oversized imported identities before writes or change-op capture; full remains lossless", async () => {
		for (const field of ["id", "short_id"] as const) {
			const task = await add({ title: "Imported identity", state: "next" });
			if (!task) return;
			const giant = "X".repeat(20000);
			const armed = await withDb(base, (db) => {
				const result = Oplog.initDevice(db, "fixture-device");
				expect(result.ok).toBe(true);
				db.run(`UPDATE ${TABLES.tasks} SET ${field} = ? WHERE id = ?`, [
					giant,
					task.id,
				]);
			});
			expect(armed.ok).toBe(true);
			const id = field === "id" ? giant : task.id;
			const before = await Planner.getTask(base, id);
			if (!before.ok || !before.value) return;
			const page = await Planner.queryTaskPage(base);
			expect(page.ok).toBe(false);
			if (!page.ok) expect(page.error.message.length).toBeLessThan(200);
			const opsBefore = await withDb(base, (db) =>
				db.query(`SELECT count(*) AS n FROM ${TABLES.sync_oplog}`).get(),
			);
			expect(opsBefore.ok).toBe(true);
			for (const update of [
				{ state: "done" as const },
				{ state: "in_progress" as const },
			]) {
				const result = await Planner.updateTaskReceipt(base, id, update);
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error.message.length).toBeLessThan(200);
					expect(result.error.message).toContain("no mutation occurred");
				}
			}
			expect(await Planner.getTask(base, id)).toEqual(before);
			expect(
				await withDb(base, (db) =>
					db.query(`SELECT count(*) AS n FROM ${TABLES.sync_oplog}`).get(),
				),
			).toEqual(opsBefore);
			const full = await Planner.updateTask(base, id, { state: "done" });
			expect(full.ok).toBe(true);
			if (full.ok) expect(full.value?.state).toBe("done");
		}
	});
});
