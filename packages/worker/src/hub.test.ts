/**
 * The cloud device's storage, exercised three ways: the Db port conformance
 * suite over `ctx.storage.sql`, the core schema booted by the constructor, and
 * the same add/link/search/session/brief path `packages/sqlite/smoke.test.ts`
 * runs over bun:sqlite.
 *
 * The core's own storage and sync test files (21 of them) cannot run here:
 * every one imports `bun:test`, and 18 open scratch databases through
 * `bun:sqlite` and `node:fs` temp dirs. This smoke covers the same storage
 * entry points against DO SQLite instead of porting them.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { conformanceCases, Deadline, Planner } from "@cabane/core";
import { describe, expect, it } from "vitest";
import { DoDb } from "./db-do";
import { type CabaneHub, HUB_BASE, hubTimezone } from "./hub";

const unwrap = <T>(
	result: { ok: true; value: T } | { ok: false; error: Error },
): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const hub = (name: string) => env.CABANE_HUB.getByName(name);

describe("CabaneHub boot", () => {
	it("applies the core schema with plain names", async () => {
		const h = hub("boot");
		expect(unwrap(await h.boot())).toBeUndefined();
		const tables = await h.tables();
		expect(tables).toContain("tasks");
		expect(tables).toContain("tasks_fts");
		expect(tables).toContain("agent_sessions");
		expect(tables).toContain("sync_oplog");
		expect(tables.some((t) => t.startsWith("planner_"))).toBe(false);
		expect(await h.taskCount()).toBe(0);
	});
});

describe("the hub's timezone", () => {
	it("is CABANE_TIMEZONE when set, UTC when unset, and an error when unknown", () => {
		expect(hubTimezone(undefined)).toEqual({ ok: true, value: "UTC" });
		expect(hubTimezone(" ")).toEqual({ ok: true, value: "UTC" });
		expect(hubTimezone("America/Montreal")).toEqual({
			ok: true,
			value: "America/Montreal",
		});
		const unknown = hubTimezone("Mars/Olympus");
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.error.message).toContain("CABANE_TIMEZONE");
	});

	it("workerd's zone data places a Montreal day and its DST jump as Bun does", () => {
		const start = Deadline.startOfDay("2026-03-08", "America/Montreal");
		const end = Deadline.endOfDay("2026-03-08", "America/Montreal");
		expect(new Date(start).toISOString()).toBe("2026-03-08T05:00:00.000Z");
		expect(new Date(end).toISOString()).toBe("2026-03-09T03:59:59.999Z");
	});
});

describe("Db port conformance over Durable Object SQLite", () => {
	for (const c of conformanceCases()) {
		it(c.name, async () => {
			await runInDurableObject(hub("conformance"), async (_i: CabaneHub, ctx) =>
				c.run(DoDb.provider(ctx.storage)),
			);
		});
	}
});

describe("storage over Durable Object SQLite", () => {
	it("adds, links, searches, sessions, and assembles a brief", async () => {
		const h = hub("smoke");
		unwrap(await h.boot());

		await runInDurableObject(h, async () => {
			const parent = unwrap(
				await Planner.addTask(HUB_BASE, {
					title: "Extract the planner into Cabane",
					description: "Db port over bun:sqlite and Durable Object SQLite",
					kind: "issue",
					scopeUri: "cabane",
				}),
			);
			const child = unwrap(
				await Planner.addTask(HUB_BASE, {
					title: "Write the Durable Object adapter",
					kind: "issue",
					scopeUri: "cabane",
					parentTaskId: parent.id,
				}),
			);
			expect(parent.shortId).toMatch(/^JCAB-\d+$/);

			unwrap(
				await Planner.addLink(HUB_BASE, {
					sourceId: child.id,
					targetId: parent.id,
					type: "blocks",
				}),
			);
			const links = unwrap(await Planner.getLinksForTask(HUB_BASE, parent.id));
			expect(links.map((l) => l.type)).toContain("blocks");

			const found = unwrap(await Planner.searchTasks(HUB_BASE, "Durable"));
			expect(found.map((t) => t.id)).toContain(parent.id);

			const session = unwrap(
				await Planner.startSession(HUB_BASE, {
					taskId: child.id,
					agent: "claude",
				}),
			);
			unwrap(
				await Planner.addActivity(HUB_BASE, {
					sessionId: session.id,
					type: "finding",
					severity: "P2",
					body: "the adapter is a pass-through",
				}),
			);
			const ended = unwrap(
				await Planner.endSession(HUB_BASE, session.id, {
					state: "complete",
					summary: "done",
				}),
			);
			expect(ended.state).toBe("complete");

			unwrap(
				await Planner.addComment(HUB_BASE, {
					taskId: child.id,
					author: "david",
					authorType: "human",
					content: "keep the public names",
				}),
			);

			const brief = unwrap(await Planner.assembleContext(HUB_BASE, child.id));
			expect(brief).toContain("Write the Durable Object adapter");
			expect(brief).toContain("keep the public names");
		});

		expect(await h.taskCount()).toBe(2);
	});

	it("re-init is idempotent and stats read back", async () => {
		const h = hub("smoke");
		unwrap(await h.boot());
		await runInDurableObject(h, async () => {
			unwrap(await Planner.init(HUB_BASE));
			expect(unwrap(await Planner.stats(HUB_BASE))).toBeDefined();
		});
	});
});
