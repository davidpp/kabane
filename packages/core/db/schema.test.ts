import { describe, expect, it } from "bun:test";
import { generateFtsSql } from "./schema";

describe("generateFtsSql", () => {
	it("names the virtual table and its triggers after the table they index", () => {
		const sql = generateFtsSql({
			name: "tasks_fts",
			sourceTable: "tasks",
			columns: ["title", "tags"],
		});
		expect(sql).toContain(
			"CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(",
		);
		expect(sql).toContain("content='tasks'");
		expect(sql).toContain(
			"CREATE TRIGGER IF NOT EXISTS tasks_fts_au AFTER UPDATE ON tasks",
		);
	});
});
