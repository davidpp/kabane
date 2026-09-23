/**
 * Existing-DB upgrade path for the S4a session tables (JJAK-960).
 *
 * jake's historical schema breakages all lived on the new-code-meets-old-DB
 * boundary (boot-order, see db-registration.ts note near idx_tasks_short_id).
 * This simulates a pre-S4a database — tables present, session tables absent —
 * then runs the normal init path and asserts the additive SCHEMA_SQL route
 * upgrades it correctly without touching existing data.
 */
import "../testing";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import type { TaskDraft } from "../schemas";
import { Planner } from "./index";

const TEST_BASE = join(import.meta.dir, ".test-data-sessions-upgrade");
const DB_PATH = join(TEST_BASE, "kabane.db");

const draft: TaskDraft = { title: "Pre-upgrade task", kind: "issue" };

const tableNames = (db: Database): string[] =>
	(
		db
			.query("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as Array<{ name: string }>
	).map((r) => r.name);

describe("session tables on an existing (pre-S4a) database", () => {
	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });

		// Full current init, then drop the session tables to simulate a DB
		// created before S4a existed (faithful for the IF NOT EXISTS path:
		// the tables are simply absent), and the version table, which a
		// database from before the migration runner does not have either.
		const init = await Planner.init(TEST_BASE);
		if (!init.ok) throw new Error("init failed");
		const db = new Database(DB_PATH);
		try {
			db.run("DROP TABLE IF EXISTS agent_activities");
			db.run("DROP TABLE IF EXISTS agent_sessions");
			db.run("DROP TABLE IF EXISTS schema_migrations");
		} finally {
			db.close();
		}
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	it("re-init creates the session tables and preserves existing task data", async () => {
		// Seed pre-upgrade data while the session tables are absent.
		const added = await Planner.addTask(TEST_BASE, draft);
		expect(added.ok).toBe(true);
		if (!added.ok) return;

		const reinit = await Planner.init(TEST_BASE);
		expect(reinit.ok).toBe(true);

		const db = new Database(DB_PATH);
		try {
			const names = tableNames(db);
			expect(names).toContain("agent_sessions");
			expect(names).toContain("agent_activities");

			// Existing data untouched.
			const task = db
				.query("SELECT title FROM tasks WHERE id = ?")
				.get(added.value.id) as { title: string } | null;
			expect(task?.title).toBe("Pre-upgrade task");
		} finally {
			db.close();
		}
	});

	it("FK between the two new tables enforces after upgrade", async () => {
		const reinit = await Planner.init(TEST_BASE);
		expect(reinit.ok).toBe(true);

		const taskId = await (async () => {
			const r = await Planner.addTask(TEST_BASE, draft);
			if (!r.ok) throw new Error("task create failed");
			return r.value.id;
		})();

		// Bogus session_id must be rejected by the rewritten FK.
		const bogus = await Planner.addActivity(TEST_BASE, {
			sessionId: "01AAAAAAAAAAAAAAAAAAAAAAAA",
			type: "progress",
			body: "orphan",
		});
		expect(bogus.ok).toBe(false);

		// Cascade: deleting the session removes its activities.
		const started = await Planner.startSession(TEST_BASE, {
			taskId,
			agent: "claude",
		});
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const act = await Planner.addActivity(TEST_BASE, {
			sessionId: started.value.id,
			type: "finding",
			severity: "P2",
			body: "cascades",
		});
		expect(act.ok).toBe(true);

		const db = new Database(DB_PATH);
		try {
			db.run("PRAGMA foreign_keys = ON");
			db.run("DELETE FROM agent_sessions WHERE id = ?", [started.value.id]);
			const left = db
				.query(
					"SELECT COUNT(*) AS n FROM agent_activities WHERE session_id = ?",
				)
				.get(started.value.id) as { n: number };
			expect(left.n).toBe(0);
		} finally {
			db.close();
		}
	});
});
