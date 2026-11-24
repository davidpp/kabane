import { describe, expect, it } from "bun:test";
import type { SyncOp } from "../schemas";
import {
	Resolve,
	type ResolveDecision,
	type ResolveLocalState,
} from "./resolve";

type Row = Record<string, unknown>;

/** ULID order decides rows that two devices minted separately. */
const LOW = "01KZ0000000000000000000001";
const HIGH = "01KZ0000000000000000000002";

/** Device order decides same-id rows, where ULIDs are equal by definition. */
const DEVICE_A = "device-aaa";
const DEVICE_B = "device-bbb";

const T1 = "2026-08-03T10:00:00.000Z";
const T2 = "2026-08-03T11:00:00.000Z";
const T3 = "2026-08-03T12:00:00.000Z";

const NO_LOCAL: ResolveLocalState = {
	byId: undefined,
	byNaturalKey: undefined,
	byShortId: undefined,
	parentPresent: undefined,
	deletedAt: undefined,
	localDeviceId: DEVICE_A,
};

const local = (over: Partial<ResolveLocalState>): ResolveLocalState => ({
	...NO_LOCAL,
	...over,
});

const makeOp = (
	over: Partial<SyncOp> & Pick<SyncOp, "tbl" | "rowId" | "op">,
): SyncOp => ({
	opId: `op-${over.tbl}-${over.rowId}-${over.op}`,
	deviceId: DEVICE_B,
	capturedAt: T2,
	...over,
});

const projectRow = (id: string, updatedAt: string, extra: Row = {}): Row => ({
	id,
	short_id: "JMIL-5",
	title: "Task",
	state: "inbox",
	created_at: T1,
	updated_at: updatedAt,
	...extra,
});

type Case = {
	name: string;
	op: SyncOp;
	state: ResolveLocalState;
	expected: ResolveDecision;
};

// ============================================================
// One case per rule
// ============================================================

const cases: Case[] = [
	{
		name: "unknown table: a newer device's table is skipped, not failed",
		op: makeOp({
			tbl: "widgets",
			rowId: LOW,
			op: "insert",
			payload: { id: LOW },
		}),
		state: NO_LOCAL,
		expected: { kind: "skip", reason: "unknown-table" },
	},
	{
		name: "insert with no payload is malformed",
		op: makeOp({ tbl: "projects", rowId: LOW, op: "insert" }),
		state: NO_LOCAL,
		expected: { kind: "skip", reason: "malformed-payload" },
	},

	// --- projects: row LWW (the record resolves under its own rules) ---
	{
		name: "projects: absent locally, applied",
		op: makeOp({
			tbl: "projects",
			rowId: LOW,
			op: "insert",
			rowUpdatedAt: T2,
			payload: projectRow(LOW, T2),
		}),
		state: NO_LOCAL,
		expected: {
			kind: "apply",
			rowId: LOW,
			row: projectRow(LOW, T2),
			dropRowId: undefined,
		},
	},
	{
		name: "projects: strictly newer incoming wins",
		op: makeOp({
			tbl: "projects",
			rowId: LOW,
			op: "update",
			rowUpdatedAt: T3,
			payload: projectRow(LOW, T3, { title: "Newer" }),
		}),
		state: local({ byId: projectRow(LOW, T2), byShortId: projectRow(LOW, T2) }),
		expected: {
			kind: "apply",
			rowId: LOW,
			row: projectRow(LOW, T3, { title: "Newer" }),
			dropRowId: undefined,
		},
	},
	{
		name: "projects: older incoming loses",
		op: makeOp({
			tbl: "projects",
			rowId: LOW,
			op: "update",
			rowUpdatedAt: T1,
			payload: projectRow(LOW, T1),
		}),
		state: local({ byId: projectRow(LOW, T2) }),
		expected: { kind: "skip", reason: "not-newer" },
	},
	{
		name: "projects: a row without a short_id",
		op: makeOp({
			tbl: "projects",
			rowId: LOW,
			op: "update",
			rowUpdatedAt: T3,
			payload: { id: LOW, short_id: null, title: "P", updated_at: T3 },
		}),
		state: local({ byId: { id: LOW, title: "P0", updated_at: T2 } }),
		expected: {
			kind: "apply",
			rowId: LOW,
			row: { id: LOW, short_id: null, title: "P", updated_at: T3 },
			dropRowId: undefined,
		},
	},

	{
		name: "orphan rule is scoped to child tables: a project never orphans",
		op: makeOp({
			tbl: "projects",
			rowId: LOW,
			op: "insert",
			rowUpdatedAt: T2,
			payload: projectRow(LOW, T2),
		}),
		state: local({ parentPresent: false }),
		expected: {
			kind: "apply",
			rowId: LOW,
			row: projectRow(LOW, T2),
			dropRowId: undefined,
		},
	},

	// --- deletes ---
	{
		name: "delete: no newer local update, applied",
		op: makeOp({ tbl: "projects", rowId: LOW, op: "delete", capturedAt: T3 }),
		state: local({ byId: projectRow(LOW, T2) }),
		expected: { kind: "delete", rowId: LOW },
	},
	{
		name: "delete: loses to a strictly newer local update",
		op: makeOp({ tbl: "projects", rowId: LOW, op: "delete", capturedAt: T2 }),
		state: local({ byId: projectRow(LOW, T3) }),
		expected: { kind: "skip", reason: "newer-local-update" },
	},
	{
		name: "delete: row already gone",
		op: makeOp({ tbl: "projects", rowId: LOW, op: "delete", capturedAt: T3 }),
		state: NO_LOCAL,
		expected: { kind: "skip", reason: "already-absent" },
	},
	{
		name: "delete first: a late update to a deleted row is dropped",
		op: makeOp({
			tbl: "projects",
			rowId: LOW,
			op: "update",
			rowUpdatedAt: T1,
			payload: projectRow(LOW, T1),
		}),
		state: local({ deletedAt: T2 }),
		expected: { kind: "skip", reason: "deleted" },
	},
	{
		name: "delete first: an update strictly newer than the delete resurrects the row",
		op: makeOp({
			tbl: "projects",
			rowId: LOW,
			op: "update",
			rowUpdatedAt: T3,
			payload: projectRow(LOW, T3),
		}),
		state: local({ deletedAt: T2 }),
		expected: {
			kind: "apply",
			rowId: LOW,
			row: projectRow(LOW, T3),
			dropRowId: undefined,
		},
	},
	{
		name: "delete first: an update at exactly the delete's capture time is dropped",
		op: makeOp({
			tbl: "projects",
			rowId: LOW,
			op: "update",
			rowUpdatedAt: T2,
			payload: projectRow(LOW, T2),
		}),
		state: local({ deletedAt: T2 }),
		expected: { kind: "skip", reason: "deleted" },
	},
];

