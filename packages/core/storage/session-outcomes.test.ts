/**
 * Migration `session-outcomes` on real SQLite, from a database stamped at the
 * version before it and holding session rows as the builds before JCAB-340
 * wrote them, and through real sync over the in-process relay.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Migrate } from "../db/migrate";
import type { Db } from "../db/port";
import type { Result } from "../result";
import { withDb as runWithDb } from "../runtime";
import { formatQuestionBody } from "../schemas";
import { Backfill } from "../sync/backfill";
import { LocalRelay } from "../sync/local-relay";
import { Sync } from "../sync/namespace";
import { configureTestRuntime, TEST_DB_NAME } from "../testing";
import { TABLES } from "./helpers";
import { Planner } from "./index";
import { Migrations } from "./migrations";
import { Oplog } from "./oplog";

const MIGRATOR = "cabane://actor/human/migrator";

/** The version a device is at before this migration: every migration before it. */
const BEFORE = Migrations.LIST.findIndex((m) => m.name === "session-outcomes");

const bases: string[] = [];

afterEach(() => {
	configureTestRuntime();
	for (const base of bases.splice(0))
		rmSync(base, { recursive: true, force: true });
});

const must = <T>(r: Result<T>): T => {
	if (!r.ok) throw r.error;
	return r.value;
};

const freshBase = (label: string): string => {
	const dir = join(
		tmpdir(),
		`cabane-session-outcomes-${label}-${crypto.randomUUID()}`,
	);
	mkdirSync(dir, { recursive: true });
	bases.push(dir);
	return dir;
};

const withDb = async <T>(base: string, fn: (db: Db) => T): Promise<T> =>
	must(await runWithDb(base, fn));

const as = (actor: string) => configureTestRuntime({ actor: () => actor });

/** A device at the version before the migration, holding nothing yet. */
const before = async (label: string): Promise<string> => {
	const base = freshBase(label);
	await withDb(base, (db) =>
		must(Migrate.run(db, Migrations.LIST.slice(0, BEFORE))),
	);
	return base;
};

const arm = (base: string, deviceId: string) =>
	withDb(base, (db) => must(Oplog.initDevice(db, deviceId)));

