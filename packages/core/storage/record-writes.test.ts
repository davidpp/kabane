/**
 * The storage layer as the record's writer (JCAB-660): each logical write is
 * one transaction with its capture, a child needs its thread, a row keeps the
 * family it was written as whatever its kind, and the `Task` read credits the
 * latest write.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Migrate } from "../db/migrate";
import type { Db } from "../db/port";
import { Replicated } from "../replicated";
import type { Result } from "../result";
import { withDb as runWithDb } from "../runtime";
import { configureTestRuntime } from "../testing";
import { Legacy } from "../testing/legacy-rows";
import { Planner } from "./index";
import { Migrations } from "./migrations";
import { Oplog } from "./oplog";

let base: string;

const must = <T>(r: Result<T>): T => {
	if (!r.ok) throw r.error;
	return r.value;
};

const withDb = async <T>(fn: (db: Db) => T): Promise<T> =>
	must(await runWithDb(base, fn));

const MISSING = "01KZNOSUCHTASK000000000000";

beforeEach(async () => {
	configureTestRuntime();
	base = mkdtempSync(join(tmpdir(), "kabane-record-writes-"));
	must(await Planner.init(base));
});

afterEach(() => {
	configureTestRuntime();
	rmSync(base, { recursive: true, force: true });
});

const refuseCapture = () =>
	withDb((db) => {
		must(Oplog.initDevice(db, "device-a"));
		db.run(
			"CREATE TRIGGER refuse_capture BEFORE INSERT ON sync_oplog BEGIN SELECT RAISE(ABORT, 'capture refused'); END",
		);
	});

describe("a write and its capture are one transaction", () => {
	it("leaves the task, its comment and its links as they were when capture fails", async () => {
		const task = must(await Planner.addTask(base, { title: "kept" }));
		const other = must(await Planner.addTask(base, { title: "other" }));
		await refuseCapture();

		for (const write of [
			() => Planner.deleteTask(base, task.id),
			() =>
				Planner.addComment(base, {
					taskId: task.id,
					author: "me",
					authorType: "human",
					content: "lost",
				}),
			() =>
				Planner.addWorkLog(base, {
					taskId: task.id,
					refs: [{ uri: "commit:a" }],
				}),
			() =>
				Planner.addLink(base, {
					sourceId: other.id,
					targetId: task.id,
					type: "blocks",
				}),
			() =>
				Planner.addContextRef(base, {
					taskId: task.id,
					uri: "file:a.md",
					kind: "spec",
				}),
			() =>
				Planner.updateTask(base, task.id, {
					title: "changed",
					priority: "high",
				}),
		]) {
			const result = await write();
			expect(result.ok).toBe(false);
		}
		const read = must(await Planner.getTask(base, task.id));
		expect(read).toMatchObject({ title: "kept", priority: "normal" });
		expect(
			await withDb(
				(db) =>
					db
						.query<{ n: number }, []>(
							"SELECT (SELECT COUNT(*) FROM entries) + (SELECT COUNT(*) FROM refs) AS n",
						)
						.get()?.n,
			),
		).toBe(0);
	});
});

describe("a local write needs its thread", () => {
	it("refuses a child of a thread that does not show", async () => {
		const task = must(await Planner.addTask(base, { title: "here" }));
		for (const write of [
			() =>
				Planner.addComment(base, {
					taskId: MISSING,
					author: "me",
					authorType: "human",
					content: "orphan",
				}),
			() =>
				Planner.addWorkLog(base, {
					taskId: MISSING,
					refs: [{ uri: "commit:a" }],
				}),
			() =>
				Planner.addContextRef(base, {
					taskId: MISSING,
					uri: "file:a",
					kind: "spec",
				}),
			() =>
				Planner.addLink(base, {
					sourceId: task.id,
					targetId: MISSING,
					type: "blocks",
				}),
			() =>
				Planner.upsertUpstreamLink(base, {
					taskId: MISSING,
					provider: "github",
					externalId: "1",
					url: "https://example.org/1",
					title: "x",
				}),
		]) {
			const result = await write();
			expect(result.ok).toBe(false);
		}
		expect(
			await withDb(
				(db) =>
					db
						.query<{ n: number }, []>(
							"SELECT (SELECT COUNT(*) FROM entries) + (SELECT COUNT(*) FROM refs) AS n",
						)
						.get()?.n,
			),
		).toBe(0);
	});
});

describe("a row's family follows from its URI and kind", () => {
	it("refuses a comment of kind log: that kind is the work log's", async () => {
		const task = must(await Planner.addTask(base, { title: "t" }));
		const added = await Planner.addEntry(base, {
			taskId: task.id,
			kind: "log",
			author: "me",
			authorType: "human",
			content: "a comment called log",
		});
		expect(added.ok).toBe(false);
		expect(must(await Planner.getEntries(base, task.id))).toEqual([]);
	});

	it("refuses a context ref to a thread or under a link's or upstream's kind", async () => {
		const task = must(await Planner.addTask(base, { title: "t" }));
		const other = must(await Planner.addTask(base, { title: "o" }));
		must(
			await Planner.addLink(base, {
				sourceId: task.id,
				targetId: other.id,
				type: "blocks",
			}),
		);
		for (const [uri, kind] of [
			[`kabane://thread/${other.id}`, "blocks"],
			[`kabane://thread/${other.id}`, "spec"],
			["file:a.md", "upstream"],
			["file:a.md", "parent"],
		] as const)
			expect(
				(await Planner.addContextRef(base, { taskId: task.id, uri, kind })).ok,
			).toBe(false);
		expect(must(await Planner.getContextRefs(base, task.id))).toEqual([]);
		expect(
			must(await Planner.getLinksForTask(base, task.id)).map((l) => l.type),
		).toEqual(["blocks"]);
	});

	it("stores no family: it is read from the URI and the kind", async () => {
		const task = must(await Planner.addTask(base, { title: "t" }));
		must(
			await Planner.addContextRef(base, {
				taskId: task.id,
				uri: "file:a.md",
				kind: "spec",
			}),
		);
		must(
			await Planner.addWorkLog(base, {
				taskId: task.id,
				refs: [{ uri: "commit:a" }],
			}),
		);
		expect(
			await withDb(
				(db) =>
					db
						.query<{ n: number }, []>(
							`SELECT (SELECT COUNT(*) FROM refs WHERE json_extract(data, '$.family') IS NOT NULL)
							      + (SELECT COUNT(*) FROM entries WHERE json_extract(data, '$.family') IS NOT NULL) AS n`,
						)
						.get()?.n,
			),
		).toBe(0);
	});
});

describe("removing a ref", () => {
	it("finds a migrated context ref by its old id, keeps that id across an upsert, and refuses another family's ref", async () => {
		rmSync(base, { recursive: true, force: true });
		base = mkdtempSync(join(tmpdir(), "kabane-record-writes-"));
		await withDb((db) => must(Migrate.run(db, Migrations.LIST.slice(0, 13))));
		const task = must(await Legacy.addTask(base, { title: "t" }));
		const old = must(
			await Legacy.addContextRef(base, {
				taskId: task.id,
				uri: "file:a.md",
				kind: "spec",
			}),
		);
		const kept = must(
			await Legacy.addContextRef(base, {
				taskId: task.id,
				uri: "file:b.md",
				kind: "spec",
			}),
		);
		must(await Planner.init(base));
		const upstream = must(
			await Planner.upsertUpstreamLink(base, {
				taskId: task.id,
				provider: "github",
				externalId: "1",
				url: "https://example.org/1",
				title: "Up",
			}),
		);

		must(await Planner.deleteContextRef(base, old.id));
		must(
			await Planner.addContextRef(base, {
				taskId: task.id,
				uri: "file:b.md",
				kind: "spec",
				note: "again",
			}),
		);
		expect(
			must(await Planner.getContextRefs(base, task.id)).map((r) => r.uri),
		).toEqual(["file:b.md"]);
		must(await Planner.deleteContextRef(base, kept.id));
		expect(must(await Planner.getContextRefs(base, task.id))).toEqual([]);

		expect((await Planner.deleteContextRef(base, old.id)).ok).toBe(false);
		expect((await Planner.deleteContextRef(base, upstream.id)).ok).toBe(false);
		expect(
			must(await Planner.getUpstreamLinksForTask(base, task.id)),
		).toHaveLength(1);
	});

	it("gives a parent edge an id no ref key can spell", async () => {
		const parent = must(await Planner.addTask(base, { title: "parent" }));
		const child = must(await Planner.addTask(base, { title: "child" }));
		const link = must(
			await Planner.addLink(base, {
				sourceId: parent.id,
				targetId: child.id,
				type: "parent",
			}),
		);
		expect(link.id.startsWith("parent:")).toBe(true);
		const refShaped = JSON.stringify([
			parent.id,
			`kabane://thread/${child.id}`,
			"parent",
		]);
		expect((await Planner.deleteLink(base, refShaped)).ok).toBe(false);
		expect(must(await Planner.getTask(base, child.id))?.parentTaskId).toBe(
			parent.id,
		);
	});

	it("undoes a parent link by the id adding it returned", async () => {
		const parent = must(await Planner.addTask(base, { title: "parent" }));
		const child = must(await Planner.addTask(base, { title: "child" }));
		const link = must(
			await Planner.addLink(base, {
				sourceId: parent.id,
				targetId: child.id,
				type: "parent",
			}),
		);
		expect(must(await Planner.getTask(base, child.id))?.parentTaskId).toBe(
			parent.id,
		);
		must(await Planner.deleteLink(base, link.id));
		expect(
			must(await Planner.getTask(base, child.id))?.parentTaskId,
		).toBeUndefined();
	});
});

describe("the Task read credits the latest write", () => {
	it("credits an edit after a task whose clock is ahead of this device's", async () => {
		configureTestRuntime({ actor: () => "kabane://actor/human/original" });
		const task = must(await Planner.addTask(base, { title: "t" }));
		await withDb((db) => {
			db.run(
				"UPDATE threads SET updated_at = '2099-01-01T00:00:00.000Z', state_updated_at = '2099-01-01T00:00:00.000Z' WHERE id = ?",
				[task.id],
			);
			db.run(
				"UPDATE attributes SET updated_at = '2099-01-01T00:00:00.000Z' WHERE thread_id = ?",
				[task.id],
			);
		});
		configureTestRuntime({ actor: () => "kabane://actor/human/editor" });
		const edited = must(
			await Planner.updateTask(base, task.id, { deadline: "2027-01-01" }),
		);
		expect(edited).toMatchObject({
			version: 2,
			updatedBy: "kabane://actor/human/editor",
		});
	});

	it("counts a first-time attribute and names its writer", async () => {
		configureTestRuntime({ actor: () => "kabane://actor/human/ada" });
		const task = must(await Planner.addTask(base, { title: "t" }));
		expect(task.version).toBe(1);
		configureTestRuntime({ actor: () => "kabane://actor/agent/claude" });
		const edited = must(
			await Planner.updateTask(base, task.id, { deadline: "2027-01-01" }),
		);
		expect(edited).toMatchObject({
			version: 2,
			updatedBy: "kabane://actor/agent/claude",
		});
	});
});

describe("the work log is append-only", () => {
	it("refuses a delete, saying so", async () => {
		const task = must(await Planner.addTask(base, { title: "t" }));
		const log = must(
			await Planner.addWorkLog(base, {
				taskId: task.id,
				refs: [{ uri: "commit:a" }],
			}),
		);
		const removed = await Planner.deleteWorkLog(base, log.id);
		expect(removed.ok).toBe(false);
		expect(removed.ok ? "" : removed.error.message).toContain("append-only");
		expect(must(await Planner.getWorkLogs(base, task.id))).toHaveLength(1);
	});
});

describe("one declaration of what replicates", () => {
	it("looks up every table export and backfill enumerate, a disabled module's included", async () => {
		const notes = {
			name: "notes",
			migrations: [
				{
					name: "create",
					up: (db: Db) =>
						db.run(
							"CREATE TABLE notes_rows (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, updated_by TEXT, version INTEGER NOT NULL DEFAULT 1, visibility TEXT NOT NULL DEFAULT 'shared', updated_at TEXT)",
						),
				},
			],
			syncTables: [
				{
					table: "notes_rows",
					family: "row-lww" as const,
					clock: "updated_at",
					childOfTasks: true,
				},
			],
		};
		configureTestRuntime({ modules: [notes] });
		must(await Planner.init(base));
		configureTestRuntime();
		const tables = await withDb((db) => Replicated.tables(db));
		expect(tables.map(({ table }) => table)).toContain("notes_rows");
		await withDb((db) => {
			for (const { table } of tables)
				expect(Replicated.lookup(db, table)?.table).toBe(table);
			expect(Replicated.lookup(db, "notes_rows")?.unregisteredModule).toBe(
				"notes",
			);
			expect(Replicated.lookup(db, "sequences")).toBeUndefined();
		});
	});

	it("refuses a write to a retired table once migration 14 has run", async () => {
		const task = must(await Planner.addTask(base, { title: "t" }));
		const captured = await withDb((db) => {
			must(Oplog.initDevice(db, "device-a"));
			const row = db
				.query<Record<string, unknown>, [string]>(
					"SELECT * FROM tasks WHERE id = ?",
				)
				.get(task.id);
			return Oplog.capture(db, { tbl: "tasks", op: "insert", row: row ?? {} });
		});
		expect(captured.ok).toBe(false);
	});
});

describe("a point read", () => {
	it("reads one task of a 700-deep chain without walking every thread", async () => {
		const now = new Date().toISOString();
		await withDb((db) => {
			let parent: string | null = null;
			for (let i = 0; i < 700; i++) {
				const id = `01KZCHAIN${String(i).padStart(17, "0")}`;
				db.run(
					`INSERT INTO threads (id, short_id, kind, title, parent_id, created_at,
					   updated_at, state, state_updated_at)
					 VALUES (?, ?, 'task', ?, ?, ?, ?, 'inbox', ?)`,
					[id, `JCHA-${i + 1}`, `link ${i}`, parent, now, now, now],
				);
				parent = id;
			}
		});
		const started = performance.now();
		const root = must(await Planner.getTask(base, "JCHA-1"));
		const elapsed = performance.now() - started;
		expect(root?.title).toBe("link 0");
		expect(elapsed).toBeLessThan(100);
	});
});