describe("Resolve.decide", () => {
	for (const testCase of cases) {
		it(testCase.name, () => {
			expect(Resolve.decide(testCase.op, testCase.state)).toEqual(
				testCase.expected,
			);
		});
	}
});

// ============================================================
// Same-id clock ties: device order is the tie-break of last resort
// ============================================================

describe("Resolve.decide — same-id clock tie", () => {
	/** One row, one `updated_at`, two devices holding different content. */
	const edit = (deviceId: string, title: string): SyncOp =>
		makeOp({
			tbl: "projects",
			rowId: LOW,
			op: "update",
			deviceId,
			rowUpdatedAt: T2,
			payload: projectRow(LOW, T2, { title }),
		});

	it("converges on the lower device_id from both directions", () => {
		// On device-aaa: bbb's op arrives, loses, aaa keeps its own row.
		const onA = Resolve.decide(
			edit(DEVICE_B, "from bbb"),
			local({
				byId: projectRow(LOW, T2, { title: "from aaa" }),
				localDeviceId: DEVICE_A,
			}),
		);
		// On device-bbb: aaa's op arrives, wins, bbb takes it.
		const onB = Resolve.decide(
			edit(DEVICE_A, "from aaa"),
			local({
				byId: projectRow(LOW, T2, { title: "from bbb" }),
				localDeviceId: DEVICE_B,
			}),
		);

		expect(onA).toEqual({ kind: "skip", reason: "not-newer" });
		expect(onB).toEqual({
			kind: "apply",
			rowId: LOW,
			row: projectRow(LOW, T2, { title: "from aaa" }),
			dropRowId: undefined,
		});
		// Both machines end up holding aaa's title — the divergence is closed.
		if (onB.kind !== "apply") throw new Error("expected an apply");
		expect(onB.row.title).toBe("from aaa");
	});

	it("prefers the lineage with more writes before consulting actor or device", () => {
		// bbb sorts after aaa and its actor sorts after too; only version can
		// be carrying this.
		const decision = Resolve.decide(
			edit(DEVICE_B, "three edits on bbb"),
			local({
				byId: projectRow(LOW, T2, { title: "one edit on aaa", version: 1 }),
				localDeviceId: DEVICE_A,
			}),
		);
		expect(decision.kind).toBe("skip"); // same version (undefined vs 1) falls through to device

		const versioned = Resolve.decide(
			makeOp({
				tbl: "projects",
				rowId: LOW,
				op: "update",
				deviceId: DEVICE_B,
				rowUpdatedAt: T2,
				payload: projectRow(LOW, T2, {
					title: "three edits on bbb",
					version: 3,
					updated_by: "kabane://actor/human/zed",
				}),
			}),
			local({
				byId: projectRow(LOW, T2, {
					title: "one edit on aaa",
					version: 1,
					updated_by: "kabane://actor/human/amy",
				}),
				localDeviceId: DEVICE_A,
			}),
		);
		expect(versioned.kind).toBe("apply");
		if (versioned.kind === "apply") {
			expect(versioned.row.title).toBe("three edits on bbb");
		}
	});

	it("breaks an equal-version tie on the lower actor URI, from both directions", () => {
		const authored = (deviceId: string, actor: string, title: string): SyncOp =>
			makeOp({
				tbl: "projects",
				rowId: LOW,
				op: "update",
				deviceId,
				rowUpdatedAt: T2,
				payload: projectRow(LOW, T2, { title, version: 2, updated_by: actor }),
			});
		const held = (actor: string, title: string): Row =>
			projectRow(LOW, T2, { title, version: 2, updated_by: actor });

		// Device order says bbb loses; actor order says bbb's author (amy) wins.
		// Actor is consulted first, so amy's content lands on both machines.
		const onA = Resolve.decide(
			authored(DEVICE_B, "kabane://actor/human/amy", "from amy"),
			local({
				byId: held("kabane://actor/human/zed", "from zed"),
				localDeviceId: DEVICE_A,
			}),
		);
		const onB = Resolve.decide(
			authored(DEVICE_A, "kabane://actor/human/zed", "from zed"),
			local({
				byId: held("kabane://actor/human/amy", "from amy"),
				localDeviceId: DEVICE_B,
			}),
		);

		expect(onA.kind).toBe("apply");
		if (onA.kind === "apply") expect(onA.row.title).toBe("from amy");
		expect(onB).toEqual({ kind: "skip", reason: "not-newer" });
	});

	it("skips a re-delivered op from this same device", () => {
		const decision = Resolve.decide(
			edit(DEVICE_A, "from aaa"),
			local({
				byId: projectRow(LOW, T2, { title: "from aaa" }),
				localDeviceId: DEVICE_A,
			}),
		);

		expect(decision).toEqual({ kind: "skip", reason: "not-newer" });
	});

	it("never lets device order override a strictly newer clock", () => {
		// bbb sorts after aaa, so only the clock can be carrying this.
		const decision = Resolve.decide(
			makeOp({
				tbl: "projects",
				rowId: LOW,
				op: "update",
				deviceId: DEVICE_B,
				rowUpdatedAt: T3,
				payload: projectRow(LOW, T3, { title: "from bbb" }),
			}),
			local({
				byId: projectRow(LOW, T2, { title: "from aaa" }),
				localDeviceId: DEVICE_A,
			}),
		);

		expect(decision).toEqual({
			kind: "apply",
			rowId: LOW,
			row: projectRow(LOW, T3, { title: "from bbb" }),
			dropRowId: undefined,
		});
	});
});

