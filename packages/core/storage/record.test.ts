import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Migrate } from "../db/migrate";
import type { Db } from "../db/port";
import { Modules } from "../module";
import type { Result } from "../result";
import { withDb } from "../runtime";
import { RecordKey } from "../schemas";
import { Planner } from "./index";
import { Migrations } from "./migrations";
import { RecordRead } from "./record";

const TEST_BASE = join(import.meta.dir, ".test-data-record");
const T0 = "2026-01-01T00:00:00.000Z";

const insert = (db: Db, table: string, row: Record<string, string | null>) => {
	const columns = Object.keys(row);
	db.run(
		`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
		Object.values(row),
	);
};

const thread = (
	db: Db,
	id: string,
	parentId: string | null = null,
	deletedAt: string | null = null,
) =>
	insert(db, "threads", {
		id,
		kind: "issue",
		title: id,
		parent_id: parentId,
		created_at: T0,
		updated_at: T0,
		state_updated_at: T0,
		deleted_at: deletedAt,
	});

const entry = (
	db: Db,
	id: string,
	kind: "claim" | "release",
	author: string,
	at: string,
	threadId = "thread",
) =>
	insert(db, "entries", {
		id,
		thread_id: threadId,
		kind,
		author,
		created_at: at,
	});

const read = async <T>(fn: (db: Db) => T): Promise<T> => {
	const result = await withDb(TEST_BASE, fn);
	if (!result.ok) throw result.error;
	return result.value;
};

const holderOf = (threadId = "thread") =>
	read((db) => {
		const held = RecordRead.claimHolder(db, threadId);
		if (!held.ok) throw held.error;
		return held.value?.id;
	});

const at = (second: number) =>
	new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

describe("RecordRead", () => {
	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });
		const init = await Planner.init(TEST_BASE);
		if (!init.ok) throw init.error;
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	describe("claimHolder", () => {
		it("is the earliest claim, by time and then id, and passes on when its author releases", async () => {
			await read((db) => {
				thread(db, "thread");
				entry(db, "claim-b", "claim", "codex", at(1));
				entry(db, "claim-a", "claim", "claude", at(1));
				entry(db, "claim-c", "claim", "gemini", at(0));
			});
			expect(await holderOf()).toBe("claim-c");

			await read((db) => entry(db, "release-c", "release", "gemini", at(2)));
			expect(await holderOf()).toBe("claim-a");

			// A release by someone else, or one older than the claim, frees nothing.
			await read((db) => {
				entry(db, "release-by-other", "release", "codex", at(3));
				entry(db, "release-too-early", "release", "claude", at(0));
			});
			expect(await holderOf()).toBe("claim-a");
		});

		it("is no one on a thread that is deleted or has not arrived", async () => {
			await read((db) => {
				thread(db, "deleted", null, at(5));
				entry(db, "claim-on-deleted", "claim", "claude", at(1), "deleted");
				entry(db, "claim-on-missing", "claim", "claude", at(1), "missing");
			});
			expect(await holderOf("deleted")).toBeUndefined();
			expect(await holderOf("missing")).toBeUndefined();
		});
	});

	it("shows a thread whose parent has not arrived at the root, and hides everything under a deleted one", async () => {
		const ref = (from: string, uri: string, kind: string) => (db: Db) =>
			insert(db, "refs", { thread_id: from, uri, kind, updated_at: T0 });
		const link = (from: string, to: string) =>
			ref(from, RecordKey.threadUri(to), "blocks");
		const seen = await read((db) => {
			thread(db, "orphan", "not-arrived");
			thread(db, "other");
			thread(db, "grandparent", null, at(1));
			thread(db, "parent", "grandparent");
			thread(db, "grandchild", "parent");
			for (const write of [
				link("orphan", "grandchild"),
				link("orphan", "other"),
				link("other", "orphan"),
				link("orphan", "not-arrived"),
				ref("orphan", "file:spec.md", "spec"),
			])
				write(db);
			const all = <T>(result: Result<T>): T => {
				if (!result.ok) throw result.error;
				return result.value;
			};
			const pairs = (rows: { thread_id: string; uri: string }[]) =>
				rows.map((r) => `${r.thread_id} -> ${r.uri}`);
			return {
				threads: all(RecordRead.threads(db)).map((t) => [t.id, t.parent_id]),
				refs: pairs(all(RecordRead.refs(db))),
				refsOfOrphan: pairs(all(RecordRead.refs(db, "orphan"))),
				links: pairs(all(RecordRead.links(db))),
				linksOfOther: pairs(all(RecordRead.links(db, "other"))),
				linksOfGrandchild: pairs(all(RecordRead.links(db, "grandchild"))),
			};
		});
		const orphanToOther = "orphan -> kabane://thread/other";
		const otherToOrphan = "other -> kabane://thread/orphan";
		expect(seen).toEqual({
			threads: [
				["orphan", null],
				["other", null],
			],
			refs: ["orphan -> file:spec.md", orphanToOther, otherToOrphan],
			refsOfOrphan: ["orphan -> file:spec.md", orphanToOther],
			links: [orphanToOther, otherToOrphan],
			linksOfOther: [orphanToOther, otherToOrphan],
			linksOfGrandchild: [],
		});
	});
});

describe("RecordRead — deletes, cycles and cost", () => {
	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });
		const init = await Planner.init(TEST_BASE);
		if (!init.ok) throw init.error;
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	it("hides a whole parent cycle when one of its members is deleted", async () => {
		const seen = await read((db) => {
			thread(db, "A", "B");
			thread(db, "B", "C", at(1));
			thread(db, "C", "A");
			entry(db, "claim-a", "claim", "claude", at(2), "A");
			const threads = RecordRead.threads(db);
			const holder = RecordRead.claimHolder(db, "A");
			if (!threads.ok) throw threads.error;
			if (!holder.ok) throw holder.error;
			return { threads: threads.value, holder: holder.value };
		});
		expect(seen).toEqual({ threads: [], holder: undefined });
	});

	it("reads one thread the way the whole record reads it", async () => {
		const scoped = await read((db) => {
			// A cycle, a cycle with a deleted member, a missing parent, a deleted
			// grandparent, a self-parent, and plain roots and children.
			const parents: [string, string | null, string | null][] = [
				["c1", "c2", null],
				["c2", "c1", null],
				["d1", "d2", null],
				["d2", "d1", at(1)],
				["d3", "d1", null],
				["orphan", "not-arrived", null],
				["gp", null, at(1)],
				["p", "gp", null],
				["k", "p", null],
				["self", "self", null],
				["root", null, null],
				["child", "root", null],
			];
			for (const [id, parent, deleted] of parents) {
				thread(db, id, parent, deleted);
				entry(db, `claim-${id}`, "claim", "claude", at(2), id);
			}
			const whole = RecordRead.threads(db);
			if (!whole.ok) throw whole.error;
			const visible = whole.value.map((t) => t.id);
			return parents.map(([id]) => {
				const entries = RecordRead.entries(db, id);
				if (!entries.ok) throw entries.error;
				return [id, entries.value.length > 0, visible.includes(id)];
			});
		});
		for (const [id, entriesShow, threadShows] of scoped)
			expect(entriesShow, String(id)).toBe(threadShows);
		expect(scoped.filter(([, shows]) => shows).map(([id]) => id)).toEqual([
			"c1",
			"c2",
			"orphan",
			"self",
			"root",
			"child",
		]);
	});

	it("reads one thread without walking every other thread's ancestry", async () => {
		const elapsed = await read((db) => {
			db.transaction(() => {
				for (let i = 0; i < 1500; i++)
					thread(
						db,
						`t${String(i).padStart(4, "0")}`,
						i === 0 ? null : `t${String(i - 1).padStart(4, "0")}`,
					);
			})();
			const start = performance.now();
			const held = RecordRead.claimHolder(db, "t0000");
			if (!held.ok) throw held.error;
			return performance.now() - start;
		});
		// A 1,500-deep chain: about 1.5 s when every thread's ancestry is walked.
		expect(elapsed).toBeLessThan(250);
	});
});

describe("migration 13", () => {
	const base = join(import.meta.dir, ".test-data-record-migration");

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	it("refuses, changing nothing, a database where a table already holds a record table's name", async () => {
		rmSync(base, { recursive: true, force: true });
		mkdirSync(base, { recursive: true });
		const outcome = await withDb(base, (db) => {
			const before = Migrate.run(db, Migrations.LIST.slice(0, 12));
			if (!before.ok) throw before.error;
			const declared = Modules.ensureDeclarations(db);
			if (!declared.ok) throw declared.error;
			db.exec(
				"CREATE TABLE refs (id TEXT PRIMARY KEY, source_id TEXT, target_id TEXT, legacy TEXT)",
			);
			db.run(
				`INSERT INTO module_declarations (tbl, module, module_schema, family, clock, child_of_tasks)
				 VALUES ('refs', 'example', 1, 'append-only', NULL, 0)`,
			);
			const migrated = Migrations.apply(db);
			return {
				error: migrated.ok ? undefined : migrated.error.message,
				version: db
					.query<{ v: number }, []>(
						"SELECT MAX(version) AS v FROM schema_migrations",
					)
					.get()?.v,
				threads: db
					.query<{ n: number }, []>(
						"SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'threads'",
					)
					.get()?.n,
			};
		});
		if (!outcome.ok) throw outcome.error;
		expect(outcome.value.version).toBe(12);
		expect(outcome.value.threads).toBe(0);
		expect(outcome.value.error).toContain('"refs"');
		expect(outcome.value.error).toContain('"example"');
	});
});

describe("RecordKey", () => {
	it("names a row by its key: the value alone, or the JSON array of its parts", () => {
		expect(RecordKey.rowIdOf("threads", { id: "01ABC" })).toBe("01ABC");
		const rowId = RecordKey.rowIdOf("refs", {
			thread_id: "t",
			uri: 'file:a,"b"]',
			kind: "spec",
		});
		expect(rowId).toBe('["t","file:a,\\"b\\"]","spec"]');
		expect(RecordKey.partsOf("refs", rowId ?? "")).toEqual([
			"t",
			'file:a,"b"]',
			"spec",
		]);
		// One row has one row id: another spelling of the same parts names none.
		expect(
			RecordKey.partsOf("refs", '["t", "file:a", "spec"]'),
		).toBeUndefined();
		expect(
			RecordKey.partsOf("attributes", '["t","k","extra"]'),
		).toBeUndefined();
		expect(RecordKey.rowIdOf("attributes", { thread_id: "t" })).toBeUndefined();
	});
});
