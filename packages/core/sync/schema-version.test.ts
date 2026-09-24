/**
 * Planner Sync — the schema version on the wire.
 *
 * A device on an older schema must stop at the first op a newer kabane pushed,
 * rather than store part of it (apply writes only the columns it knows) or skip
 * a table it has never heard of while its watermark moves past for good. Two
 * devices share one in-process relay; the "newer" op is appended to the relay
 * by hand, since this build cannot push one.
 */

import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withDb } from "../runtime";
import { TABLES } from "../storage/helpers";
import { Planner } from "../storage/index";
import { Migrations } from "../storage/migrations";
import { Oplog } from "../storage/oplog";
import { LocalRelay, type Relay } from "./local-relay";
import { Sync } from "./namespace";
import type { SyncTransport } from "./transport";

type Device = { base: string; transport: SyncTransport };

let relay: Relay;
let bases: string[];

const createDevice = async (deviceId: string): Promise<Device> => {
	const base = join(
		tmpdir(),
		`cabane-schema-${deviceId}-${crypto.randomUUID()}`,
	);
	mkdirSync(base, { recursive: true });
	bases.push(base);
	const init = await Planner.init(base);
	if (!init.ok) throw init.error;
	const armed = await withDb(base, (db) => Oplog.initDevice(db, deviceId));
	if (!armed.ok || !armed.value.ok) throw new Error("arm failed");
	return { base, transport: LocalRelay.transportFor(relay, deviceId) };
};

const addTask = async (device: Device, title: string): Promise<void> => {
	const added = await Planner.addTask(device.base, { title });
	if (!added.ok) throw added.error;
};

const push = async (device: Device): Promise<void> => {
	const pushed = await Sync.push(device.base, device.transport);
	if (!pushed.ok) throw pushed.error;
};

const titles = async (device: Device): Promise<string[]> => {
	const rows = await withDb(device.base, (db) =>
		db
			.query<{ title: string }, []>(
				`SELECT title FROM ${TABLES.tasks} ORDER BY title`,
			)
			.all()
			.map((r) => r.title),
	);
	if (!rows.ok) throw rows.error;
	return rows.value;
};

const watermark = async (device: Device): Promise<number> => {
	const state = await withDb(device.base, Oplog.getState);
	if (!state.ok || !state.value.ok || state.value.value === undefined)
		throw new Error("no sync state");
	return state.value.value.lastAppliedSeq;
};

/** A task insert from a device on schema `schema`, appended straight to the relay. */
const appendFromSchema = (schema: number | undefined, title: string): void => {
	const now = new Date().toISOString();
	const rowId = `01FUTURE${crypto.randomUUID().replaceAll("-", "").slice(0, 18).toUpperCase()}`;
	relay.log.push({
		opId: crypto.randomUUID(),
		deviceId: "future-device",
		tbl: "tasks",
		rowId,
		op: "insert",
		rowUpdatedAt: now,
		payload: {
			id: rowId,
			title,
			kind: "task",
			state: "inbox",
			priority: "normal",
			source: "human",
			discovered_at: now,
			version: 1,
			visibility: "shared",
			created_at: now,
			updated_at: now,
			a_column_from_the_future: "kept by the newer device only",
		},
		version: 1,
		capturedAt: now,
		...(schema === undefined ? {} : { schema }),
		serverSeq: relay.log.length + 1,
	});
};

beforeEach(() => {
	relay = LocalRelay.create();
	bases = [];
});

afterEach(() => {
	for (const base of bases) rmSync(base, { recursive: true, force: true });
});

describe("the schema version on the wire", () => {
	it("every pushed op carries this build's schema version", async () => {
		const alpha = await createDevice("alpha");
		await addTask(alpha, "one");
		await addTask(alpha, "two");
		await push(alpha);
		const stamped = LocalRelay.ops(relay).map((op) => op.schema);
		expect(stamped.length).toBeGreaterThan(0);
		expect(new Set(stamped)).toEqual(new Set([Migrations.SCHEMA_VERSION]));
	});

	it("a pull stops at the first op from a newer schema, applies what came before, and skips nothing", async () => {
		const alpha = await createDevice("alpha");
		const beta = await createDevice("beta");

		await addTask(alpha, "before");
		await push(alpha);
		const beforeSeq = LocalRelay.head(relay);
		appendFromSchema(Migrations.SCHEMA_VERSION + 1, "from the future");
		await addTask(alpha, "after");
		await push(alpha);

		const pulled = await Sync.pull(beta.base, beta.transport);
		expect(pulled.ok).toBe(false);
		expect(pulled.ok ? "" : pulled.error.message).toContain(
			"Update kabane on this device",
		);
		expect(await titles(beta)).toEqual(["before"]);
		expect(await watermark(beta)).toBe(beforeSeq);

		// Still stuck on the same op, not past it: the change waits for the update.
		const again = await Sync.pull(beta.base, beta.transport);
		expect(again.ok).toBe(false);
		expect(await watermark(beta)).toBe(beforeSeq);
		expect(await titles(beta)).toEqual(["before"]);
	});

	it("a newer op at the very start of the unread log applies nothing and moves nothing", async () => {
		const beta = await createDevice("beta");
		appendFromSchema(Migrations.SCHEMA_VERSION + 1, "from the future");

		const pulled = await Sync.pull(beta.base, beta.transport);
		expect(pulled.ok).toBe(false);
		expect(await titles(beta)).toEqual([]);
		expect(await watermark(beta)).toBe(0);
	});

	it("ops with no schema field, pushed before it existed, read as the baseline and apply", async () => {
		const beta = await createDevice("beta");
		appendFromSchema(undefined, "from an older build");

		const pulled = await Sync.pull(beta.base, beta.transport);
		expect(pulled.ok).toBe(true);
		expect(await titles(beta)).toEqual(["from an older build"]);
	});
});