// ============================================================
// short_id rename: winner is the ULID-earlier row
// ============================================================

describe("Resolve.decide — short_id collision", () => {
	const incoming = (rowId: string): SyncOp =>
		makeOp({
			tbl: "projects",
			rowId,
			op: "insert",
			rowUpdatedAt: T2,
			payload: projectRow(rowId, T2),
		});

	it("reassigns the local row when the incoming ULID is earlier", () => {
		const decision = Resolve.decide(
			incoming(LOW),
			local({ byShortId: projectRow(HIGH, T2) }),
		);

		expect(decision).toEqual({
			kind: "rename",
			rowId: LOW,
			row: projectRow(LOW, T2),
			loserId: HIGH,
			shortId: "JMIL-5",
		});
	});

	it("reassigns the incoming row when the local ULID is earlier", () => {
		const decision = Resolve.decide(
			incoming(HIGH),
			local({ byShortId: projectRow(LOW, T2) }),
		);

		expect(decision).toEqual({
			kind: "rename",
			rowId: HIGH,
			row: projectRow(HIGH, T2),
			loserId: HIGH,
			shortId: "JMIL-5",
		});
	});

	it("does not rename when the label is held by the same row", () => {
		const decision = Resolve.decide(
			incoming(LOW),
			local({ byId: projectRow(LOW, T1), byShortId: projectRow(LOW, T1) }),
		);

		expect(decision).toEqual({
			kind: "apply",
			rowId: LOW,
			row: projectRow(LOW, T2),
			dropRowId: undefined,
		});
	});

	it("does not rename when the incoming row lost LWW anyway", () => {
		const decision = Resolve.decide(
			makeOp({
				tbl: "projects",
				rowId: HIGH,
				op: "update",
				rowUpdatedAt: T1,
				payload: projectRow(HIGH, T1),
			}),
			local({ byId: projectRow(HIGH, T3), byShortId: projectRow(LOW, T2) }),
		);

		expect(decision).toEqual({ kind: "skip", reason: "not-newer" });
	});
});