const T0 = "2026-10-01T10:00:00.000Z";
const at = (minute: number) =>
	`2026-10-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

/**
 * The rows a pre-JCAB-340 build left: a completed session that asked and was
 * answered, decided alone, found something and summed up; a live session still
 * waiting on an open question, on another issue; and a session whose issue's
 * work log already names it, as the loop wrote it.
 */
const seedLegacy = async (base: string) => {
	const issue = must(
		await Planner.addTask(base, { title: "Tabs", kind: "issue" }),
	);
	const other = must(
		await Planner.addTask(base, { title: "Bar", kind: "issue" }),
	);
	must(
		await Planner.addComment(base, {
			taskId: issue.id,
			author: "cabane://actor/agent/claude",
			authorType: "ai",
			content: "AI_COMMENT_BEFORE",
		}),
	);
	must(
		await Planner.addComment(base, {
			taskId: issue.id,
			author: "david",
			authorType: "human",
			content: "HUMAN_STEERING",
		}),
	);
	const loggedRef = must(
		await Planner.addWorkLog(base, {
			taskId: other.id,
			refs: [{ uri: "session:01S3", label: "codex" }],
			addedBy: "loop:run-0",
			addedByType: "ai",
		}),
	);
	await withDb(base, (db) => {
		const session = (
			id: string,
			taskId: string,
			agent: string,
			state: string,
			externalRef: string | null,
			startedAt: string,
		) =>
			db.run(
				`INSERT INTO agent_sessions
				   (id, task_id, agent, state, external_ref, summary, started_at, last_activity_at, ended_at)
				 VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
				[id, taskId, agent, state, externalRef, startedAt, startedAt],
			);
		const activity = (
			id: string,
			sessionId: string,
			type: string,
			body: string,
			createdAt: string,
			more: {
				ephemeral?: number;
				severity?: string;
				category?: string;
				context?: string;
				author?: string;
			} = {},
		) =>
			db.run(
				`INSERT INTO agent_activities
				   (id, session_id, type, ephemeral, severity, category, context, body, author, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					sessionId,
					type,
					more.ephemeral ?? 0,
					more.severity ?? null,
					more.category ?? null,
					more.context ?? null,
					body,
					more.author ?? null,
					createdAt,
				],
			);
		session("01S1", issue.id, "claude", "complete", "loop:run-1", T0);
		activity("01A1", "01S1", "progress", "read the brief", at(1));
		activity(
			"01Q1",
			"01S1",
			"question",
			formatQuestionBody("Plain text or markdown?", {
				choices: ["Plain text", "Markdown"],
				allowFreeform: false,
			}),
			at(2),
		);
		activity("01D1", "01S1", "decision", "Markdown", at(3), {
			context: "answers 01Q1",
			author: "cabane://actor/human/ada",
		});
		activity("01D2", "01S1", "decision", "Going with SQLite", at(4));
		activity("01F1", "01S1", "finding", "the bar overflows", at(5), {
			severity: "P2",
			category: "layout",
			context: "seen at 38 columns",
		});
		activity("01E1", "01S1", "progress", "spinner", at(6), { ephemeral: 1 });
		activity("01R1", "01S1", "response", "Shipped the tabs", at(7));
		session("01S2", other.id, "codex", "awaiting_input", null, at(8));
		activity("01Q2", "01S2", "question", "Which store?", at(9));
		session("01S3", other.id, "codex", "complete", "loop:run-0", at(10));
		activity("01V1", "01S3", "verification", "gate green", at(11));
	});
	return { issue, other, loggedRef };
};

const rows = (base: string, table: string) =>
	withDb(base, (db) =>
		db
			.query<Record<string, unknown>, []>(
				`SELECT * FROM ${table} ORDER BY rowid`,
			)
			.all(),
	);

const tableNames = (base: string) =>
	withDb(base, (db) =>
		db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table'",
			)
			.all()
			.map((r) => r.name),
	);

const outcomesOf = async (base: string, taskId: string) =>
	must(await Planner.getEntries(base, taskId))
		.filter((e) => e.kind !== "comment")
		.map(({ id, kind, author, authorType, content, createdAt }) => ({
			id,
			kind,
			author,
			authorType,
			content,
			createdAt,
		}));

const EXPECTED_ISSUE_OUTCOMES: Awaited<ReturnType<typeof outcomesOf>> = [
	{
		id: "01D1",
		kind: "outcome.decision",
		author: "cabane://actor/human/ada",
		authorType: "human",
		content: "Plain text or markdown?\n→ Markdown",
		createdAt: at(3),
	},
	{
		id: "01D2",
		kind: "outcome.decision",
		author: "claude",
		authorType: "ai",
		content: "Going with SQLite",
		createdAt: at(4),
	},
	{
		id: "01F1",
		kind: "outcome.finding",
		author: "claude",
		authorType: "ai",
		content:
			"Severity: P2\nCategory: layout\nthe bar overflows\n\nContext: seen at 38 columns",
		createdAt: at(5),
	},
	{
		id: "01R1",
		kind: "outcome.summary",
		author: "claude",
		authorType: "ai",
		content: "Shipped the tabs",
		createdAt: at(7),
	},
];

describe("Migration session-outcomes on a database with session rows", () => {
	it("writes one entry per durable row and one session ref per session, drops both tables, and a second boot changes nothing", async () => {
		as(MIGRATOR);
		const base = await before("migrate");
		const { issue, other, loggedRef } = await seedLegacy(base);

		must(await Planner.init(base));

		expect(await outcomesOf(base, issue.id)).toEqual(EXPECTED_ISSUE_OUTCOMES);
		expect(await outcomesOf(base, other.id)).toEqual([
			{
				id: "01V1",
				kind: "outcome.verification",
				author: "codex",
				authorType: "ai",
				content: "gate green",
				createdAt: at(11),
			},
		]);
		const entries = (await rows(base, TABLES.comments)).filter(
			(r) => r.kind !== "comment",
		);
		// Every column comes from the source rows: the migrating device's actor
		// and clock appear nowhere.
		for (const entry of entries) {
			expect(entry.visibility).toBe("shared");
			expect(entry.updated_by).toBe(
				String(entry.author).startsWith("cabane://")
					? entry.author
					: `cabane://actor/agent/${entry.author}`,
			);
			expect(entry.version).toBe(1);
			expect(entry.updated_at).toBeNull();
		}

		expect(must(await Planner.getWorkLogs(base, issue.id))).toEqual([
			{
				id: "01S1",
				taskId: issue.id,
				refs: [
					{
						uri: "session:01S1",
						label: "claude",
						addedAt: T0,
						addedBy: "loop:run-1",
						addedByType: "ai",
					},
				],
				note: undefined,
				createdAt: T0,
			},
		]);
		// 01S3 was already named by the loop's own ref: no second one. Oldest first.
		expect(
			must(await Planner.getWorkLogs(base, other.id)).map((w) => ({
				id: w.id,
				refs: w.refs,
			})),
		).toEqual([
			{
				id: "01S2",
				refs: [
					{
						uri: "session:01S2",
						label: "codex",
						addedAt: at(8),
						addedBy: "codex",
						addedByType: "ai",
					},
				],
			},
			{ id: loggedRef.id, refs: loggedRef.refs },
		]);
		const migratedLog = (await rows(base, TABLES.work_log)).find(
			(r) => r.id === "01S1",
		);
		expect(migratedLog).toMatchObject({
			updated_by: "cabane://actor/agent/claude",
			visibility: "shared",
			version: 1,
		});

		const tables = await tableNames(base);
		expect(tables).not.toContain("agent_sessions");
		expect(tables).not.toContain("agent_activities");

		const brief = must(await Planner.assembleContext(base, issue.id));
		const discussion = brief.slice(brief.indexOf("## Discussion"));
		expect(discussion).toContain(
			"**cabane://actor/human/ada** (outcome.decision, human, 2026-10-01T10:03:00.000Z):\nPlain text or markdown?\n→ Markdown",
		);
		expect(discussion).toContain("**claude** (outcome.summary, ai, ");
		expect(discussion).toContain("Severity: P2");
		expect(discussion).toContain("HUMAN_STEERING");
		for (const stream of ["read the brief", "spinner", "AI_COMMENT_BEFORE"])
			expect(brief).not.toContain(stream);
		expect(brief).toContain("claude (session:01S1)");
		const otherBrief = must(await Planner.assembleContext(base, other.id));
		expect(otherBrief).not.toContain("Which store?");

		const snapshot = async () => ({
			comments: await rows(base, TABLES.comments),
			workLog: await rows(base, TABLES.work_log),
			oplog: await rows(base, TABLES.sync_oplog),
		});
		const first = await snapshot();
		must(await Planner.init(base));
		expect(await snapshot()).toEqual(first);
	});

	it("runs on a database with no session rows and only drops the tables", async () => {
		const base = await before("empty");
		const task = must(await Planner.addTask(base, { title: "quiet" }));
		must(await Planner.init(base));
		expect(must(await Planner.getEntries(base, task.id))).toEqual([]);
		expect(must(await Planner.getWorkLogs(base, task.id))).toEqual([]);
		expect(await tableNames(base)).not.toContain("agent_sessions");
	});
});

