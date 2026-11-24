/**
 * Storage — the migration list on real databases.
 *
 * The repeat failure in this codebase is new code booting on an old database:
 * a column the DDL declares but the live table lacks. So each migration runs
 * here on a database stamped at the version before it.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Migrate } from "../db/migrate";
import type { Db } from "../db/port";
import type { Result } from "../result";
import { withDb as runWithDb } from "../runtime";
import { formatQuestionBody } from "../schemas";
import { configureTestRuntime } from "../testing";
import { Legacy } from "../testing/legacy-rows";
import { columnExists, TABLES } from "./helpers";
import { Planner } from "./index";
import { Migrations } from "./migrations";
import { Oplog } from "./oplog";

let base: string;

const withDb = async <T>(fn: (db: Db) => T, at = base): Promise<T> => {
	const result = await runWithDb(at, fn);
	if (!result.ok) throw result.error;
	return result.value;
};

const freshBase = (label: string): string => {
	const dir = join(
		tmpdir(),
		`kabane-migrations-${label}-${crypto.randomUUID()}`,
	);
	mkdirSync(dir, { recursive: true });
	return dir;
};

const mustInit = async (at: string): Promise<void> => {
	const init = await Planner.init(at);
	if (!init.ok) throw init.error;
};

const versionRows = (at = base) =>
	withDb(
		(db) =>
			db
				.query<{ version: number; name: string }, []>(
					`SELECT version, name FROM ${TABLES.schema_migrations} ORDER BY version`,
				)
				.all(),
		at,
	);

/** Run the list up to `version` only: a migration's own effect, before the record moves it. */
const initTo = (version: number, at = base) =>
	withDb((db) => {
		const ran = Migrate.run(db, Migrations.LIST.slice(0, version));
		if (!ran.ok) throw ran.error;
	}, at);

/** What a database reports once every migration has run. */
const ALL_VERSIONS = Migrations.LIST.map((m, i) => ({
	version: i + 1,
	name: m.name,
}));

const tableNames = (at = base) =>
	withDb(
		(db) =>
			db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type = 'table'",
				)
				.all()
				.map((r) => r.name),
		at,
	);

const NOW = "2026-07-18T12:00:00.000Z";

/** The version before `session-outcomes`, which drops the session tables. */
const SESSION_OUTCOMES = Migrations.LIST.findIndex(
	(m) => m.name === "session-outcomes",
);

describe("Migrations on a fresh database", () => {
	beforeEach(async () => {
		base = freshBase("fresh");
		await mustInit(base);
	});

	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("records every migration once, and a second boot applies nothing", async () => {
		expect(await versionRows()).toEqual(ALL_VERSIONS);
		await mustInit(base);
		expect(await versionRows()).toEqual(ALL_VERSIONS);
		const again = await withDb((db) => Migrations.apply(db));
		expect(again).toEqual({
			ok: true,
			value: {
				from: Migrations.SCHEMA_VERSION,
				to: Migrations.SCHEMA_VERSION,
				applied: [],
			},
		});
	});

	it("refuses a database a newer kabane has migrated, and says to update", async () => {
		await withDb((db) =>
			db.run(
				`INSERT INTO ${TABLES.schema_migrations} (version, name, applied_at) VALUES (?, 'from-the-future', ?)`,
				[Migrations.SCHEMA_VERSION + 1, NOW],
			),
		);
		const init = await Planner.init(base);
		expect(init.ok).toBe(false);
		expect(init.ok ? "" : init.error.message).toContain("update kabane");
	});
});

