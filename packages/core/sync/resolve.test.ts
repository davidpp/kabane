import { describe, expect, it } from "bun:test";
import { z } from "zod";
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

const taskRow = (id: string, updatedAt: string, extra: Row = {}): Row => ({
	id,
	short_id: "JJAK-5",
	title: "Task",
	state: "inbox",
	created_at: T1,
	updated_at: updatedAt,
	...extra,
});

const commentRow = (id: string, taskId: string): Row => ({
	id,
	task_id: taskId,
	author: "david",
	author_type: "human",
	content: "note",
	created_at: T1,
	updated_at: null,
});

const linkRow = (id: string): Row => ({
	id,
	source_id: "task-1",
	target_id: "task-2",
	type: "blocks",
	note: null,
	created_at: T1,
});

const contextRefRow = (id: string, addedAt: string, label: string): Row => ({
	id,
	task_id: "task-1",
	uri: "obsidian://prd",
	kind: "PRD",
	label,
	note: null,
	added_by: "david",
	added_by_type: "human",
	added_at: addedAt,
});

const focusRow = (args: {
	id: string;
	items: Row[];
	updatedAt: string;
	theme?: string;
	createdAt?: string;
}): Row => ({
	id: args.id,
	period: "daily",
	items: JSON.stringify(args.items),
	theme: args.theme ?? null,
	reflection: null,
	created_at: args.createdAt ?? T1,
	updated_at: args.updatedAt,
});

const item = (taskId: string, over: Row = {}): Row => ({
	taskId,
	order: 0,
	completed: false,
	...over,
});

const ItemsSchema = z.array(z.record(z.unknown()));

/** Read the merged `items` blob back out of a decision. */
const mergedItems = (decision: ResolveDecision): Row[] => {
	if (decision.kind !== "merge") {
		throw new Error(`expected merge, got ${decision.kind}`);
	}
	const parsed = ItemsSchema.safeParse(JSON.parse(String(decision.row.items)));
	if (!parsed.success) throw new Error("merged items did not parse");
	return parsed.data;
};