describe("Migration session-outcomes through sync", () => {
	/** A device that took no part in the session, fully migrated and armed. */
	const reader = async (name: string) => {
		const base = freshBase(name);
		must(await Planner.init(base));
		await arm(base, name);
		return base;
	};

	it("pushes what it wrote from a device armed before the migration, and a second device's brief shows it", async () => {
		const relay = LocalRelay.create();
		as(MIGRATOR);
		const alpha = await before("alpha");
		await arm(alpha, "alpha");
		const { issue } = await seedLegacy(alpha);
		must(await Planner.init(alpha));
		const captured = (await rows(alpha, TABLES.sync_oplog)).map(
			(op) => `${op.tbl}:${op.row_id}`,
		);
		for (const id of ["01D1", "01D2", "01F1", "01R1", "01V1"])
			expect(captured).toContain(`task_comments:${id}`);
		for (const id of ["01S1", "01S2"])
			expect(captured).toContain(`task_work_log:${id}`);
		must(await Sync.push(alpha, LocalRelay.transportFor(relay, "alpha")));

		const beta = await reader("beta");
		must(await Sync.pull(beta, LocalRelay.transportFor(relay, "beta")));
		expect(await outcomesOf(beta, issue.id)).toEqual(EXPECTED_ISSUE_OUTCOMES);
		const brief = must(await Planner.assembleContext(beta, issue.id));
		expect(brief).toContain("Plain text or markdown?\n→ Markdown");
		expect(brief).toContain("claude (session:01S1)");
		expect(brief).not.toContain("AI_COMMENT_BEFORE");
	});

	it("converges two devices that migrate copies of one database as different actors, row for row", async () => {
		const relay = LocalRelay.create();
		as("cabane://actor/human/alpha");
		const alpha = await before("copy-alpha");
		const { issue, other } = await seedLegacy(alpha);
		const beta = freshBase("copy-beta");
		// A copy of the file as it stands: VACUUM INTO carries what the WAL still holds.
		await withDb(alpha, (db) =>
			db.run("VACUUM INTO ?", [join(beta, TEST_DB_NAME)]),
		);
		await arm(alpha, "alpha");
		await arm(beta, "beta");
		must(await Planner.init(alpha));
		// Later, elsewhere, under another actor.
		await Bun.sleep(5);
		as("cabane://actor/human/beta");
		must(await Planner.init(beta));
		const a = LocalRelay.transportFor(relay, "alpha");
		const b = LocalRelay.transportFor(relay, "beta");
		// Both directions: each device's ops reach the other.
		must(await Sync.push(alpha, a));
		must(await Sync.push(beta, b));
		must(await Sync.pull(alpha, a));
		must(await Sync.pull(beta, b));
		must(await Sync.pull(alpha, a));

		for (const table of [TABLES.comments, TABLES.work_log])
			expect(await rows(alpha, table)).toEqual(await rows(beta, table));
		for (const id of [issue.id, other.id])
			expect(must(await Planner.assembleContext(alpha, id))).toBe(
				must(await Planner.assembleContext(beta, id)),
			);
		expect(await outcomesOf(alpha, issue.id)).toEqual(EXPECTED_ISSUE_OUTCOMES);
		const actors = (await rows(alpha, TABLES.comments))
			.filter((r) => r.kind !== "comment")
			.map((r) => r.updated_by);
		expect(actors).not.toContain("cabane://actor/human/alpha");
		expect(actors).not.toContain("cabane://actor/human/beta");
	});

	it("seeds the migrated rows by backfill on a device armed after the migration", async () => {
		const relay = LocalRelay.create();
		as(MIGRATOR);
		const alpha = await before("late");
		const { issue } = await seedLegacy(alpha);
		must(await Planner.init(alpha));
		expect(await rows(alpha, TABLES.sync_oplog)).toEqual([]);
		await arm(alpha, "alpha");
		must(await Backfill.run(alpha));
		must(await Sync.push(alpha, LocalRelay.transportFor(relay, "alpha")));

		const beta = await reader("late-beta");
		must(await Sync.pull(beta, LocalRelay.transportFor(relay, "beta")));
		expect(await outcomesOf(beta, issue.id)).toEqual(EXPECTED_ISSUE_OUTCOMES);
		expect(
			must(await Planner.getWorkLogs(beta, issue.id)).map((w) => w.id),
		).toEqual(["01S1"]);
	});
});

