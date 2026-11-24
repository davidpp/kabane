import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LocalRelay,
	Oplog,
	Planner,
	type Result,
	Runtime,
	Sync,
	withDb,
} from "@kabane/core";
import { configureTestRuntime } from "@kabane/core/testing";
import { SqliteDb } from "@kabane/sqlite";
import { checklistModule } from "./module";
import { Checklist } from "./storage";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
const bases: string[] = [];
afterEach(() => {
	configureTestRuntime();
	for (const base of bases.splice(0))
		rmSync(base, { recursive: true, force: true });
});
const register = (enabled: boolean, actor: string) =>
	unwrap(
		Runtime.configure({
			provider: SqliteDb.provider(),
			modules: enabled ? [checklistModule] : [],
			actor: () => `kabane://actor/human/${actor}`,
		}),
	);
const device = async (name: string, enabled: boolean) => {
	const base = mkdtempSync(join(tmpdir(), `checklist-${name}-`));
	bases.push(base);
	register(enabled, name);
	unwrap(await Planner.init(base));
	unwrap(unwrap(await withDb(base, (db) => Oplog.initDevice(db, name))));
	return base;
};
const texts = async (base: string, id: string) =>
	unwrap(await Checklist.list(base, id)).map((item) => item.text);

it("parks item ops on a device without the module and replays them on registration", async () => {
	const relay = LocalRelay.create();
	const alpha = await device("alpha", true);
	const a = LocalRelay.transportFor(relay, "alpha");
	const task = unwrap(
		await Planner.addTask(alpha, { title: "Park steps", kind: "issue" }),
	);
	const [item] = unwrap(
		await Checklist.add(alpha, { id: task.id, items: ["One"] }),
	).items;
	unwrap(await Checklist.tick(alpha, { items: [item?.id ?? ""] }));
	unwrap(await Sync.push(alpha, a));
	const beta = await device("beta", false);
	const b = LocalRelay.transportFor(relay, "beta");
	expect(unwrap(await Sync.pull(beta, b)).parked).toBe(2);
	expect(unwrap(await Sync.status(beta)).parkedOps).toEqual({ checklist: 2 });
	register(true, "beta");
	unwrap(await Planner.init(beta));
	expect(unwrap(await Sync.pull(beta, b)).replayed).toBe(2);
	expect(unwrap(await Checklist.list(beta, task.id))[0]).toMatchObject({
		done: true,
		doneBy: "kabane://actor/human/alpha",
		version: 2,
	});
});

/** A device on the build before the rename: it writes cabane://actor/. */
const legacyWriter = () =>
	unwrap(
		Runtime.configure({
			provider: SqliteDb.provider(),
			modules: [checklistModule],
			actor: () => "cabane://actor/human/alpha",
		}),
	);
const LEGACY = "cabane://actor/human/alpha";
const RENAMED = "kabane://actor/human/alpha";

for (const registered of [true, false])
	it(`renames the item ops pending at the cutover, with the module ${registered ? "registered" : "not registered"} then`, async () => {
		const alpha = await device("alpha", true);
		legacyWriter();
		const task = unwrap(
			await Planner.addTask(alpha, { title: "Pending", kind: "issue" }),
		);
		const [item] = unwrap(
			await Checklist.add(alpha, { id: task.id, items: ["One"] }),
		).items;
		unwrap(await Checklist.tick(alpha, { items: [item?.id ?? ""] }));
		// Back to schema 11, as the build before the rename left it, then the upgrade's boot.
		unwrap(
			await withDb(alpha, (db) => {
				db.run("DELETE FROM schema_migrations WHERE version >= 12");
				db.run("DELETE FROM schema_migrations_checklist WHERE version = 2");
			}),
		);
		register(registered, "alpha");
		unwrap(await Planner.init(alpha));
		const pending = unwrap(
			unwrap(await withDb(alpha, (db) => Oplog.drain(db, 100))),
		).filter((op) => op.tbl === "task_checklist_items");
		expect(
			pending.map((op) => [op.payload?.done_by ?? null, op.updatedBy]),
		).toEqual([
			[null, RENAMED],
			[RENAMED, RENAMED],
		]);
	});