describe("Migrations on a database from before the runner", () => {
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("refuses it, says which kabane still upgrades it, and changes nothing", async () => {
		base = freshBase("pre-runner");
		// Tables and no version table: what a build older than the runner left.
		await withDb((db) => {
			db.run(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)`);
			db.run(`INSERT INTO tasks (id, title) VALUES ('01KEPT', 'kept')`);
		});

		for (const _boot of [1, 2]) {
			const init = await Planner.init(base);
			expect(init.ok ? "" : init.error.message).toContain(
				"open it once with kabane 1.0.0-beta.0",
			);
			expect(await versionRows()).toEqual([]);
		}
		const kept = await withDb((db) =>
			db
				.query<{ title: string }, [string]>(
					"SELECT title FROM tasks WHERE id = ?",
				)
				.get("01KEPT"),
		);
		expect(kept).toEqual({ title: "kept" });
	});
});

describe("Migrations on a device stamped at the baseline", () => {
	beforeEach(async () => {
		base = freshBase("stamped");
		// What David's devices are after their first boot on the runner: version 1
		// and nothing above it.
		await withDb((db) => {
			const stamped = Migrate.run(db, Migrations.LIST.slice(0, 1));
			if (!stamped.ok) throw stamped.error;
		});
	});

	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("drops the retired tables and keeps every live row", async () => {
		const task = await Legacy.addTask(base, { title: "keeps" });
		if (!task.ok) throw task.error;
		// Written the way a baseline build wrote it: no kind column yet.
		await withDb((db) =>
			db.run(
				`INSERT INTO task_comments (id, task_id, author, author_type, content, created_at)
				 VALUES ('01COMMENT', ?, 'david', 'human', 'keeps too', ?)`,
				[task.value.id, NOW],
			),
		);
		await withDb((db) =>
			db.run(
				`INSERT INTO proposals
				   (id, action, confidence, summary, payload, created_at, updated_at)
				 VALUES ('01PROPOSAL', 'ask_question', 0.9, 'retired', '{}', ?, ?)`,
				[NOW, NOW],
			),
		);
		await withDb((db) =>
			db.run(
				`INSERT INTO focus_lists (id, period, created_at, updated_at)
				 VALUES ('01FOCUS', 'daily', ?, ?)`,
				[NOW, NOW],
			),
		);
		await withDb((db) =>
			db.run(
				`INSERT INTO task_activity
				   (id, task_id, event_type, actor, actor_type, timestamp)
				 VALUES ('01ACTIVITY', ?, 'short_id_renamed', 'sync', 'ai', ?)`,
				[task.value.id, NOW],
			),
		);

		await mustInit(base);

		expect(await versionRows()).toEqual(ALL_VERSIONS);
		const tables = await tableNames();
		for (const retired of [
			"proposals",
			"proposals_fts",
			"focus_lists",
			"task_activity",
		]) {
			expect(tables).not.toContain(retired);
		}
		const kept = await Planner.getTask(base, task.value.id);
		expect(kept.ok && kept.value?.title).toBe("keeps");
		const comments = await Planner.getComments(base, task.value.id);
		expect(comments.ok && comments.value.map((c) => c.content)).toEqual([
			"keeps too",
		]);
		const found = await Planner.searchTasks(base, "keeps");
		expect(found.ok && found.value.map((t) => t.id)).toEqual([task.value.id]);
	});
});

describe("Migration 5: end-of-UTC-day deadlines become the dates they meant", () => {
	const SHAPES: [stored: string, expected: string][] = [
		["2026-02-06T23:59:59.999Z", "2026-02-06"],
		["2026-02-07T23:59:59.000Z", "2026-02-07"],
		["2026-02-08T23:59:59Z", "2026-02-08"],
		["2026-02-09T23:59:00.000Z", "2026-02-09"],
		["2026-02-10T23:59:00Z", "2026-02-10"],
		// Real instants and dates stay as they are.
		["2026-02-11T21:00:00Z", "2026-02-11T21:00:00Z"],
		["2026-02-12T09:00:00.000Z", "2026-02-12T09:00:00.000Z"],
		["2026-02-13T23:59:58.000Z", "2026-02-13T23:59:58.000Z"],
		["2026-02-14", "2026-02-14"],
	];

	afterEach(() => {
		configureTestRuntime();
		rmSync(base, { recursive: true, force: true });
	});

	it("converts only the end-of-day shapes, once", async () => {
		base = freshBase("deadlines");
		// A device on the build before this migration: versions 1 to 4.
		await withDb((db) => {
			const stamped = Migrate.run(db, Migrations.LIST.slice(0, 4));
			if (!stamped.ok) throw stamped.error;
		});
		const ids: string[] = [];
		for (const [stored] of SHAPES) {
			// Written as the old build stored it, past today's input parsing.
			const task = await Legacy.addTask(base, { title: stored });
			if (!task.ok) throw task.error;
			await withDb((db) =>
				db.run(`UPDATE ${TABLES.tasks} SET deadline = ? WHERE id = ?`, [
					stored,
					task.value.id,
				]),
			);
			ids.push(task.value.id);
		}
		const none = await Legacy.addTask(base, { title: "no deadline" });
		if (!none.ok) throw none.error;

		await mustInit(base);
		expect(await versionRows()).toEqual(ALL_VERSIONS);
		const read = async () =>
			withDb((db) =>
				ids.map(
					(id) =>
						db
							.query<{ deadline: string | null }, [string]>(
								`SELECT deadline FROM ${TABLES.tasks} WHERE id = ?`,
							)
							.get(id)?.deadline,
				),
			);
		expect(await read()).toEqual(SHAPES.map(([, expected]) => expected));
		const kept = await Planner.getTask(base, none.value.id);
		expect(kept.ok && kept.value?.deadline).toBeUndefined();

		// A second boot applies nothing and changes nothing.
		await mustInit(base);
		expect(await versionRows()).toEqual(ALL_VERSIONS);
		expect(await read()).toEqual(SHAPES.map(([, expected]) => expected));
	});
});

describe("Migration 6: relayed tool-permission answers stop being decisions", () => {
	afterEach(() => {
		configureTestRuntime();
		rmSync(base, { recursive: true, force: true });
	});

	const relayed = (title: string, text = `claude asks to run: ${title}`) =>
		formatQuestionBody(text, {
			choices: ["Yes", "No"],
			multiSelect: false,
			allowFreeform: false,
			permission: {
				toolCallId: "toolu_01",
				title,
				options: [
					{ id: "allow", label: "Yes", kind: "allow_once" },
					{ id: "reject", label: "No", kind: "reject_once" },
				],
			},
		});

	const must = <T>(r: Result<T>): T => {
		if (!r.ok) throw r.error;
		return r.value;
	};

	it("deletes only the provable permission traffic, once", async () => {
		base = freshBase("permission-decisions");
		// A device on the build before this migration: versions 1 to 5.
		await withDb((db) => {
			const stamped = Migrate.run(db, Migrations.LIST.slice(0, 5));
			if (!stamped.ok) throw stamped.error;
		});
		const task = must(await Legacy.addTask(base, { title: "t" }));
		let sessions = 0;
		const start = async () => {
			const id = `s${++sessions}`;
			await withDb((db) =>
				db.run(
					`INSERT INTO agent_sessions (id, task_id, agent, state, started_at, last_activity_at)
					 VALUES (?, ?, 'claude', 'active', ?, ?)`,
					[id, task.id, NOW, NOW],
				),
			);
			return id;
		};
		const setState = (id: string, state: string) =>
			withDb((db) =>
				db.run("UPDATE agent_sessions SET state = ? WHERE id = ?", [state, id]),
			);
		// Rows as the build before this migration stored them, without the
		// columns later migrations add.
		let seq = 0;
		const add = async (
			sessionId: string,
			type: string,
			body: string,
			context?: string,
		) => {
			const id = `a${String(++seq).padStart(2, "0")}`;
			await withDb((db) =>
				db.run(
					`INSERT INTO agent_activities
					   (id, session_id, type, ephemeral, context, body, created_at)
					 VALUES (?, ?, ?, 0, ?, ?, ?)`,
					[id, sessionId, type, context ?? null, body, NOW],
				),
			);
			return id;
		};
		// What `answerQuestion` wrote before this build, for every question.
		const decide = (sessionId: string, questionId: string, body: string) =>
			add(sessionId, "decision", body, `answers ${questionId}`);

		const done = await start();
		const approved = await add(done, "question", relayed("Write a.ts"));
		const approval = await decide(done, approved, "Yes");
		const asked = await add(
			done,
			"question",
			formatQuestionBody("Plain text or markdown?", {
				choices: ["Plain text", "Markdown"],
				allowFreeform: false,
			}),
		);
		const choice = await decide(done, asked, "Plain text");
		// Shaped like a relayed request but carrying no `permission` block: not provable.
		const lookalike = await add(
			done,
			"question",
			formatQuestionBody("claude asks to run: bun install", {
				choices: ["Yes", "No"],
			}),
		);
		const lookalikeAnswer = await decide(done, lookalike, "Yes");
		// A `permission` block under text the relay never wrote: not provable either.
		const reworded = await add(
			done,
			"question",
			relayed("Write b.ts", "Approve b.ts?"),
		);
		const rewordedAnswer = await decide(done, reworded, "Yes");
		const deliberate = await add(done, "decision", "Going with SQLite");
		await setState(done, "complete");

		const stopped = await start();
		const cancelled = await add(stopped, "question", relayed("Write c.ts"));
		await setState(stopped, "error");

		const live = await start();
		const waiting = await add(live, "question", relayed("Write d.ts"));
		await setState(live, "awaiting_input");

		const kept = [
			asked,
			choice,
			lookalike,
			lookalikeAnswer,
			reworded,
			rewordedAnswer,
			deliberate,
			waiting,
		];
		const ids = async () =>
			withDb((db) =>
				db
					.query<{ id: string }, []>("SELECT id FROM agent_activities")
					.all()
					.map((r) => r.id)
					.sort(),
			);
		expect(await ids()).toEqual(
			[...kept, approved, approval, cancelled].sort(),
		);

		// Up to the version before `session-outcomes`, which drops the tables.
		const upTo = (version: number) =>
			withDb((db) => must(Migrate.run(db, Migrations.LIST.slice(0, version))));
		await upTo(SESSION_OUTCOMES);
		expect(await versionRows()).toEqual(
			ALL_VERSIONS.slice(0, SESSION_OUTCOMES),
		);
		expect(await ids()).toEqual([...kept].sort());
		const state = await withDb((db) =>
			db
				.query<{ state: string }, [string]>(
					"SELECT state FROM agent_sessions WHERE id = ?",
				)
				.get(live),
		);
		expect(state?.state).toBe("awaiting_input");

		await upTo(SESSION_OUTCOMES);
		expect(await ids()).toEqual([...kept].sort());
	});
});

describe("Migration 9: an issue's comments become entries of kind comment", () => {
	afterEach(() => {
		configureTestRuntime();
		rmSync(base, { recursive: true, force: true });
	});

	// 7 is where the released 1.0.0-beta.0 leaves a database; 8 never shipped.
	for (const from of [7, 8]) {
		it(`reads every existing comment as kind comment, from version ${from}`, async () => {
			base = freshBase(`entry-kind-${from}`);
			await withDb((db) => {
				const stamped = Migrate.run(db, Migrations.LIST.slice(0, from));
				if (!stamped.ok) throw stamped.error;
			});
			expect(
				await withDb((db) => columnExists(db, "task_comments", "kind")),
			).toBe(false);
			const task = await Legacy.addTask(base, { title: "t" });
			if (!task.ok) throw task.error;
			await withDb((db) =>
				db.run(
					`INSERT INTO task_comments (id, task_id, author, author_type, content, created_at)
					 VALUES ('01COMMENT', ?, 'david', 'human', 'before kinds', ?)`,
					[task.value.id, NOW],
				),
			);

			// The index is on the table migration 14 moves into the record.
			await initTo(9);
			const index = await withDb((db) =>
				db
					.query<{ name: string }, [string]>(
						"SELECT name FROM pragma_index_list(?) WHERE name LIKE '%task_kind_idx'",
					)
					.all("task_comments"),
			);
			expect(index).toEqual([{ name: "task_comments_task_kind_idx" }]);

			await mustInit(base);
			expect(await versionRows()).toEqual(ALL_VERSIONS);
			const entries = await Planner.getEntries(base, task.value.id);
			expect(entries.ok && entries.value).toEqual([
				{
					id: "01COMMENT",
					taskId: task.value.id,
					kind: "comment",
					author: "david",
					authorType: "human",
					content: "before kinds",
					createdAt: NOW,
					updatedAt: undefined,
				},
			]);
		});
	}
});

describe("Migration 10: scopes leave the jake:// scheme", () => {
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("renames every stored scope and logged op, once, and moves no version or clock", async () => {
		base = freshBase("scope-scheme");
		// A device on the build before this migration, with sync armed.
		await withDb((db) => {
			const stamped = Migrate.run(db, Migrations.LIST.slice(0, 9));
			if (!stamped.ok) throw stamped.error;
			const armed = Oplog.initDevice(db, "device-a");
			if (!armed.ok) throw armed.error;
		});
		const project = await Planner.addProject(base, {
			title: "p",
			scopeUri: "mill",
		});
		if (!project.ok) throw project.error;
		const plain = await Legacy.addTask(base, {
			title: "plain",
			scopeUri: "mill",
			// Text that only mentions the old scheme is not a scope.
			description: "see jake://scope/mill for the history",
		});
		const extended = await Legacy.addTask(base, {
			title: "extended",
			scopeUri: "kabane://scope/github.com%2Facme%2Fmill?branch=main",
			scopeRefs: [{ scopeUri: "kabane://scope/other", role: "related" }],
		});
		const unscoped = await Legacy.addTask(base, { title: "unscoped" });
		if (!plain.ok || !extended.ok || !unscoped.ok)
			throw new Error("seeding failed");
		// What that build stored: the same rows and ops under the old scheme.
		await withDb((db) => {
			for (const table of [TABLES.tasks, TABLES.projects, TABLES.sequences])
				db.run(
					`UPDATE ${table} SET scope_uri = replace(scope_uri, 'kabane://scope/', 'jake://scope/')`,
				);
			db.run(
				`UPDATE ${TABLES.tasks} SET scope_refs = replace(scope_refs, 'kabane://scope/', 'jake://scope/')`,
			);
			db.run(
				`UPDATE ${TABLES.sync_oplog} SET payload = replace(payload, 'kabane://scope/', 'jake://scope/')`,
			);
		});
		const scopes = () =>
			withDb((db) => ({
				tasks: db
					.query<Record<string, unknown>, []>(
						`SELECT title, scope_uri, scope_refs, description, version, updated_at
						   FROM ${TABLES.tasks} ORDER BY title`,
					)
					.all(),
				projects: db
					.query<{ scope_uri: string }, []>(
						`SELECT scope_uri FROM ${TABLES.projects}`,
					)
					.all(),
				sequences: db
					.query<{ prefix: string; scope_uri: string | null }, []>(
						`SELECT prefix, scope_uri FROM ${TABLES.sequences} ORDER BY prefix`,
					)
					.all(),
				ops: db
					.query<{ payload: string }, []>(
						`SELECT payload FROM ${TABLES.sync_oplog} WHERE tbl IN ('tasks', 'projects') ORDER BY seq`,
					)
					.all()
					.map((op) => JSON.parse(op.payload) as Record<string, unknown>)
					.map((row) => [row.title, row.scope_uri, row.scope_refs]),
			}));
		const before = await scopes();
		expect(before.ops).toContainEqual(["plain", "jake://scope/mill", null]);

		await initTo(10);
		expect(await versionRows()).toEqual(ALL_VERSIONS.slice(0, 10));

		const after = await scopes();
		const old = (uri: string) => uri.replace("kabane://", "jake://");
		expect(after.tasks).toEqual([
			{
				...before.tasks[0],
				scope_uri: "kabane://scope/github.com%2Facme%2Fmill?branch=main",
				scope_refs: '[{"scopeUri":"kabane://scope/other","role":"related"}]',
			},
			{ ...before.tasks[1], scope_uri: "kabane://scope/mill" },
			{ ...before.tasks[2] },
		]);
		expect(after.tasks[1]?.description).toBe(
			"see jake://scope/mill for the history",
		);
		expect(after.tasks[2]?.scope_uri).toBeNull();
		expect(after.projects).toEqual([{ scope_uri: "kabane://scope/mill" }]);
		expect(after.sequences).toEqual(
			before.sequences.map((row) => ({
				...row,
				scope_uri:
					row.scope_uri && row.scope_uri.replace("jake://", "kabane://"),
			})),
		);
		expect(after.sequences.map((row) => row.scope_uri)).toContain(
			"kabane://scope/mill",
		);
		expect(after.ops).toEqual([
			["p", "kabane://scope/mill", undefined],
			["plain", "kabane://scope/mill", null],
			[
				"extended",
				"kabane://scope/github.com%2Facme%2Fmill?branch=main",
				'[{"scopeUri":"kabane://scope/other","role":"related"}]',
			],
			["unscoped", null, null],
		]);
		expect(before.ops.map(([, uri]) => uri)).toEqual(
			after.ops.map(([, uri]) => (typeof uri === "string" ? old(uri) : uri)),
		);

		// A second boot is a read of the version table.
		await initTo(10);
		expect(await scopes()).toEqual(after);

		// The old scheme, the new one and a bare id all name the scope.
		for (const scopeUri of [
			"jake://scope/mill",
			"kabane://scope/mill",
			"mill",
		]) {
			const found = await Planner.queryTasks(base, { scopeUri });
			expect(found.ok && found.value.map((t) => t.title)).toEqual(["plain"]);
		}
	});
});

describe("Migration 12: actors leave the cabane:// scheme", () => {
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	const must = <T>(result: Result<T>): T => {
		if (!result.ok) throw result.error;
		return result.value;
	};
	const ADA = "cabane://actor/human/ada";
	const CLAUDE = "cabane://actor/agent/claude";

	/** Every identity column core owns, with the values it holds. */
	const identities = () =>
		withDb((db) =>
			[
				[TABLES.tasks, "discovered_by"],
				[TABLES.tasks, "reviewed_by"],
				[TABLES.tasks, "updated_by"],
				[TABLES.projects, "updated_by"],
				["task_links", "updated_by"],
				["task_comments", "author"],
				["task_comments", "updated_by"],
				["task_work_log", "updated_by"],
				["task_context_refs", "added_by"],
				["task_context_refs", "updated_by"],
			].map(([table, column]): [string, (string | null)[]] => [
				`${table}.${column}`,
				db
					.query<{ value: string | null }, []>(
						`SELECT ${column} AS value FROM ${table} ORDER BY id`,
					)
					.all()
					.map((row) => row.value),
			]),
		);

	it("renames every identity column and logged or parked op, once, and leaves prose, other shapes, versions and clocks alone", async () => {
		base = freshBase("actor-scheme");
		// A device on the build before this migration, with sync armed.
		await withDb((db) => {
			must(Migrate.run(db, Migrations.LIST.slice(0, 11)));
			must(Oplog.initDevice(db, "device-a"));
		});
		must(await Planner.addProject(base, { title: "p" }));
		const task = must(
			await Legacy.addTask(base, {
				title: "t",
				description: `${CLAUDE} starts this description`,
				verification: {
					status: "passed",
					verifiedBy: CLAUDE,
					notes: `${CLAUDE} checked it`,
				},
			}),
		);
		const other = must(await Legacy.addTask(base, { title: "o" }));
		must(
			await Legacy.addLink(base, {
				sourceId: task.id,
				targetId: other.id,
				type: "blocks",
			}),
		);
		for (const [author, content] of [
			[CLAUDE, `quotes ${ADA}`],
			["claude", "a bare name"],
			["agent:claude", "an older shape"],
			["kabane://actor/agent/codex", "already renamed"],
		] as const)
			must(
				await Legacy.addComment(base, {
					taskId: task.id,
					author,
					authorType: "ai",
					content,
				}),
			);
		must(
			await Legacy.addWorkLog(base, {
				taskId: task.id,
				refs: [{ uri: "commit:abc" }],
				addedBy: CLAUDE,
				addedByType: "ai",
			}),
		);
		must(
			await Legacy.addContextRef(base, {
				taskId: task.id,
				uri: "file:README.md",
				kind: "doc",
				addedBy: CLAUDE,
			}),
		);
		// What that build stored: its writers under the old prefix, in rows and in ops.
		await withDb((db) => {
			db.run(
				`UPDATE ${TABLES.tasks} SET updated_by = ?, discovered_by = ?, reviewed_by = ?`,
				[ADA, CLAUDE, ADA],
			);
			for (const table of [
				TABLES.projects,
				"task_links",
				"task_work_log",
				"task_context_refs",
			])
				db.run(`UPDATE ${table} SET updated_by = ?`, [ADA]);
			db.run(`UPDATE task_comments SET updated_by = author`);
			db.run(
				`UPDATE ${TABLES.sync_oplog} SET payload = replace(payload, 'kabane://actor/unknown', ?)`,
				[ADA],
			);
			db.run(
				`INSERT INTO ${TABLES.sync_oplog} (op_id, device_id, tbl, row_id, op, payload, captured_at)
				 VALUES ('gone', 'device-a', ?, 'gone', 'delete', NULL, '2026-11-20T00:00:00.000Z')`,
				["task_comments"],
			);
			// An extension's table: `requested_by` is free text, `updated_by` the writer sync carries.
			db.run(
				`INSERT INTO ${TABLES.sync_oplog} (op_id, device_id, tbl, row_id, op, payload, captured_at)
				 VALUES ('ext', 'device-a', 'ext_requests', 'r1', 'insert', ?, '2026-11-20T00:00:00.000Z')`,
				[JSON.stringify({ id: "r1", requested_by: ADA, updated_by: ADA })],
			);
			for (const [opId, tbl, payload] of [
				[
					"parked",
					"task_checklist_items",
					{
						id: "c1",
						text: `${ADA} wrote this`,
						done_by: ADA,
						updated_by: ADA,
					},
				],
				[
					"parked-ext",
					"ext_requests",
					{ id: "r2", requested_by: ADA, updated_by: ADA },
				],
			] as const)
				db.run(
					`INSERT INTO ${TABLES.sync_parked} (op_id, server_seq, module, module_schema, tbl, row_id, op, parked_at)
					 VALUES (?, 7, 'checklist', 9, ?, ?, ?, '2026-11-20T00:00:00.000Z')`,
					[
						opId,
						tbl,
						payload.id,
						JSON.stringify({
							opId,
							tbl,
							rowId: payload.id,
							op: "update",
							payload,
							updatedBy: ADA,
						}),
					],
				);
		});
		const rows = () =>
			withDb((db) => ({
				tasks: db
					.query<Record<string, unknown>, []>(
						`SELECT id, description, verification, version, updated_at FROM ${TABLES.tasks} ORDER BY id`,
					)
					.all(),
				comments: db
					.query<{ author: string; content: string }, []>(
						`SELECT author, content FROM task_comments ORDER BY id`,
					)
					.all(),
				refs: db
					.query<{ refs: string }, []>(`SELECT refs FROM task_work_log`)
					.all()
					.map((row) => JSON.parse(row.refs) as Record<string, unknown>[]),
				ops: db
					.query<{ tbl: string; payload: string | null }, []>(
						`SELECT tbl, payload FROM ${TABLES.sync_oplog} ORDER BY seq`,
					)
					.all()
					.map((op) => ({
						tbl: op.tbl,
						row:
							op.payload === null
								? null
								: (JSON.parse(op.payload) as Record<string, unknown>),
					})),
				parked: db
					.query<{ op: string }, []>(
						`SELECT op FROM ${TABLES.sync_parked} ORDER BY op_id`,
					)
					.all()
					.map((row) => JSON.parse(row.op) as Record<string, unknown>),
			}));
		const before = await rows();

		await initTo(12);
		expect(await versionRows()).toEqual(ALL_VERSIONS.slice(0, 12));

		const after = await rows();
		const renamed = (value: string) =>
			value.replace(/^cabane:\/\/actor\//, "kabane://actor/");
		for (const [column, values] of await identities()) {
			const kept = values.filter((v) => v?.startsWith("cabane://"));
			expect([column, kept]).toEqual([column, []]);
		}
		expect(
			(await identities()).find(([c]) => c === "tasks.reviewed_by"),
		).toEqual([
			"tasks.reviewed_by",
			["kabane://actor/human/ada", "kabane://actor/human/ada"],
		]);
		// Prose, versions and clocks are as they were; only the identity fields moved.
		const verified = (raw: unknown) =>
			typeof raw === "string"
				? raw.replace(
						`"verifiedBy":"${CLAUDE}"`,
						`"verifiedBy":"kabane://actor/agent/claude"`,
					)
				: raw;
		expect(after.tasks).toEqual(
			before.tasks.map((t) => ({
				...t,
				verification: verified(t.verification),
			})),
		);
		expect(
			after.tasks.map((t) => JSON.parse(String(t.verification)) as unknown),
		).toContainEqual({
			status: "passed",
			verifiedBy: "kabane://actor/agent/claude",
			notes: `${CLAUDE} checked it`,
		});
		expect(after.comments).toEqual(
			before.comments.map((c) => ({ ...c, author: renamed(c.author) })),
		);
		expect(after.comments.map((c) => c.author)).toEqual([
			"kabane://actor/agent/claude",
			"claude",
			"agent:claude",
			"kabane://actor/agent/codex",
		]);
		expect(after.refs[0]?.[0]?.addedBy).toBe("kabane://actor/agent/claude");
		// The log's snapshots, a delete with none included, renamed the same way and nothing
		// captured: core's identity fields, and only the writer of an extension's table.
		expect(after.ops).toHaveLength(before.ops.length);
		expect(after.ops).toEqual(
			before.ops.map(({ tbl, row }) => ({
				tbl,
				row:
					row === null
						? null
						: Object.fromEntries(
								Object.entries(row).map(([key, value]) => [
									key,
									// The context ref was written by an agent with no type.
									key === "added_by_type" &&
									String(row.added_by).includes("actor/agent/")
										? "ai"
										: typeof value !== "string"
											? value
											: key === "updated_by" ||
												  (tbl !== "ext_requests" &&
														(key === "author" || key.endsWith("_by")))
												? renamed(value)
												: key === "refs"
													? value.replaceAll(
															CLAUDE,
															"kabane://actor/agent/claude",
														)
													: key === "verification"
														? verified(value)
														: value,
								]),
							),
			})),
		);
		expect(after.ops.find((op) => op.tbl === "ext_requests")?.row).toEqual({
			id: "r1",
			requested_by: ADA,
			updated_by: "kabane://actor/human/ada",
		});
		expect(
			after.ops.some(
				(op) => op.row?.description === `${CLAUDE} starts this description`,
			),
		).toBe(true);
		// A parked op's writer, in its envelope and its snapshot; a module's actors, registered or
		// not; and an extension's free text stays as written.
		expect(after.parked).toEqual([
			{
				...before.parked[0],
				payload: {
					id: "c1",
					text: `${ADA} wrote this`,
					done_by: "kabane://actor/human/ada",
					updated_by: "kabane://actor/human/ada",
				},
				updatedBy: "kabane://actor/human/ada",
			},
			{
				...before.parked[1],
				payload: {
					id: "r2",
					requested_by: ADA,
					updated_by: "kabane://actor/human/ada",
				},
				updatedBy: "kabane://actor/human/ada",
			},
		]);

		// A second boot is a read of the version table.
		await initTo(12);
		expect(await rows()).toEqual(after);
	});

	it("types as ai every agent stored as human, in rows and logged ops, and leaves humans, prose and versions alone", async () => {
		base = freshBase("actor-types");
		const CODEX = "kabane://actor/agent/codex";
		await withDb((db) => {
			must(Migrate.run(db, Migrations.LIST.slice(0, 11)));
			must(Oplog.initDevice(db, "device-a"));
		});
		const task = must(await Legacy.addTask(base, { title: "t" }));
		// A session on schema 11 that already wrote the new prefix, stored as a human.
		for (const [author, content] of [
			[CODEX, `${CODEX} wrote this`],
			[CLAUDE, "an old-prefix agent"],
			[ADA, "a human"],
		] as const)
			must(
				await Legacy.addComment(base, {
					taskId: task.id,
					author,
					authorType: "human",
					content,
				}),
			);
		must(
			await Legacy.addWorkLog(base, {
				taskId: task.id,
				refs: [{ uri: "commit:abc" }],
				addedBy: CODEX,
				addedByType: "human",
			}),
		);
		must(
			await Legacy.addContextRef(base, {
				taskId: task.id,
				uri: "file:README.md",
				kind: "doc",
				addedBy: CODEX,
				addedByType: "human",
			}),
		);
		const rows = () =>
			withDb((db) => ({
				comments: db
					.query<Record<string, unknown>, []>(
						`SELECT author, author_type, content, version FROM task_comments ORDER BY id`,
					)
					.all(),
				refs: db
					.query<{ refs: string }, []>(`SELECT refs FROM task_work_log`)
					.all()
					.map((row) => JSON.parse(row.refs) as Record<string, unknown>[]),
				context: db
					.query<Record<string, unknown>, []>(
						`SELECT added_by, added_by_type FROM task_context_refs`,
					)
					.all(),
				ops: db
					.query<{ tbl: string; payload: string }, [string]>(
						`SELECT tbl, payload FROM ${TABLES.sync_oplog} WHERE tbl != ? ORDER BY seq`,
					)
					.all(TABLES.tasks)
					.map((op) => ({
						tbl: op.tbl,
						row: JSON.parse(op.payload) as Record<string, unknown>,
					})),
			}));

		await initTo(12);
		const after = await rows();
		expect(after.comments).toEqual([
			{
				author: CODEX,
				author_type: "ai",
				content: `${CODEX} wrote this`,
				version: 1,
			},
			{
				author: "kabane://actor/agent/claude",
				author_type: "ai",
				content: "an old-prefix agent",
				version: 1,
			},
			{
				author: "kabane://actor/human/ada",
				author_type: "human",
				content: "a human",
				version: 1,
			},
		]);
		expect(after.refs[0]?.[0]).toMatchObject({
			addedBy: CODEX,
			addedByType: "ai",
		});
		expect(after.context).toEqual([{ added_by: CODEX, added_by_type: "ai" }]);
		// The log's snapshots say what the rows say.
		expect(
			after.ops.map(({ tbl, row }) =>
				tbl === "task_comments"
					? [row.author, row.author_type]
					: tbl === "task_context_refs"
						? [row.added_by, row.added_by_type]
						: (JSON.parse(String(row.refs)) as Record<string, unknown>[]).map(
								(ref) => [ref.addedBy, ref.addedByType],
							),
			),
		).toEqual([
			[CODEX, "ai"],
			["kabane://actor/agent/claude", "ai"],
			["kabane://actor/human/ada", "human"],
			[[CODEX, "ai"]],
			[CODEX, "ai"],
		]);

		// A second boot is a read of the version table.
		await initTo(12);
		expect(await rows()).toEqual(after);
	});

	it("types as ai a work-log ref by an agent that carries no type, and leaves an untyped human ref untyped", async () => {
		base = freshBase("ref-untyped");
		await withDb((db) => {
			must(Migrate.run(db, Migrations.LIST.slice(0, 10)));
			must(Oplog.initDevice(db, "device-a"));
		});
		const task = must(await Legacy.addTask(base, { title: "t" }));
		for (const addedBy of [CLAUDE, ADA])
			must(
				await Legacy.addWorkLog(base, {
					taskId: task.id,
					refs: [{ uri: "commit:abc" }],
					addedBy,
				}),
			);
		const refs = () =>
			withDb((db) => ({
				rows: db
					.query<{ refs: string }, []>(
						`SELECT refs FROM task_work_log ORDER BY id`,
					)
					.all()
					.map((row) => JSON.parse(row.refs) as Record<string, unknown>[]),
				ops: db
					.query<{ payload: string }, [string]>(
						`SELECT payload FROM ${TABLES.sync_oplog} WHERE tbl = ? ORDER BY seq`,
					)
					.all("task_work_log")
					.map(
						(op) =>
							JSON.parse(
								String((JSON.parse(op.payload) as { refs: string }).refs),
							) as Record<string, unknown>[],
					),
			}));
		const before = await refs();
		expect(before.rows.flat().map((ref) => "addedByType" in ref)).toEqual([
			false,
			false,
		]);

		await initTo(12);
		const after = await refs();
		const expected = [
			[{ addedBy: "kabane://actor/agent/claude", addedByType: "ai" }],
			[{ addedBy: "kabane://actor/human/ada" }],
		];
		for (const stored of [after.rows, after.ops])
			expect(
				stored
					.map((list) =>
						list.map(({ addedBy, addedByType }) =>
							addedByType === undefined
								? { addedBy }
								: { addedBy, addedByType },
						),
					)
					.sort((a, b) =>
						String(a[0]?.addedBy).localeCompare(String(b[0]?.addedBy)),
					),
			).toEqual(expected);

		await initTo(12);
		expect(await refs()).toEqual(after);
	});
});

describe("Migrations when several processes boot one database at once", () => {
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("applies the baseline exactly once and every process boots", async () => {
		base = freshBase("concurrent");
		const core = join(import.meta.dir, "..", "index.ts");
		const sqlite = join(import.meta.dir, "..", "..", "sqlite", "index.ts");
		const script = `
			import { Planner, Runtime } from ${JSON.stringify(core)};
			import { SqliteDb } from ${JSON.stringify(sqlite)};
			Runtime.configure({ provider: SqliteDb.provider({ dbName: "kabane.db" }) });
			const init = await Planner.init(${JSON.stringify(base)});
			if (!init.ok) { console.error(init.error.message); process.exit(1); }
		`;
		const children = Array.from({ length: 4 }, () =>
			Bun.spawn(["bun", "-e", script], { stderr: "pipe" }),
		);
		const codes = await Promise.all(children.map((child) => child.exited));
		const errors = await Promise.all(
			children.map((child) => new Response(child.stderr).text()),
		);
		expect({ codes, errors }).toEqual({
			codes: [0, 0, 0, 0],
			errors: ["", "", "", ""],
		});
		expect(await versionRows()).toEqual(ALL_VERSIONS);
	});
});

describe("module_declarations, bookkeeping of the module pass", () => {
	afterEach(() => rmSync(base, { recursive: true, force: true }));

	it("is created on a database every migration already ran on, moves no version, and leaves every row readable", async () => {
		base = freshBase("declarations");
		await withDb((db) => {
			const all = Migrate.run(db, Migrations.LIST);
			if (!all.ok) throw all.error;
		});
		const task = await Planner.addTask(base, { title: "kept", kind: "issue" });
		if (!task.ok) throw task.error;
		expect(await tableNames()).not.toContain(TABLES.module_declarations);

		await mustInit(base);

		expect(await tableNames()).toContain(TABLES.module_declarations);
		expect(await versionRows()).toEqual(ALL_VERSIONS);
		const kept = await Planner.getTask(base, task.value.id);
		expect(kept.ok && kept.value?.title).toBe("kept");
	});
});
