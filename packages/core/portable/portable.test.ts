import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/port";
import type { Result } from "../result";
import { withDb } from "../runtime";
import { Planner } from "../storage";
import { Oplog } from "../storage/oplog";
import { configureTestRuntime } from "../testing";
import { Portable } from "./index";

const value = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
const completeSnapshot = (db: Db) => {
	const snapshot = value(Portable.snapshot(db));
	if ("omitted" in snapshot) throw new Error("Incomplete snapshot");
	return snapshot;
};
let root: string;
let source: string;
let rebuilt: string;
const scopeUri = "kabane://scope/portable";

beforeEach(async () => {
	configureTestRuntime({
		modules: [
			{
				name: "annotations",
				migrations: [
					{
						name: "create-annotations",
						up: (db) =>
							db.run(
								"CREATE TABLE annotations (id TEXT PRIMARY KEY, task_id TEXT, updated_by TEXT, version INTEGER, visibility TEXT, big INTEGER, bytes BLOB)",
							),
					},
				],
				syncTables: [
					{ table: "annotations", family: "append-only", childOfTasks: true },
				],
			},
		],
	});
	root = mkdtempSync(join(tmpdir(), "kabane-portable-"));
	source = join(root, "source");
	rebuilt = join(root, "rebuilt");
	for (const home of [source, rebuilt]) value(await Planner.init(home));
});
afterEach(() => {
	configureTestRuntime();
	rmSync(root, { recursive: true, force: true });
});

it("restores an unminted thread label verbatim", async () => {
	const task = value(
		await Planner.addTask(source, { title: "Odd label", scopeUri }),
	);
	const label = "ODD-99999999999999999";
	const snapshot = value(
		await withDb(source, (db) => {
			db.run("UPDATE threads SET short_id=? WHERE id=?", [label, task.id]);
			return completeSnapshot(db);
		}),
	);
	value(
		await withDb(rebuilt, (db) =>
			value(Portable.restore(db, Portable.encode(snapshot))),
		),
	);
	expect(value(await Planner.getTask(rebuilt, task.id))?.shortId).toBe(label);
});

it("rebuilds every declared table, including private module rows, and detects a same-count change", async () => {
	const project = value(
		await Planner.addProject(source, { title: "Project", scopeUri }),
	);
	const task = value(
		await Planner.addTask(source, {
			title: "First",
			scopeUri,
			projectId: project.id,
		}),
	);
	const next = value(
		await Planner.addTask(source, { title: "Second", scopeUri }),
	);
	const taskId = task.id;
	value(
		await Planner.addLink(source, {
			sourceId: taskId,
			targetId: next.id,
			type: "related",
		}),
	);
	value(
		await Planner.addComment(source, {
			taskId,
			content: "Line one\nLine two",
			author: "writer",
			authorType: "human",
		}),
	);
	value(
		await Planner.addWorkLog(source, {
			taskId,
			refs: [{ uri: "commit:sample" }],
		}),
	);
	value(
		await Planner.addContextRef(source, {
			taskId,
			uri: "file:readme",
			kind: "doc",
		}),
	);
	value(
		await Planner.upsertUpstreamLink(source, {
			taskId,
			provider: "github",
			externalId: "sample",
			identifier: "repo#1",
			url: "https://example.org/1",
			title: "Upstream",
		}),
	);
	const snapshot = value(
		await withDb(source, (db) => {
			db.run(
				"INSERT INTO annotations VALUES (?,?,?,2,'private',9223372036854775807,X'0044FF')",
				["note", taskId, "writer"],
			);
			Oplog.afterWrite(db, "annotations", "insert", "note");
			db.run("UPDATE sequences SET next_number=1 WHERE prefix='JPOR'");
			return completeSnapshot(db);
		}),
	);
	const original = value(await Portable.manifest(snapshot));
	for (const { count } of Object.values(original))
		expect(count).toBeGreaterThan(0);
	const jsonl = Portable.encode(snapshot);
	const target = value(
		await withDb(rebuilt, (db) => {
			value(Oplog.initDevice(db, "restored"));
			value(Portable.restore(db, jsonl));
			expect(
				db
					.query(
						"SELECT next_number,scope_uri FROM sequences WHERE prefix='JPOR'",
					)
					.get(),
			).toEqual({ next_number: 3, scope_uri: scopeUri });
			expect(
				db
					.query(
						"SELECT cast(big AS TEXT) AS n, hex(bytes) AS bytes FROM annotations",
					)
					.get(),
			).toEqual({ n: "9223372036854775807", bytes: "0044FF" });
			expect(db.query("SELECT count(*) AS n FROM sync_oplog").get()).toEqual({
				n: 0,
			});
			return completeSnapshot(db);
		}),
	);
	expect(value(await Portable.manifest(target))).toEqual(original);
	value(await Planner.updateTask(rebuilt, taskId, { title: "Changed" }));
	const changed = value(
		await Portable.manifest(value(await withDb(rebuilt, completeSnapshot))),
	);
	expect(
		Portable.compare(original, changed)
			.filter((row) => !row.match)
			.map((row) => row.table),
	).toEqual(["threads"]);
	const added = value(
		await Planner.addTask(rebuilt, { title: "Third", scopeUri }),
	);
	expect(added.shortId).toBe("JPOR-4");
});