it("leaves an item op pulled after the cutover as written, whichever order the module registers in", async () => {
	const relay = LocalRelay.create();
	const alpha = await device("alpha", true);
	const a = LocalRelay.transportFor(relay, "alpha");
	// A peer still on the build before the rename.
	legacyWriter();
	const task = unwrap(
		await Planner.addTask(alpha, { title: "Old peer", kind: "issue" }),
	);
	const [item] = unwrap(
		await Checklist.add(alpha, { id: task.id, items: ["One"] }),
	).items;
	unwrap(await Checklist.tick(alpha, { items: [item?.id ?? ""] }));
	unwrap(await Sync.push(alpha, a));

	// Registered after the pull: the op parks, then replays as it came.
	const beta = await device("beta", false);
	const b = LocalRelay.transportFor(relay, "beta");
	expect(unwrap(await Sync.pull(beta, b)).parked).toBe(2);
	register(true, "beta");
	unwrap(await Planner.init(beta));
	const parked = unwrap(
		await withDb(beta, (db) =>
			db
				.query<{ op: string }, []>("SELECT op FROM sync_parked ORDER BY op_id")
				.all()
				.map((row) => row.op),
		),
	);
	expect(parked.join("\n")).toContain(LEGACY);
	expect(unwrap(await Sync.pull(beta, b)).replayed).toBe(2);
	expect(unwrap(await Checklist.list(beta, task.id))[0]).toMatchObject({
		done: true,
		doneBy: LEGACY,
	});

	// Registered before the pull: the op applies as it came.
	const gamma = await device("gamma", true);
	unwrap(await Sync.pull(gamma, LocalRelay.transportFor(relay, "gamma")));
	expect(unwrap(await Checklist.list(gamma, task.id))[0]).toMatchObject({
		done: true,
		doneBy: LEGACY,
	});
});

it("converges concurrent appends to one order, and an insert between the tied pair lands there", async () => {
	const relay = LocalRelay.create();
	const alpha = await device("alpha", true);
	const a = LocalRelay.transportFor(relay, "alpha");
	const task = unwrap(
		await Planner.addTask(alpha, { title: "Concurrent steps", kind: "issue" }),
	);
	unwrap(await Checklist.add(alpha, { id: task.id, items: ["Base"] }));
	unwrap(await Sync.push(alpha, a));
	const beta = await device("beta", true);
	const b = LocalRelay.transportFor(relay, "beta");
	unwrap(await Sync.pull(beta, b));

	unwrap(await Checklist.add(beta, { id: task.id, items: ["From beta"] }));
	register(true, "alpha");
	unwrap(await Checklist.add(alpha, { id: task.id, items: ["From alpha"] }));
	unwrap(await Sync.push(alpha, a));
	register(true, "beta");
	unwrap(await Sync.push(beta, b));
	unwrap(await Sync.pull(beta, b));
	register(true, "alpha");
	unwrap(await Sync.pull(alpha, a));

	// Both appends took the same rank; the id breaks the tie, beta's first.
	const order = ["Base", "From beta", "From alpha"];
	expect(await texts(alpha, task.id)).toEqual(order);
	register(true, "beta");
	expect(await texts(beta, task.id)).toEqual(order);

	unwrap(
		await Checklist.add(beta, { id: task.id, items: ["Between"], position: 3 }),
	);
	unwrap(await Sync.push(beta, b));
	register(true, "alpha");
	unwrap(await Sync.pull(alpha, a));
	const final = ["Base", "From beta", "Between", "From alpha"];
	expect(await texts(alpha, task.id)).toEqual(final);
	register(true, "beta");
	expect(await texts(beta, task.id)).toEqual(final);
});
