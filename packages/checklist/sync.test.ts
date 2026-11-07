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
} from "@cabane/core";
import { configureTestRuntime } from "@cabane/core/testing";
import { SqliteDb } from "@cabane/sqlite";
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
			actor: () => `cabane://actor/human/${actor}`,
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
		doneBy: "cabane://actor/human/alpha",
		version: 2,
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