describe("Migration session-outcomes loses nothing quietly", () => {
	const version = async (base: string) =>
		withDb(
			base,
			(db) =>
				db
					.query<{ v: number }, []>(
						`SELECT max(version) AS v FROM ${TABLES.schema_migrations}`,
					)
					.get()?.v,
		);

	it("refuses a database that has agent_sessions but no agent_activities, and drops nothing", async () => {
		const base = await before("partial");
		const { other } = await seedLegacy(base);
		await withDb(base, (db) => db.run("DROP TABLE agent_activities"));

		const init = await Planner.init(base);

		expect(init.ok).toBe(false);
		if (!init.ok)
			expect(init.error.message).toContain(
				"session-outcomes: this database has no agent_activities table",
			);
		expect(await version(base)).toBe(BEFORE);
		expect(await tableNames(base)).toContain("agent_sessions");
		expect((await rows(base, "agent_sessions")).map((r) => r.id)).toEqual([
			"01S1",
			"01S2",
			"01S3",
		]);
		expect(await outcomesOf(base, other.id)).toEqual([]);
	});

	it("refuses an outcome whose id another comment holds, names the id, and keeps both", async () => {
		const base = await before("collision");
		const { issue } = await seedLegacy(base);
		await withDb(base, (db) =>
			db.run(
				`INSERT INTO ${TABLES.comments} (id, task_id, kind, author, author_type, content, created_at)
				 VALUES ('01D2', ?, 'comment', 'david', 'human', 'unrelated comment', ?)`,
				[issue.id, T0],
			),
		);

		const init = await Planner.init(base);

		expect(init.ok).toBe(false);
		if (!init.ok)
			expect(init.error.message).toContain(
				"task_comments already holds a different row with id 01D2",
			);
		expect(await version(base)).toBe(BEFORE);
		expect(await tableNames(base)).toContain("agent_activities");
		const held = (await rows(base, TABLES.comments)).filter(
			(r) => r.id === "01D2" || r.kind !== "comment",
		);
		expect(held.map((r) => [r.id, r.content])).toEqual([
			["01D2", "unrelated comment"],
		]);
	});

	it("keeps an outcome a row already holds as the same entry", async () => {
		const base = await before("same-entry");
		const { issue } = await seedLegacy(base);
		await withDb(base, (db) =>
			db.run(
				`INSERT INTO ${TABLES.comments} (id, task_id, kind, author, author_type, content, created_at)
				 VALUES ('01D2', ?, 'outcome.decision', 'claude', 'ai', 'Going with SQLite', ?)`,
				[issue.id, at(4)],
			),
		);
		must(await Planner.init(base));
		expect(await outcomesOf(base, issue.id)).toEqual(EXPECTED_ISSUE_OUTCOMES);
	});

	it("refuses a session whose id another work-log row holds, and keeps both", async () => {
		const base = await before("log-collision");
		const { issue } = await seedLegacy(base);
		// Under 01S2's id, on another issue, naming something else.
		await withDb(base, (db) =>
			db.run(
				`INSERT INTO ${TABLES.work_log} (id, task_id, refs, created_at)
				 VALUES ('01S2', ?, '[{"uri":"commit:abc","addedAt":"${T0}"}]', ?)`,
				[issue.id, T0],
			),
		);

		const init = await Planner.init(base);

		expect(init.ok).toBe(false);
		if (!init.ok)
			expect(init.error.message).toContain(
				"task_work_log already holds a different row with id 01S2",
			);
		expect(await tableNames(base)).toContain("agent_sessions");
		expect(
			(await rows(base, TABLES.comments)).filter((r) => r.kind !== "comment"),
		).toEqual([]);
	});
});
