/**
 * A plan file applied under a key (ADR 0006): each thread's id is
 * `<plan key>/<thread key>`, so applying it again writes nothing, and a keyed
 * add retried lands on the same thread.
 */

import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "../result";
import { Runtime, withDb } from "../runtime";
import type { Plan } from "../schemas";
import { configureTestRuntime } from "../testing";
import { Planner } from "./index";
import { Oplog } from "./oplog";

let base: string;
const must = <T>(r: Result<T>): T => {
	if (!r.ok) throw r.error;
	return r.value;
};

beforeEach(async () => {
	configureTestRuntime();
	base = mkdtempSync(join(tmpdir(), "kabane-plans-"));
	must(await Planner.init(base));
	must(must(await withDb(base, (db) => Oplog.initDevice(db, "device-a"))));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const counts = async () =>
	must(
		await withDb(base, (db) =>
			["threads", "entries", "attributes", "refs", "sync_oplog"].map(
				(table) =>
					db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM ${table}`).get()
						?.n,
			),
		),
	);

const apply = (plan: Plan, key = "tracer") =>
	Planner.applyPlan(base, plan, {
		key,
		scopeUri: "kabane://scope/plans",
		author: "kabane://actor/agent/claude",
		source: "ai",
	});

it("files a plan once: a second apply creates nothing and says so", async () => {
	const outside = must(
		await Planner.addTask(base, { title: "Existing", scopeUri: "plans" }),
	);
	const plan: Plan = {
		threads: [
			{ key: "decide", title: "Decide the store", state: "next" },
			{ key: "build", title: "Build it", parent: "decide" },
			{ key: "review", title: "Review it" },
		],
		links: [
			{ from: "decide", to: "build", type: "blocks" },
			{ from: outside.shortId ?? outside.id, to: "review", type: "related" },
		],
	};
	const first = must(await apply(plan));
	expect(first.threads.map((t) => [t.id, t.created])).toEqual([
		["tracer/decide", true],
		["tracer/build", true],
		["tracer/review", true],
	]);
	expect(first.links).toEqual({ created: 2, existing: 0 });
	const before = await counts();

	const second = must(await apply(plan));
	expect(second.threads.every((t) => !t.created)).toBe(true);
	expect(second.links).toEqual({ created: 0, existing: 2 });
	expect(await counts()).toEqual(before);

	const build = must(await Planner.getTask(base, "tracer/build"));
	expect(build).toMatchObject({ kind: "issue", parentTaskId: "tracer/decide" });
	expect(must(await Planner.resolveTaskId(base, "tracer/build"))).toBe(
		"tracer/build",
	);
	expect(must(await Planner.isReady(base, "tracer/build"))).toBe(false);
	must(await Planner.updateTask(base, "tracer/decide", { state: "done" }));
	expect(must(await Planner.isReady(base, "tracer/build"))).toBe(true);
});

it("writes none of a plan whose link names nothing", async () => {
	const before = await counts();
	const failed = await apply({
		threads: [{ key: "a", title: "A" }],
		links: [{ from: "a", to: "JNOP-9", type: "blocks" }],
	});
	expect(failed.ok).toBe(false);
	expect(await counts()).toEqual(before);
});

it("a keyed add retried returns the first task, marked existed", async () => {
	const draft = { title: "Once", scopeUri: "plans" };
	const first = must(await Planner.addTask(base, draft, { key: "solo/once" }));
	const before = await counts();
	const again = must(await Planner.addTask(base, draft, { key: "solo/once" }));
	expect(again).toMatchObject({ id: "solo/once", existed: true });
	expect(again.shortId).toBe(first.shortId);
	expect(await counts()).toEqual(before);
	expect((await Planner.addTask(base, draft, { key: "JCAB-12" })).ok).toBe(
		false,
	);
});

it("a thread filed in progress with an assignee is claimed by its writer", async () => {
	must(
		await apply({
			threads: [
				{
					key: "live",
					title: "Live",
					state: "in_progress",
					assignee: "claude",
				},
				{ key: "open", title: "Open", state: "in_progress" },
			],
		}),
	);
	expect(must(await Planner.claimHolder(base, "tracer/live"))).toBe(
		Runtime.actor(),
	);
	expect(must(await Planner.claimHolder(base, "tracer/open"))).toBeNull();
});