it("refuses a newer core or module schema", async () => {
	const snapshot = value(await withDb(source, completeSnapshot));
	const header = JSON.parse(Portable.encode(snapshot));
	for (const newer of [
		{ ...header, core: header.core + 1 },
		{ ...header, modules: { annotations: 2 } },
	]) {
		const result = value(
			await withDb(rebuilt, (db) =>
				Portable.restore(db, JSON.stringify(newer)),
			),
		);
		expect(!result.ok && result.error.message).toContain("schema versions");
	}
});

it("puts each thread before its children and unowned rows last", async () => {
	const a = value(await Planner.addTask(source, { title: "A", scopeUri }));
	const b = value(await Planner.addTask(source, { title: "B", scopeUri }));
	const project = value(
		await Planner.addProject(source, { title: "P", scopeUri }),
	);
	const snapshot = value(
		await withDb(source, (db) => {
			for (const task of [b, a]) {
				db.run("INSERT INTO annotations(id,task_id) VALUES (?,?)", [
					"annotation-" + task.id,
					task.id,
				]);
			}
			return completeSnapshot(db);
		}),
	);
	const ids = Portable.encode(snapshot)
		.trimEnd()
		.split("\n")
		.slice(1)
		.map((line) => JSON.parse(line))
		// Each task's attributes sit in its group too.
		.filter((doc) => doc.table !== "attributes")
		.map((doc) => doc.id);
	expect(ids).toEqual([
		...[a, b]
			.sort((x, y) => x.id.localeCompare(y.id))
			.flatMap((task) => [task.id, "annotation-" + task.id]),
		project.id,
	]);
});

it("reports a disabled module's recorded tables with their row counts", async () => {
	value(
		await withDb(source, (db) =>
			db.run("INSERT INTO annotations(id) VALUES ('one')"),
		),
	);
	configureTestRuntime();
	const result = value(value(await withDb(source, Portable.snapshot)));
	expect(result).toEqual({
		omitted: [{ table: "annotations", module: "annotations", count: 1 }],
	});
});

it("digests the SQLite storage class even when the adapter returns the same number", async () => {
	const capture = async (sql: string) => {
		const snapshot = value(
			await withDb(source, (db) => {
				db.run(sql);
				return completeSnapshot(db);
			}),
		);
		return value(await Portable.manifest(snapshot));
	};
	const integer = await capture(
		"INSERT INTO annotations(id,bytes) VALUES ('one',1)",
	);
	const real = await capture("UPDATE annotations SET bytes=1.0");
	expect(integer.annotations?.count).toBe(1);
	expect(real.annotations?.count).toBe(1);
	expect(real.annotations?.digest).not.toEqual(integer.annotations?.digest);
});

it("returns errors on malformed input and rolls back partial restores", async () => {
	const task = value(await Planner.addTask(source, { title: "A", scopeUri }));
	const jsonl = Portable.encode(value(await withDb(source, completeSnapshot)));
	value(
		await withDb(rebuilt, (db) => {
			for (const input of ["{", jsonl + "{", jsonl + "{}"]) {
				expect(Portable.restore(db, input).ok).toBe(false);
				expect(
					db.query("SELECT id FROM tasks WHERE id=?").get(task.id),
				).toBeNull();
			}
		}),
	);
});
