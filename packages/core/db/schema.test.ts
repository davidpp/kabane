import { describe, expect, it } from "bun:test";
import { generateFtsSql, prefixSql } from "./schema";

describe("prefixSql", () => {
	const ddl = `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id));
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE UNIQUE INDEX IF NOT EXISTS uq ON tasks(short_id);`;

	it("is the identity with no prefix", () => {
		expect(prefixSql(ddl, "")).toBe(ddl);
	});

	it("prefixes tables, indexes, references and ON targets", () => {
		const out = prefixSql(ddl, "planner_");
		expect(out).toContain("CREATE TABLE IF NOT EXISTS planner_tasks");
		expect(out).toContain("REFERENCES planner_projects(id)");
		expect(out).toContain(
			"CREATE INDEX IF NOT EXISTS planner_idx_tasks_state ON planner_tasks(state)",
		);
		expect(out).toContain(
			"CREATE UNIQUE INDEX IF NOT EXISTS planner_uq ON planner_tasks(short_id)",
		);
	});
});

describe("generateFtsSql", () => {
	it("names the virtual table and triggers under the prefix", () => {
		const sql = generateFtsSql("p_", {
			name: "tasks_fts",
			sourceTable: "tasks",
			columns: ["title", "tags"],
		});
		expect(sql).toContain(
			"CREATE VIRTUAL TABLE IF NOT EXISTS p_tasks_fts USING fts5(",
		);
		expect(sql).toContain("content='p_tasks'");
		expect(sql).toContain(
			"CREATE TRIGGER IF NOT EXISTS p_tasks_fts_au AFTER UPDATE ON p_tasks",
		);
	});
});
