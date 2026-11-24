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
import {
	conformanceCases,
	Deadline,
	Migrate,
	Migrations,
	Planner,
} from "@kabane/core";
import type { Db } from "@kabane/core";
import { questionsModule } from "@kabane/questions";
import { describe, expect, it } from "vitest";
import { DoDb } from "./db-do";
import { type KabaneHub, HUB_BASE, hubTimezone } from "./hub";

const unwrap = <T>(
	result: { ok: true; value: T } | { ok: false; error: Error },
): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const hub = (name: string) => env.KABANE_HUB.getByName(name);

describe("KabaneHub boot", () => {
	it("applies the core schema", async () => {
		const h = hub("boot");
		expect(unwrap(await h.boot())).toBeUndefined();
		const tables = await h.tables();
		// The task row is a view over the record since migration 14.
		expect(tables).toContain("threads");
		expect(tables).toContain("tasks_fts");
		// Core keeps no agent session: migration session-outcomes drops both.
		expect(tables).not.toContain("agent_sessions");
		expect(tables).not.toContain("agent_activities");
		expect(tables).toContain("sync_oplog");
		// The module pass's bookkeeping, created outside the numbered migrations.
		expect(tables).toContain("module_declarations");
		expect(await h.taskCount()).toBe(0);
	});
});

describe("a migration's after step over Durable Object SQLite", () => {
	it("rolls the migration back with it when it throws", async () => {
		await runInDurableObject(hub("after"), async (_i: KabaneHub, ctx) => {
			const ran = unwrap(
				await DoDb.provider(ctx.storage).withDb(HUB_BASE, (db) => {
					const result = Migrate.run(
						db,
						[
							{
								name: "create-probe",
								up: (tx) => tx.run("CREATE TABLE after_probe (id TEXT)"),
							},
						],
						"schema_migrations_probe",
						() => {
							throw new Error("the after step failed");
						},
					);
					const tables = db
						.query<{ name: string }, []>(
							"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('after_probe', 'schema_migrations_probe')",
						)
						.all()
						.map((row) => row.name);
					const versions = db
						.query<{ n: number }, []>(
							"SELECT COUNT(*) AS n FROM schema_migrations_probe",
						)
						.get()?.n;
					return { result, tables, versions };
				}),
			);
			expect(ran.result.ok).toBe(false);
			if (!ran.result.ok)
				expect(ran.result.error.message).toContain("the after step failed");
			expect(ran.tables).toEqual(["schema_migrations_probe"]);
			expect(ran.versions).toBe(0);
		});
	});
});

describe("the hub's timezone", () => {
	it("is KABANE_TIMEZONE when set, UTC when unset, and an error when unknown", () => {
		expect(hubTimezone(undefined)).toEqual({ ok: true, value: "UTC" });
		expect(hubTimezone(" ")).toEqual({ ok: true, value: "UTC" });
		expect(hubTimezone("America/Montreal")).toEqual({
			ok: true,
			value: "America/Montreal",
		});
		const unknown = hubTimezone("Mars/Olympus");
		expect(unknown.ok).toBe(false);
		if (!unknown.ok) expect(unknown.error.message).toContain("KABANE_TIMEZONE");
	});

	it("workerd's zone data places a Montreal day and its DST jump as Bun does", () => {
		const start = Deadline.startOfDay("2026-03-08", "America/Montreal");
		const end = Deadline.endOfDay("2026-03-08", "America/Montreal");
		expect(new Date(start).toISOString()).toBe("2026-03-08T05:00:00.000Z");
		expect(new Date(end).toISOString()).toBe("2026-03-09T03:59:59.999Z");
	});
});

/**
 * Empty the object's database. The constructor boots every object to the
 * latest schema, where `tasks` is a view migration 1's DDL cannot index.
 */