const taskIdsOf = (items: Row[]): unknown[] => items.map((i) => i.taskId);

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
		op: makeOp({ tbl: "tasks", rowId: LOW, op: "insert" }),
		state: NO_LOCAL,
		expected: { kind: "skip", reason: "malformed-payload" },
	},

	// --- tasks / projects: row LWW ---
	{
		name: "tasks: absent locally, applied",
		op: makeOp({
			tbl: "tasks",
			rowId: LOW,
			op: "insert",
			rowUpdatedAt: T2,
			payload: taskRow(LOW, T2),
		}),
		state: NO_LOCAL,
		expected: {
			kind: "apply",
			rowId: LOW,
			row: taskRow(LOW, T2),
			dropRowId: undefined,
		},
	},
	{
		name: "tasks: strictly newer incoming wins",
		op: makeOp({
			tbl: "tasks",
			rowId: LOW,
			op: "update",
			rowUpdatedAt: T3,
			payload: taskRow(LOW, T3, { title: "Newer" }),
		}),
		state: local({ byId: taskRow(LOW, T2), byShortId: taskRow(LOW, T2) }),
		expected: {
			kind: "apply",
			rowId: LOW,
			row: taskRow(LOW, T3, { title: "Newer" }),
			dropRowId: undefined,
		},
	},
	{
		name: "tasks: older incoming loses",
		op: makeOp({
			tbl: "tasks",
			rowId: LOW,
			op: "update",
			rowUpdatedAt: T1,
			payload: taskRow(LOW, T1),
		}),
		state: local({ byId: taskRow(LOW, T2) }),
		expected: { kind: "skip", reason: "not-newer" },
	},
	{
		name: "projects: same LWW rule as tasks",
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

	// --- task_comments / task_work_log: insert-if-absent ---
	{
		name: "task_comments: absent locally with a live parent, applied",
		op: makeOp({
			tbl: "task_comments",
			rowId: LOW,
			op: "insert",
			payload: commentRow(LOW, "task-1"),
		}),
		state: local({ parentPresent: true }),
		expected: {
			kind: "apply",
			rowId: LOW,
			row: commentRow(LOW, "task-1"),
			dropRowId: undefined,
		},
	},
	{
		name: "task_comments: already present, append-only so nothing to do",
		op: makeOp({
			tbl: "task_comments",
			rowId: LOW,
			op: "insert",
			payload: commentRow(LOW, "task-1"),
		}),
		state: local({ byId: commentRow(LOW, "task-1"), parentPresent: true }),
		expected: { kind: "skip", reason: "already-present" },
	},
	{
		name: "task_work_log: absent locally with a live parent, applied",
		op: makeOp({
			tbl: "task_work_log",
			rowId: LOW,
			op: "insert",
			payload: { id: LOW, task_id: "task-1", refs: "[]", created_at: T1 },
		}),
		state: local({ parentPresent: true }),
		expected: {
			kind: "apply",
			rowId: LOW,
			row: { id: LOW, task_id: "task-1", refs: "[]", created_at: T1 },
			dropRowId: undefined,
		},
	},

	// --- FK orphans: a child created on one device after another deleted the
	// parent, whose delete is earlier in the log ---
	{
		name: "orphan: comment created after another device deleted the parent is skipped",
		op: makeOp({
			tbl: "task_comments",
			rowId: LOW,
			op: "insert",
			payload: commentRow(LOW, "task-1"),
		}),
		state: local({ parentPresent: false }),
		expected: { kind: "skip", reason: "orphan-parent" },
	},
	{
		name: "orphan: work log insert with an absent parent is skipped",
		op: makeOp({
			tbl: "task_work_log",
			rowId: LOW,
			op: "insert",
			payload: { id: LOW, task_id: "task-1", refs: "[]", created_at: T1 },
		}),
		state: local({ parentPresent: false }),
		expected: { kind: "skip", reason: "orphan-parent" },
	},
	{
		name: "orphan: link insert with an absent endpoint is skipped",
		op: makeOp({
			tbl: "task_links",
			rowId: LOW,
			op: "insert",
			payload: linkRow(LOW),
		}),
		state: local({ parentPresent: false }),
		expected: { kind: "skip", reason: "orphan-parent" },
	},
	{
		name: "orphan: context ref insert with an absent parent is skipped",
		op: makeOp({
			tbl: "task_context_refs",
			rowId: LOW,
			op: "insert",
			payload: contextRefRow(LOW, T2, "PRD"),
		}),
		state: local({ parentPresent: false }),
		expected: { kind: "skip", reason: "orphan-parent" },
	},
	{
		name: "orphan rule is scoped to child tables: a task never orphans",
		op: makeOp({
			tbl: "tasks",
			rowId: LOW,
			op: "insert",
			rowUpdatedAt: T2,
			payload: taskRow(LOW, T2),
		}),
		state: local({ parentPresent: false }),
		expected: {
			kind: "apply",
			rowId: LOW,
			row: taskRow(LOW, T2),
			dropRowId: undefined,
		},
	},

	// --- task_links: natural-key dedupe ---
	{
		name: "task_links: no local row, applied",
		op: makeOp({
			tbl: "task_links",
			rowId: LOW,
			op: "insert",
			payload: linkRow(LOW),
		}),
		state: local({ parentPresent: true }),
		expected: {
			kind: "apply",
			rowId: LOW,
			row: linkRow(LOW),
			dropRowId: undefined,
		},
	},
	{
		name: "task_links: natural key held by a lower local ULID, incoming dropped",
		op: makeOp({
			tbl: "task_links",
			rowId: HIGH,
			op: "insert",
			payload: linkRow(HIGH),
		}),
		state: local({ byNaturalKey: linkRow(LOW), parentPresent: true }),
		expected: { kind: "skip", reason: "duplicate-natural-key" },
	},
	{
		name: "task_links: incoming ULID is lower, local duplicate dropped",
		op: makeOp({
			tbl: "task_links",
			rowId: LOW,
			op: "insert",
			payload: linkRow(LOW),
		}),
		state: local({ byNaturalKey: linkRow(HIGH), parentPresent: true }),
		expected: {
			kind: "apply",
			rowId: LOW,
			row: linkRow(LOW),
			dropRowId: HIGH,
		},
	},

	// --- task_context_refs: natural-key upsert, LWW on added_at ---
	{
		name: "task_context_refs: no local row, applied",
		op: makeOp({
			tbl: "task_context_refs",
			rowId: LOW,
			op: "insert",
			payload: contextRefRow(LOW, T2, "remote"),
		}),
		state: local({ parentPresent: true }),
		expected: {
			kind: "apply",
			rowId: LOW,
			row: contextRefRow(LOW, T2, "remote"),
			dropRowId: undefined,
		},
	},
	{
		name: "task_context_refs: newer added_at re-promotes onto the surviving lower ULID",
		op: makeOp({
			tbl: "task_context_refs",
			rowId: HIGH,
			op: "insert",
			payload: contextRefRow(HIGH, T3, "remote"),
		}),
		state: local({
			byNaturalKey: contextRefRow(LOW, T2, "localAndOlder"),
			parentPresent: true,
		}),
		expected: {
			kind: "apply",
			rowId: LOW,
			row: { ...contextRefRow(HIGH, T3, "remote"), id: LOW },
			dropRowId: undefined,
		},
	},
	{
		name: "task_context_refs: added_at tie breaks on lower ULID, whose content wins",
		op: makeOp({
			tbl: "task_context_refs",
			rowId: LOW,
			op: "insert",
			payload: contextRefRow(LOW, T2, "remoteAndLower"),
		}),
		state: local({
			byNaturalKey: contextRefRow(HIGH, T2, "localAndHigher"),
			parentPresent: true,
		}),
		expected: {
			kind: "apply",
			rowId: LOW,
			row: contextRefRow(LOW, T2, "remoteAndLower"),
			dropRowId: HIGH,
		},
	},
	{
		name: "task_context_refs: older incoming on the same id loses",
		op: makeOp({
			tbl: "task_context_refs",
			rowId: LOW,
			op: "insert",
			payload: contextRefRow(LOW, T1, "remote"),
		}),
		state: local({
			byId: contextRefRow(LOW, T2, "local"),
			parentPresent: true,
		}),
		expected: { kind: "skip", reason: "not-newer" },
	},

	// --- deletes: tombstone-free, both orderings ---
	{
		name: "delete: no newer local update, applied",
		op: makeOp({ tbl: "tasks", rowId: LOW, op: "delete", capturedAt: T3 }),
		state: local({ byId: taskRow(LOW, T2) }),
		expected: { kind: "delete", rowId: LOW },
	},
	{
		name: "delete: loses to a strictly newer local update",
		op: makeOp({ tbl: "tasks", rowId: LOW, op: "delete", capturedAt: T2 }),
		state: local({ byId: taskRow(LOW, T3) }),
		expected: { kind: "skip", reason: "newer-local-update" },
	},
	{
		name: "delete: row already gone",
		op: makeOp({ tbl: "tasks", rowId: LOW, op: "delete", capturedAt: T3 }),
		state: NO_LOCAL,
		expected: { kind: "skip", reason: "already-absent" },
	},
	{
		name: "delete: clock-less table always applies",
		op: makeOp({
			tbl: "task_work_log",
			rowId: LOW,
			op: "delete",
			capturedAt: T1,
		}),
		state: local({ byId: { id: LOW, task_id: "task-1", created_at: T3 } }),
		expected: { kind: "delete", rowId: LOW },
	},
	{
		name: "delete first: a late update to a deleted row is dropped",
		op: makeOp({
			tbl: "tasks",
			rowId: LOW,
			op: "update",
			rowUpdatedAt: T1,
			payload: taskRow(LOW, T1),
		}),
		state: local({ deletedAt: T2 }),
		expected: { kind: "skip", reason: "deleted" },
	},
	{
		name: "delete first: an update strictly newer than the delete resurrects the row",
		op: makeOp({
			tbl: "tasks",
			rowId: LOW,
			op: "update",
			rowUpdatedAt: T3,
			payload: taskRow(LOW, T3),
		}),
		state: local({ deletedAt: T2 }),
		expected: {
			kind: "apply",
			rowId: LOW,
			row: taskRow(LOW, T3),
			dropRowId: undefined,
		},
	},
	{
		name: "delete first: an update at exactly the delete's capture time is dropped",
		op: makeOp({
			tbl: "tasks",
			rowId: LOW,
			op: "update",
			rowUpdatedAt: T2,
			payload: taskRow(LOW, T2),
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
			tbl: "tasks",
			rowId: LOW,
			op: "update",
			deviceId,
			rowUpdatedAt: T2,
			payload: taskRow(LOW, T2, { title }),
		});

	it("converges on the lower device_id from both directions", () => {
		// On device-aaa: bbb's op arrives, loses, aaa keeps its own row.
		const onA = Resolve.decide(
			edit(DEVICE_B, "from bbb"),
			local({
				byId: taskRow(LOW, T2, { title: "from aaa" }),
				localDeviceId: DEVICE_A,
			}),
		);
		// On device-bbb: aaa's op arrives, wins, bbb takes it.
		const onB = Resolve.decide(
			edit(DEVICE_A, "from aaa"),
			local({
				byId: taskRow(LOW, T2, { title: "from bbb" }),
				localDeviceId: DEVICE_B,
			}),
		);

		expect(onA).toEqual({ kind: "skip", reason: "not-newer" });
		expect(onB).toEqual({
			kind: "apply",
			rowId: LOW,
			row: taskRow(LOW, T2, { title: "from aaa" }),
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
				byId: taskRow(LOW, T2, { title: "one edit on aaa", version: 1 }),
				localDeviceId: DEVICE_A,
			}),
		);
		expect(decision.kind).toBe("skip"); // same version (undefined vs 1) falls through to device

		const versioned = Resolve.decide(
			makeOp({
				tbl: "tasks",
				rowId: LOW,
				op: "update",
				deviceId: DEVICE_B,
				rowUpdatedAt: T2,
				payload: taskRow(LOW, T2, {
					title: "three edits on bbb",
					version: 3,
					updated_by: "cabane://actor/human/zed",
				}),
			}),
			local({
				byId: taskRow(LOW, T2, {
					title: "one edit on aaa",
					version: 1,
					updated_by: "cabane://actor/human/amy",
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
				tbl: "tasks",
				rowId: LOW,
				op: "update",
				deviceId,
				rowUpdatedAt: T2,
				payload: taskRow(LOW, T2, { title, version: 2, updated_by: actor }),
			});
		const held = (actor: string, title: string): Row =>
			taskRow(LOW, T2, { title, version: 2, updated_by: actor });

		// Device order says bbb loses; actor order says bbb's author (amy) wins.
		// Actor is consulted first, so amy's content lands on both machines.
		const onA = Resolve.decide(
			authored(DEVICE_B, "cabane://actor/human/amy", "from amy"),
			local({
				byId: held("cabane://actor/human/zed", "from zed"),
				localDeviceId: DEVICE_A,
			}),
		);
		const onB = Resolve.decide(
			authored(DEVICE_A, "cabane://actor/human/zed", "from zed"),
			local({
				byId: held("cabane://actor/human/amy", "from amy"),
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
				byId: taskRow(LOW, T2, { title: "from aaa" }),
				localDeviceId: DEVICE_A,
			}),
		);

		expect(decision).toEqual({ kind: "skip", reason: "not-newer" });
	});

	it("never lets device order override a strictly newer clock", () => {
		// bbb sorts after aaa, so only the clock can be carrying this.
		const decision = Resolve.decide(
			makeOp({
				tbl: "tasks",
				rowId: LOW,
				op: "update",
				deviceId: DEVICE_B,
				rowUpdatedAt: T3,
				payload: taskRow(LOW, T3, { title: "from bbb" }),
			}),
			local({
				byId: taskRow(LOW, T2, { title: "from aaa" }),
				localDeviceId: DEVICE_A,
			}),
		);

		expect(decision).toEqual({
			kind: "apply",
			rowId: LOW,
			row: taskRow(LOW, T3, { title: "from bbb" }),
			dropRowId: undefined,
		});
	});

	it("converges a task_context_refs tie from both directions", () => {
		// Same ref row on both machines, same added_at, different labels — the
		// natural-key family reaches the same tie as row LWW once ids match.
		const promote = (deviceId: string, label: string): SyncOp =>
			makeOp({
				tbl: "task_context_refs",
				rowId: LOW,
				op: "insert",
				deviceId,
				payload: contextRefRow(LOW, T2, label),
			});

		const onA = Resolve.decide(
			promote(DEVICE_B, "from bbb"),
			local({
				byId: contextRefRow(LOW, T2, "from aaa"),
				parentPresent: true,
				localDeviceId: DEVICE_A,
			}),
		);
		const onB = Resolve.decide(
			promote(DEVICE_A, "from aaa"),
			local({
				byId: contextRefRow(LOW, T2, "from bbb"),
				parentPresent: true,
				localDeviceId: DEVICE_B,
			}),
		);

		expect(onA).toEqual({ kind: "skip", reason: "not-newer" });
		if (onB.kind !== "apply") throw new Error("expected an apply");
		expect(onB.row.label).toBe("from aaa");
	});

	it("converges a focus item tie on one shared row from both directions", () => {
		// One already-replicated daily row, so the two sides carry the same ULID
		// and only device order can separate the item edits.
		const edit = (deviceId: string, notes: string): SyncOp =>
			makeOp({
				tbl: "focus_lists",
				rowId: LOW,
				op: "update",
				deviceId,
				rowUpdatedAt: T2,
				payload: focusRow({
					id: LOW,
					items: [item("task-1", { notes })],
					updatedAt: T2,
				}),
			});
		const holding = (deviceId: string, notes: string): ResolveLocalState =>
			local({
				byId: focusRow({
					id: LOW,
					items: [item("task-1", { notes })],
					updatedAt: T2,
				}),
				localDeviceId: deviceId,
			});

		const onA = mergedItems(
			Resolve.decide(edit(DEVICE_B, "from bbb"), holding(DEVICE_A, "from aaa")),
		);
		const onB = mergedItems(
			Resolve.decide(edit(DEVICE_A, "from aaa"), holding(DEVICE_B, "from bbb")),
		);

		expect(onA).toHaveLength(1);
		expect(onA[0]?.notes).toBe("from aaa");
		expect(onB[0]?.notes).toBe("from aaa");
	});
});

// ============================================================
// short_id rename: winner is the ULID-earlier row
// ============================================================

describe("Resolve.decide — short_id collision", () => {
	const incoming = (rowId: string): SyncOp =>
		makeOp({
			tbl: "tasks",
			rowId,
			op: "insert",
			rowUpdatedAt: T2,
			payload: taskRow(rowId, T2),
		});

	it("reassigns the local row when the incoming ULID is earlier", () => {
		const decision = Resolve.decide(
			incoming(LOW),
			local({ byShortId: taskRow(HIGH, T2) }),
		);

		expect(decision).toEqual({
			kind: "rename",
			rowId: LOW,
			row: taskRow(LOW, T2),
			loserId: HIGH,
			shortId: "JJAK-5",
		});
	});

	it("reassigns the incoming row when the local ULID is earlier", () => {
		const decision = Resolve.decide(
			incoming(HIGH),
			local({ byShortId: taskRow(LOW, T2) }),
		);

		expect(decision).toEqual({
			kind: "rename",
			rowId: HIGH,
			row: taskRow(HIGH, T2),
			loserId: HIGH,
			shortId: "JJAK-5",
		});
	});

	it("does not rename when the label is held by the same row", () => {
		const decision = Resolve.decide(
			incoming(LOW),
			local({ byId: taskRow(LOW, T1), byShortId: taskRow(LOW, T1) }),
		);

		expect(decision).toEqual({
			kind: "apply",
			rowId: LOW,
			row: taskRow(LOW, T2),
			dropRowId: undefined,
		});
	});

	it("does not rename when the incoming row lost LWW anyway", () => {
		const decision = Resolve.decide(
			makeOp({
				tbl: "tasks",
				rowId: HIGH,
				op: "update",
				rowUpdatedAt: T1,
				payload: taskRow(HIGH, T1),
			}),
			local({ byId: taskRow(HIGH, T3), byShortId: taskRow(LOW, T2) }),
		);

		expect(decision).toEqual({ kind: "skip", reason: "not-newer" });
	});
});

// ============================================================
// focus_lists: the sharp edge
// ============================================================

describe("Resolve.decide — focus_lists", () => {
	it("keeps both devices' items when each created its own daily row", () => {
		// Device A holds the HIGH-ULID row, device B ships the LOW-ULID one.
		const decision = Resolve.decide(
			makeOp({
				tbl: "focus_lists",
				rowId: LOW,
				op: "insert",
				rowUpdatedAt: T3,
				payload: focusRow({
					id: LOW,
					items: [item("task-remote")],
					updatedAt: T3,
					theme: "remote theme",
				}),
			}),
			local({
				byNaturalKey: focusRow({
					id: HIGH,
					items: [item("task-local", { order: 1 })],
					updatedAt: T2,
					theme: "local theme",
				}),
			}),
		);

		if (decision.kind !== "merge") throw new Error("expected a merge");
		// Lowest ULID owns the row; the other row has to go or UNIQUE(period) blocks.
		expect(decision.rowId).toBe(LOW);
		expect(decision.dropRowId).toBe(HIGH);
		expect(taskIdsOf(mergedItems(decision))).toEqual([
			"task-remote",
			"task-local",
		]);
		expect(decision.row.theme).toBe("remote theme");
		expect(decision.row.updated_at).toBe(T3);
	});

	it("keeps both devices' items in the mirror direction, same surviving row", () => {
		const decision = Resolve.decide(
			makeOp({
				tbl: "focus_lists",
				rowId: HIGH,
				op: "insert",
				rowUpdatedAt: T2,
				payload: focusRow({
					id: HIGH,
					items: [item("task-local", { order: 1 })],
					updatedAt: T2,
					theme: "local theme",
				}),
			}),
			local({
				byNaturalKey: focusRow({
					id: LOW,
					items: [item("task-remote")],
					updatedAt: T3,
					theme: "remote theme",
				}),
			}),
		);

		if (decision.kind !== "merge") throw new Error("expected a merge");
		expect(decision.rowId).toBe(LOW);
		// The surviving row is already the local one, so nothing is dropped.
		expect(decision.dropRowId).toBeUndefined();
		expect(taskIdsOf(mergedItems(decision))).toEqual([
			"task-remote",
			"task-local",
		]);
		// theme/reflection follow row LWW, which the local T3 row wins.
		expect(decision.row.theme).toBe("remote theme");
		expect(decision.row.updated_at).toBe(T3);
	});

	it("merges the same item key by its own clock, not by row clock", () => {
		const decision = Resolve.decide(
			makeOp({
				tbl: "focus_lists",
				rowId: LOW,
				op: "update",
				rowUpdatedAt: T1,
				payload: focusRow({
					id: LOW,
					items: [item("task-1", { completed: true, completedAt: T3 })],
					updatedAt: T1,
				}),
			}),
			local({
				byId: focusRow({ id: LOW, items: [item("task-1")], updatedAt: T2 }),
			}),
		);

		const items = mergedItems(decision);
		expect(items).toHaveLength(1);
		expect(items[0]?.completed).toBe(true);
		expect(items[0]?.completedAt).toBe(T3);
	});

	it("keeps the item whose clock is newer when both sides touched it", () => {
		const decision = Resolve.decide(
			makeOp({
				tbl: "focus_lists",
				rowId: LOW,
				op: "update",
				rowUpdatedAt: T1,
				payload: focusRow({
					id: LOW,
					items: [item("task-1", { notes: "older" })],
					updatedAt: T1,
				}),
			}),
			local({
				byId: focusRow({
					id: LOW,
					items: [item("task-1", { notes: "newer" })],
					updatedAt: T2,
				}),
			}),
		);

		const items = mergedItems(decision);
		expect(items).toHaveLength(1);
		expect(items[0]?.notes).toBe("newer");
	});

	it("breaks an item tie on the owning row's ULID", () => {
		const decision = Resolve.decide(
			makeOp({
				tbl: "focus_lists",
				rowId: LOW,
				op: "insert",
				rowUpdatedAt: T2,
				payload: focusRow({
					id: LOW,
					items: [item("task-1", { notes: "lower ulid" })],
					updatedAt: T2,
				}),
			}),
			local({
				byNaturalKey: focusRow({
					id: HIGH,
					items: [item("task-1", { notes: "higher ulid" })],
					updatedAt: T2,
				}),
			}),
		);

		const items = mergedItems(decision);
		expect(items).toHaveLength(1);
		expect(items[0]?.notes).toBe("lower ulid");
	});

	it("preserves the earlier created_at across the merged identity", () => {
		const decision = Resolve.decide(
			makeOp({
				tbl: "focus_lists",
				rowId: HIGH,
				op: "insert",
				rowUpdatedAt: T3,
				payload: focusRow({
					id: HIGH,
					items: [],
					updatedAt: T3,
					createdAt: T2,
				}),
			}),
			local({
				byNaturalKey: focusRow({
					id: LOW,
					items: [],
					updatedAt: T1,
					createdAt: T1,
				}),
			}),
		);

		if (decision.kind !== "merge") throw new Error("expected a merge");
		expect(decision.row.created_at).toBe(T1);
		expect(decision.row.updated_at).toBe(T3);
	});

	it("applies as-is when no local focus row exists", () => {
		const row = focusRow({ id: LOW, items: [item("task-1")], updatedAt: T2 });
		const decision = Resolve.decide(
			makeOp({
				tbl: "focus_lists",
				rowId: LOW,
				op: "insert",
				rowUpdatedAt: T2,
				payload: row,
			}),
			NO_LOCAL,
		);

		expect(decision).toEqual({
			kind: "apply",
			rowId: LOW,
			row,
			dropRowId: undefined,
		});
	});

	it("skips an unparseable items blob instead of dropping the local row", () => {
		const decision = Resolve.decide(
			makeOp({
				tbl: "focus_lists",
				rowId: LOW,
				op: "update",
				rowUpdatedAt: T3,
				payload: {
					...focusRow({ id: LOW, items: [], updatedAt: T3 }),
					items: "{",
				},
			}),
			local({
				byId: focusRow({ id: LOW, items: [item("task-1")], updatedAt: T2 }),
			}),
		);

		expect(decision).toEqual({ kind: "skip", reason: "malformed-payload" });
	});
});
