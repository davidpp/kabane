/**
 * Planner Sync — Apply
 *
 * Hand-built pages for the cases two converging devices cannot reach on demand:
 * a column this build has never heard of, a table it does not replicate, and
 * applying before sync was armed. The record's own cases are in
 * `record-apply.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../db/port";
import { withDb as runWithDb } from "../runtime";
import "../testing";

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

/** A project: the core table beside the record that still resolves by row LWW. */
const projectPayload = (id: string, extra: Row = {}): Row => ({
	id,
	short_id: null,
	title: `project ${id}`,
	state: "active",
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

const projectRow = (id: string): Promise<Row | null> =>
	withDb((db) =>
		db
			.query<Row, [string]>(`SELECT * FROM ${TABLES.projects} WHERE id = ?`)
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

	it("drops a column this build does not have rather than aborting", async () => {
		await arm();

		const report = await Apply.applyBatch(
			base,
			page([
				insertOp(1, "projects", "future-1", {
					...projectPayload("future-1"),
					invented_by_a_newer_device: "surprise",
				}),
			]),
		);

		expect(report.ok).toBe(true);
		if (!report.ok) return;
		expect(report.value.applied).toBe(1);
		const row = await projectRow("future-1");
		expect(row?.title).toBe("project future-1");
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
			page([insertOp(1, "projects", "nope-1", projectPayload("nope-1"))]),
		);

		expect(report.ok).toBe(false);
		if (report.ok) return;
		expect(report.error.message).toContain("no sync state");
		expect(await projectRow("nope-1")).toBeNull();
	});
});

describe("Apply — the newest delete is the evidence", () => {
	beforeEach(async () => {
		base = join(tmpdir(), `planner-apply-deletes-${crypto.randomUUID()}`);
		mkdirSync(base, { recursive: true });
		const init = await Planner.init(base);
		if (!init.ok) throw init.error;
		const armed = await runWithDb(base, (db) =>
			Oplog.initDevice(db, "device-local"),
		);
		if (!armed.ok) throw armed.error;
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	const at = (second: number): string =>
		`2026-08-03T12:00:${String(second).padStart(2, "0")}.000Z`;

	const deleteOp = (
		serverSeq: number,
		rowId: string,
		capturedAt: string,
	): RelayOp => ({
		opId: `op-${serverSeq}`,
		deviceId: REMOTE,
		tbl: "projects",
		rowId,
		op: "delete",
		capturedAt,
		serverSeq,
	});

	it("keeps a row deleted when a delayed older delete and then an update between the two arrive", async () => {
		const report = await Apply.applyBatch(
			base,
			page([
				insertOp(
					1,
					"projects",
					"row-1",
					projectPayload("row-1", { updated_at: at(0) }),
				),
				deleteOp(2, "row-1", at(30)),
				// Another device's delete, captured at 10 and delivered late.
				deleteOp(3, "row-1", at(10)),
				{
					...insertOp(4, "projects", "row-1", {
						...projectPayload("row-1", { updated_at: at(20) }),
						title: "stale",
					}),
					op: "update",
					rowUpdatedAt: at(20),
				},
			]),
		);

		expect(report.ok).toBe(true);
		if (!report.ok) return;
		expect(report.value.skipped.deleted).toBe(1);
		expect(await projectRow("row-1")).toBeNull();
	});
});
