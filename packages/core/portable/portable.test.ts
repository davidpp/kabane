import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
								"CREATE TABLE annotations (id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, updated_by TEXT, version INTEGER, visibility TEXT, big INTEGER, bytes BLOB)",
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
			return Portable.snapshot(db);
		}),
	);
	const original = await Portable.manifest(snapshot);
	for (const { count } of Object.values(original))
		expect(count).toBeGreaterThan(0);
	const jsonl = Portable.encode(snapshot);
	const target = value(
		await withDb(rebuilt, (db) => {
			value(Oplog.initDevice(db, "restored"));
			Portable.restore(db, jsonl);
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
			return Portable.snapshot(db);
		}),
	);
	expect(await Portable.manifest(target)).toEqual(original);
	value(await Planner.updateTask(rebuilt, taskId, { title: "Changed" }));
	const changed = await Portable.manifest(
		value(await withDb(rebuilt, Portable.snapshot)),
	);
	expect(
		Portable.compare(original, changed)
			.filter((row) => !row.match)
			.map((row) => row.table),
	).toEqual(["tasks"]);
	const added = value(
		await Planner.addTask(rebuilt, { title: "Third", scopeUri }),
	);
	expect(added.shortId).toBe("JPOR-4");
});

it("refuses a newer core or module schema", async () => {
	const snapshot = value(await withDb(source, Portable.snapshot));
	const header = JSON.parse(Portable.encode(snapshot));
	for (const newer of [
		{ ...header, core: header.core + 1 },
		{ ...header, modules: { annotations: 2 } },
	]) {
		const result = await withDb(rebuilt, (db) =>
			Portable.restore(db, JSON.stringify(newer)),
		);
		expect(!result.ok && result.error.message).toContain("schema versions");
	}
});
