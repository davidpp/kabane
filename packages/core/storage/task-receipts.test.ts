import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteDb } from "@cabane/sqlite";
import { TABLES } from "../db/tables";
import { Runtime, withDb } from "../runtime";
import { taskReceipt } from "../task-output";
import { configureTestRuntime } from "../testing";
import { prospectiveShortId } from "./helpers";
import { Planner } from "./index";
import { Oplog } from "./oplog";

let base: string;
afterEach(() => {
	if (base) rmSync(base, { recursive: true, force: true });
	configureTestRuntime();
});
describe("prospective scope labels", () => {
	for (const prefix of ["", "receipt_"])
		it(`previews new/existing counters without writes and agrees with allocation (${prefix})`, async () => {
			base = mkdtempSync(join(tmpdir(), "kabane-receipt-label-"));
			Runtime.configure({
				provider: SqliteDb.provider(),
				tablePrefix: prefix,
				timezone: () => "UTC",
			});
			expect((await Planner.init(base)).ok).toBe(true);
			const before = await withDb(base, (db) =>
				db.query(`SELECT * FROM ${TABLES.sequences}`).all(),
			);
			const fresh = await prospectiveShortId(base, "JNEW");
			expect(fresh).toEqual({ ok: true, value: "JNEW-1" });
			expect(
				await withDb(base, (db) =>
					db.query(`SELECT * FROM ${TABLES.sequences}`).all(),
				),
			).toEqual(before);
			const added = await Planner.addTask(base, {
				title: "Label preview",
				scopeUri: "new",
			});
			if (!added.ok) return;
			expect(added.value.shortId).toBe("JNEW-1");
			const prior = await withDb(base, (db) => {
				db.run(
					`UPDATE ${TABLES.sequences} SET next_number = 9 WHERE prefix = 'JNEW'`,
				);
				return db.query(`SELECT * FROM ${TABLES.sequences}`).all();
			});
			const next = await prospectiveShortId(base, "JNEW");
			expect(next).toEqual({ ok: true, value: "JNEW-10" });
			expect(
				await withDb(base, (db) =>
					db.query(`SELECT * FROM ${TABLES.sequences}`).all(),
				),
			).toEqual(prior);
			const updated = await Planner.updateTaskReceipt(base, added.value.id, {
				scopeUri: "new",
			});
			expect(updated.ok).toBe(true);
			if (updated.ok) {
				expect(updated.value.shortId).toBe("JNEW-10");
				expect(updated.value.version).toBe(2);
			}
		});
	it("keeps an honest postwrite error when a genuine concurrent counter advance crosses the receipt boundary", async () => {
		base = mkdtempSync(join(tmpdir(), "kabane-receipt-race-"));
		configureTestRuntime();
		expect((await Planner.init(base)).ok).toBe(true);
		const added = await Planner.addTask(base, {
			title: "Boundary",
			scopeUri: "old",
		});
		if (!added.ok) return;
		let importedId = "";
		for (let length = 1850; length <= 2050; length++) {
			const id = "X".repeat(length);
			const prospective = { ...added.value, id, shortId: "JNEW-9", version: 2 };
			if (
				taskReceipt(prospective).ok &&
				!taskReceipt({ ...prospective, shortId: "JNEW-10" }).ok
			) {
				importedId = id;
				break;
			}
		}
		expect(importedId.length).toBeGreaterThan(0);
		expect(
			(
				await withDb(base, (db) => {
					db.run(
						`UPDATE ${TABLES.tasks} SET id = ?, short_id = NULL WHERE id = ?`,
						[importedId, added.value.id],
					);
					db.run(
						`INSERT INTO ${TABLES.sequences} (prefix, next_number, scope_uri, created_at) VALUES ('JNEW', 8, 'jake://scope/new', ?)`,
						[new Date().toISOString()],
					);
					expect(Oplog.initDevice(db, "receipt-race").ok).toBe(true);
				})
			).ok,
		).toBe(true);
		const provider = SqliteDb.provider();
		let reads = 0;
		Runtime.configure({
			provider: {
				withDb: (path, fn) =>
					provider.withDb(path, (db) => {
						if (++reads === 3)
							db.run(
								`UPDATE ${TABLES.sequences} SET next_number = 9 WHERE prefix = 'JNEW'`,
							);
						return fn(db);
					}),
			},
		});
		const receipt = await Planner.updateTaskReceipt(base, importedId, {
			scopeUri: "new",
		});
		expect(receipt.ok).toBe(false);
		if (!receipt.ok) {
			expect(receipt.error.message).toContain("Task was updated");
			expect(receipt.error.message).not.toContain("no mutation occurred");
		}
		const updated = await Planner.getTask(base, importedId);
		expect(updated.ok).toBe(true);
		if (updated.ok) {
			expect(updated.value?.shortId).toBe("JNEW-10");
			expect(updated.value?.version).toBe(2);
			expect(updated.value?.scopeUri).toBe("jake://scope/new");
		}
	});
});
