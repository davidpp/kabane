import { afterEach, describe, expect, it } from "bun:test";
import { physicalTable, setTablePrefix, TABLES, tablePrefix } from "./tables";

describe("TABLES", () => {
	afterEach(() => setTablePrefix(""));

	it("resolves plain names by default", () => {
		setTablePrefix("");
		expect(TABLES.tasks).toBe("tasks");
		expect(TABLES.comments).toBe("task_comments");
		expect(physicalTable("sync_oplog")).toBe("sync_oplog");
	});

	it("picks up a prefix set after import", () => {
		setTablePrefix("planner_");
		expect(tablePrefix()).toBe("planner_");
		expect(TABLES.tasks).toBe("planner_tasks");
		expect(TABLES.agent_activities).toBe("planner_agent_activities");
	});
});
