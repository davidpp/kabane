/**
 * Planner Sync — Apply
 *
 * Hand-built pages for the cases two converging devices cannot reach on demand:
 * the FK parents `Resolve` does not guard, a column this build has never heard
 * of, and applying before sync was armed.
 */

import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/port";
import { withDb as runWithDb } from "../runtime";

import { TABLES } from "../storage/helpers";
import { Planner } from "../storage/index";
import { Oplog } from "../storage/oplog";
import { Apply } from "./apply";
import type { PullPage, RelayOp } from "./transport";

type Row = Record<string, unknown>;

const REMOTE = "device-remote";
const NOW = "2026-08-03T12:00:00.000Z";

let base: string;

const withDb = async <T>(fn: (db: Db) => T): Promise<T> => {
	const result = await runWithDb(base, fn);
	if (!result.ok) throw result.error;
	return result.value;
};

const taskPayload = (id: string, extra: Row = {}): Row => ({
	id,
	short_id: null,
	title: `task ${id}`,
	kind: "task",
	state: "inbox",
	priority: "normal",
	source: "human",
	discovered_at: NOW,
	created_at: NOW,
	updated_at: NOW,
	...extra,
});

const insertOp = (
	serverSeq: number,
	tbl: string,
	rowId: string,
	payload: Row,
): RelayOp => ({
	opId: `op-${serverSeq}`,
	deviceId: REMOTE,
	tbl,
	rowId,
	op: "insert",
	rowUpdatedAt: NOW,
	payload,
	capturedAt: NOW,
	serverSeq,
});

const page = (ops: RelayOp[]): PullPage => ({
	ops,
	throughSeq: ops[ops.length - 1]?.serverSeq ?? 0,
	hasMore: false,
});

const taskRow = (id: string): Promise<Row | null> =>
	withDb((db) =>
		db
			.query<Row, [string]>(`SELECT * FROM ${TABLES.tasks} WHERE id = ?`)
			.get(id),
	);

describe("Apply — FK safety and unknown columns", () => {
	beforeEach(async () => {
		base = join(tmpdir(), `planner-apply-${crypto.randomUUID()}`);
		mkdirSync(base, { recursive: true });

		const init = await Planner.init(base);
		if (!init.ok) throw init.error;
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	const arm = () =>
		withDb((db) => {
			const armed = Oplog.initDevice(db, "device-local");
			if (!armed.ok) throw armed.error;
		});

	it("skips a task whose parent_task_id was deleted elsewhere, and keeps the batch", async () => {
		await arm();

		// Resolve only guards the four tables holding an FK to tasks; tasks has two
		// FKs of its own, and a dangling one aborts the whole transaction.
		const report = await Apply.applyBatch(
			base,
			page([
				insertOp(1, "tasks", "orphan-1", {
					...taskPayload("orphan-1"),
					parent_task_id: "01KZNOSUCHPARENT0000000000",
				}),
				insertOp(2, "tasks", "sibling-1", taskPayload("sibling-1")),
			]),
		);

		expect(report.ok).toBe(true);
		if (!report.ok) return;
		expect(report.value.skipped["orphan-parent"]).toBe(1);
		expect(report.value.applied).toBe(1);
		expect(await taskRow("orphan-1")).toBeNull();
		expect(await taskRow("sibling-1")).not.toBeNull();
	});

	it("clears a project_id whose project was deleted elsewhere instead of dropping the task", async () => {
		await arm();

		// projects is ON DELETE SET NULL, so the receiving device's own FK already
		// nulled this column when it applied the project's delete. Mirroring it
		// converges; skipping the task would lose it on one device only.
		const report = await Apply.applyBatch(
			base,
			page([
				insertOp(1, "tasks", "kept-1", {
					...taskPayload("kept-1"),
					project_id: "01KZNOSUCHPROJECT000000000",
				}),
			]),
		);

		expect(report.ok).toBe(true);
		if (!report.ok) return;
		expect(report.value.clearedRefs).toBe(1);
		expect(report.value.applied).toBe(1);
		expect((await taskRow("kept-1"))?.project_id).toBeNull();
	});

	it("drops a column this build does not have rather than aborting", async () => {
		await arm();

		const report = await Apply.applyBatch(
			base,
			page([
				insertOp(1, "tasks", "future-1", {
					...taskPayload("future-1"),
					invented_by_a_newer_device: "surprise",
				}),
			]),
		);

		expect(report.ok).toBe(true);
		if (!report.ok) return;
		expect(report.value.applied).toBe(1);
		const row = await taskRow("future-1");
		expect(row?.title).toBe("task future-1");
		expect(row).not.toHaveProperty("invented_by_a_newer_device");
	});

	it("counts a table this build does not replicate as a skip, not a failure", async () => {
		await arm();

		const report = await Apply.applyBatch(
			base,
			page([insertOp(1, "invented_table", "x-1", { id: "x-1" })]),
		);

		expect(report.ok).toBe(true);
		if (!report.ok) return;
		expect(report.value.skipped["unknown-table"]).toBe(1);
		expect(report.value.throughSeq).toBe(1);
	});

	it("refuses to apply before sync is armed", async () => {
		const report = await Apply.applyBatch(
			base,
			page([insertOp(1, "tasks", "nope-1", taskPayload("nope-1"))]),
		);

		expect(report.ok).toBe(false);
		if (report.ok) return;
		expect(report.error.message).toContain("no sync state");
		expect(await taskRow("nope-1")).toBeNull();
	});
});
