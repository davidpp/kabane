import { describe, expect, it } from "bun:test";
import { TaskDraftSchema, TaskSchema } from "./task";

const base = {
	id: "01H000000000000000000000AA",
	title: "Wire the board",
	provenance: { source: "human", discoveredAt: "2026-09-07T00:00:00.000Z" },
	createdAt: "2026-09-07T00:00:00.000Z",
	updatedAt: "2026-09-07T00:00:00.000Z",
};

describe("TaskSchema replication fields", () => {
	it("accepts updatedBy and version as read back from storage", () => {
		const parsed = TaskSchema.safeParse({
			...base,
			updatedBy: "cabane://actor/human/tester",
			version: 3,
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.updatedBy).toBe("cabane://actor/human/tester");
			expect(parsed.data.version).toBe(3);
		}
	});

	it("tolerates rows written before the columns existed", () => {
		const parsed = TaskSchema.safeParse(base);
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect(parsed.data.updatedBy).toBeUndefined();
			expect(parsed.data.version).toBeUndefined();
		}
	});

	it("rejects a version below 1", () => {
		expect(TaskSchema.safeParse({ ...base, version: 0 }).success).toBe(false);
	});

	it("keeps both fields storage-owned: drafts strip them", () => {
		const parsed = TaskDraftSchema.safeParse({
			title: "Draft",
			updatedBy: "cabane://actor/human/tester",
			version: 9,
		});
		expect(parsed.success).toBe(true);
		if (parsed.success) {
			expect("updatedBy" in parsed.data).toBe(false);
			expect("version" in parsed.data).toBe(false);
		}
	});
});
