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

describe("a row keeps its family whatever its kind", () => {
	it("keeps a comment of kind log on the timeline, out of the work log", async () => {
		const task = must(await Planner.addTask(base, { title: "t" }));
		must(
			await Planner.addEntry(base, {
				taskId: task.id,
				kind: "log",
				author: "me",
				authorType: "human",
				content: "a comment called log",
			}),
		);
		expect(
			must(await Planner.getEntries(base, task.id)).map((e) => e.content),
		).toEqual(["a comment called log"]);
		expect(must(await Planner.getWorkLogs(base, task.id))).toEqual([]);
	});

	it("keeps a context ref of kind upstream a context ref, in one write", async () => {
		const task = must(await Planner.addTask(base, { title: "t" }));
		must(
			await Planner.addContextRef(base, {
				taskId: task.id,
				uri: "file:a.md",
				kind: "spec",
			}),
		);
		const moved = must(
			await Planner.addContextRef(base, {
				taskId: task.id,
				uri: "file:a.md",
				kind: "upstream",
			}),
		);
		expect(moved.kind).toBe("upstream");
		expect(
			must(await Planner.getContextRefs(base, task.id)).map((r) => r.kind),
		).toEqual(["upstream"]);
		expect(must(await Planner.getUpstreamLinksForTask(base, task.id))).toEqual(
			[],
		);
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
	it("looks up every table export and backfill enumerate, and a retired one capture still takes", async () => {
		const tables = await withDb((db) => Replicated.tables(db));
		for (const { table } of tables)
			expect(Replicated.lookup(table)?.table).toBe(table);
		expect(Replicated.lookup("task_comments")?.retired).toBe(true);
		expect(tables.map(({ table }) => table)).not.toContain("task_comments");
		expect(Replicated.lookup("sequences")).toBeUndefined();
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