const wipe = (db: Db): void => {
	const objects = db
		.query<{ type: string; name: string }, []>(
			"SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND sql NOT LIKE 'CREATE VIRTUAL%'",
		)
		.all();
	for (const fts of ["tasks_fts", "task_comments_fts"])
		db.run(`DROP TABLE IF EXISTS ${fts}`);
	for (const { type, name } of objects)
		db.run(`DROP ${type === "view" ? "VIEW" : "TABLE"} IF EXISTS "${name}"`);
};

describe("Db port conformance over Durable Object SQLite", () => {
	for (const c of conformanceCases()) {
		it(c.name, async () => {
			await runInDurableObject(
				hub(`conformance-${c.name}`),
				async (_i: KabaneHub, ctx) => {
					const provider = DoDb.provider(ctx.storage);
					unwrap(await provider.withDb(HUB_BASE, wipe));
					return c.run(provider);
				},
			);
		});
	}
});

describe("storage over Durable Object SQLite", () => {
	it("adds, links, searches, records an outcome and a session ref, and assembles a brief", async () => {
		const h = hub("smoke");
		unwrap(await h.boot());

		await runInDurableObject(h, async () => {
			const parent = unwrap(
				await Planner.addTask(HUB_BASE, {
					title: "Extract the planner into Kabane",
					description: "Db port over bun:sqlite and Durable Object SQLite",
					kind: "issue",
					scopeUri: "kabane",
				}),
			);
			const child = unwrap(
				await Planner.addTask(HUB_BASE, {
					title: "Write the Durable Object adapter",
					kind: "issue",
					scopeUri: "kabane",
					parentTaskId: parent.id,
				}),
			);
			expect(parent.shortId).toMatch(/^JKAB-\d+$/);

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

			unwrap(
				await Planner.addWorkLog(HUB_BASE, {
					taskId: child.id,
					refs: [{ uri: "session:01HUB", label: "claude" }],
				}),
			);
			unwrap(
				await Planner.addEntry(HUB_BASE, {
					taskId: child.id,
					kind: "outcome.finding",
					author: "claude",
					authorType: "ai",
					content: "Severity: P2\nthe adapter is a pass-through",
				}),
			);

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
			expect(brief).toContain("**claude** (outcome.finding, ai, ");
			expect(brief).toContain("the adapter is a pass-through");
			expect(brief).toContain("claude (session:01HUB)");
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

describe("migration 14 over Durable Object SQLite", () => {
	it("moves a schema-12 hub's rows into the record, keeps its module rows, and serves them", async () => {
		const h = hub("record-migrate");
		unwrap(await h.boot());
		await runInDurableObject(h, async (_i: KabaneHub, ctx) => {
			const provider = DoDb.provider(ctx.storage);
			// The constructor booted this object to the latest schema: start over
			// from a hub as schema 12 left it, with the questions module beside it.
			unwrap(
				await provider.withDb(HUB_BASE, (db) => {
					wipe(db);
					unwrap(Migrate.run(db, Migrations.LIST.slice(0, 12)));
					// The questions table as it stood before its own detach migration:
					// still referencing tasks(id), which a DROP would cascade into.
					unwrap(
						Migrate.run(
							db,
							(questionsModule.migrations ?? []).slice(0, 2),
							"schema_migrations_questions",
						),
					);
					expect(
						db
							.query<{ sql: string }, []>(
								"SELECT sql FROM sqlite_master WHERE name = 'task_questions'",
							)
							.get()?.sql,
					).toContain("REFERENCES tasks(id)");
				}),
			);
			const at = "2026-11-24T12:00:00.000Z";
			unwrap(
				await provider.withDb(HUB_BASE, (db) => {
					db.run(
						`INSERT INTO tasks (id, short_id, title, description, state, priority, tags,
						   discovered_at, discovered_by, updated_by, created_at, updated_at)
						 VALUES ('01TASKPARENT00000000000000', 'JHUB-1', 'parent', 'body', 'next',
						   'high', '["x"]', ?, 'kabane://actor/human/ada', 'kabane://actor/human/ada', ?, ?),
						        ('01TASKCHILD000000000000000', 'JHUB-2', 'child searchable', NULL, 'inbox',
						   'normal', '[]', ?, NULL, 'kabane://actor/human/ada', ?, ?)`,
						[at, at, at, at, at, at],
					);
					db.run(
						`INSERT INTO task_links (id, source_id, target_id, type, created_at)
						 VALUES ('01LINKPARENT', '01TASKPARENT00000000000000', '01TASKCHILD000000000000000', 'parent', ?),
						        ('01LINKBLOCKS', '01TASKCHILD000000000000000', '01TASKPARENT00000000000000', 'blocks', ?)`,
						[at, at],
					);
					db.run(
						`INSERT INTO task_comments (id, task_id, author, author_type, content, created_at, kind)
						 VALUES ('01COMMENT', '01TASKPARENT00000000000000', 'ada', 'human', 'hello', ?, 'comment')`,
						[at],
					);
					db.run(
						`INSERT INTO task_work_log (id, task_id, refs, note, created_at)
						 VALUES ('01WORKLOG', '01TASKPARENT00000000000000', '[{"uri":"commit:abc","addedAt":"${at}"}]', 'did it', ?)`,
						[at],
					);
					db.run(
						`INSERT INTO task_context_refs (id, task_id, uri, kind, label, added_at)
						 VALUES ('01CTX', '01TASKPARENT00000000000000', 'file:spec.md', 'spec', 'Spec', ?)`,
						[at],
					);
					db.run(
						`INSERT INTO upstream_links (id, task_id, provider, external_id, identifier, url, title, created_at, updated_at)
						 VALUES ('01UP', '01TASKPARENT00000000000000', 'github', '42', 'o/r#1', 'https://example.org/1', 'Up', ?, ?)`,
						[at, at],
					);
					db.run(
						`INSERT INTO task_questions (id, task_id, asked_by, created_at, updated_at, updated_by, body)
						 VALUES ('01QUESTION', '01TASKPARENT00000000000000', 'kabane://actor/agent/claude', ?, ?, 'kabane://actor/agent/claude', 'Which?')`,
						[at, at],
					);
				}),
			);

			unwrap(await Planner.init(HUB_BASE));

			const counts = unwrap(
				await provider.withDb(HUB_BASE, (db) =>
					Object.fromEntries(
						[
							"threads",
							"entries",
							"refs",
							"retired_tasks",
							"task_questions",
						].map((table) => [
							table,
							db
								.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`)
								.get()?.n,
						]),
					),
				),
			);
			// Two threads; a comment and a work log; a blocks link, a context ref
			// and an upstream ref (the parent link is the child's parent now).
			expect(counts).toEqual({
				threads: 2,
				entries: 2,
				refs: 3,
				retired_tasks: 2,
				task_questions: 1,
			});
			const child = unwrap(
				await Planner.getTask(HUB_BASE, "01TASKCHILD000000000000000"),
			);
			expect(child?.parentTaskId).toBe("01TASKPARENT00000000000000");
			const parent = unwrap(
				await Planner.getTask(HUB_BASE, "01TASKPARENT00000000000000"),
			);
			expect(parent).toMatchObject({
				shortId: "JHUB-1",
				description: "body",
				priority: "high",
				tags: ["x"],
				state: "next",
			});
			expect(
				unwrap(
					await Planner.getComments(HUB_BASE, "01TASKPARENT00000000000000"),
				).length,
			).toBe(1);
			expect(
				unwrap(await Planner.searchTasks(HUB_BASE, "searchable")).map(
					(t) => t.id,
				),
			).toEqual(["01TASKCHILD000000000000000"]);
			// A new task after the migration lands in the record and reads back.
			const added = unwrap(await Planner.addTask(HUB_BASE, { title: "after" }));
			expect(unwrap(await Planner.getTask(HUB_BASE, added.id))?.title).toBe(
				"after",
			);
		});
	});
});
