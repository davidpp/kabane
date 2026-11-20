/** End-to-end smoke over the bun:sqlite adapter. */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, Runtime, TABLES } from "@kabane/core";
import { configureTestRuntime } from "@kabane/core/testing";
import { SqliteDb } from "./index";

const DB_NAME = "smoke.db";

const unwrap = <T>(
	result: { ok: true; value: T } | { ok: false; error: Error },
): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const tableNames = (base: string): string[] => {
	const db = new Database(SqliteDb.pathFor(base, DB_NAME), { readonly: true });
	try {
		return (
			db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
				name: string;
			}[]
		).map((r) => r.name);
	} finally {
		db.close();
	}
};

describe("storage over bun:sqlite", () => {
	let base: string;

	beforeEach(async () => {
		base = join(tmpdir(), `kabane-smoke-${crypto.randomUUID()}`);
		mkdirSync(base, { recursive: true });
		Runtime.configure({ provider: SqliteDb.provider({ dbName: DB_NAME }) });
		unwrap(await Planner.init(base));
	});

	// Every test file shares this process's Runtime. Left on smoke.db, a later
	// file's tracker would sit where a real child process (default runtime) cannot see it.
	afterEach(() => {
		configureTestRuntime();
		rmSync(base, { recursive: true, force: true });
	});

	it("creates the schema", () => {
		const names = tableNames(base);
		expect(names).toContain(TABLES.tasks);
		expect(names).toContain(TABLES.tasks_fts);
		expect(names).not.toContain("agent_sessions");
		expect(names).not.toContain("agent_activities");
	});

	it("adds, links, searches, records an outcome and a session ref, and assembles a brief", async () => {
		const parent = unwrap(
			await Planner.addTask(base, {
				title: "Extract the planner into Kabane",
				description: "Db port over bun:sqlite and Durable Object SQLite",
				kind: "issue",
				scopeUri: "cabane",
			}),
		);
		const child = unwrap(
			await Planner.addTask(base, {
				title: "Write the bun:sqlite adapter",
				kind: "issue",
				scopeUri: "cabane",
				parentTaskId: parent.id,
			}),
		);
		expect(parent.shortId).toMatch(/^JCAB-\d+$/);

		unwrap(
			await Planner.addLink(base, {
				sourceId: child.id,
				targetId: parent.id,
				type: "blocks",
			}),
		);
		const links = unwrap(await Planner.getLinksForTask(base, parent.id));
		expect(links.map((l) => l.type)).toContain("blocks");

		const found = unwrap(await Planner.searchTasks(base, "Durable"));
		expect(found.map((t) => t.id)).toContain(parent.id);

		unwrap(
			await Planner.addWorkLog(base, {
				taskId: child.id,
				refs: [{ uri: "session:01SMOKE", label: "claude" }],
			}),
		);
		unwrap(
			await Planner.addEntry(base, {
				taskId: child.id,
				kind: "outcome.finding",
				author: "claude",
				authorType: "ai",
				content: "Severity: P2\nthe adapter is a pass-through",
			}),
		);

		unwrap(
			await Planner.addComment(base, {
				taskId: child.id,
				author: "david",
				authorType: "human",
				content: "keep the public names",
			}),
		);

		const brief = unwrap(await Planner.assembleContext(base, child.id));
		expect(brief).toContain("Write the bun:sqlite adapter");
		expect(brief).toContain("keep the public names");
		expect(brief).toContain("the adapter is a pass-through");
		expect(brief).toContain("claude (session:01SMOKE)");
	});

	it("is idempotent on re-init", async () => {
		unwrap(await Planner.init(base));
		const stats = unwrap(await Planner.stats(base));
		expect(stats).toBeDefined();
	});
});
