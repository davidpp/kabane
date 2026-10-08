import { describe, expect, it } from "bun:test";
import { TaskSchema } from "./schemas";
import {
	RECEIPT_BYTES,
	serializedBytes,
	taskReceipt,
	taskSummary,
} from "./task-output";

const example = () =>
	TaskSchema.safeParse({
		id: "01AAAAAAAAAAAAAAAAAAAAAAAA",
		shortId: "JTST-1",
		title: '🐛漢字"\n\\'.repeat(60),
		kind: "issue",
		state: "next",
		priority: "high",
		assignee: "🧭\n".repeat(10000),
		scopeUri: 'scope"'.repeat(10000),
		description: "SECRET_BODY",
		provenance: { source: "human", discoveredAt: "2025-01-01T00:00:00.000Z" },
		createdAt: "2025-01-01T00:00:00.000Z",
		updatedAt: "2025-01-01T00:00:00.000Z",
		version: 4,
	});
describe("concise projections", () => {
	it("preserves identity, signals every preview, bounds JSON escaping and Unicode", () => {
		const task = example();
		expect(task.success).toBe(true);
		if (!task.success) return;
		const summary = taskSummary(task.data);
		expect(summary.ok).toBe(true);
		if (!summary.ok) return;
		expect(summary.value.id).toBe(task.data.id);
		expect(summary.value.shortId).toBe(task.data.shortId);
		expect(summary.value.truncatedFields).toEqual([
			"title",
			"assignee",
			"scopeUri",
		]);
		expect(serializedBytes(summary.value)).toBeLessThanOrEqual(RECEIPT_BYTES);
		expect(JSON.stringify(summary.value)).not.toContain("SECRET_BODY");
		expect(JSON.stringify(summary.value)).not.toContain("provenance");
		expect(summary.value.title).not.toContain("\uFFFD");
		const receipt = taskReceipt(task.data);
		expect(receipt.ok).toBe(true);
		if (!receipt.ok) return;
		expect(receipt.value.version).toBe(4);
		expect(receipt.value.state).toBe("next");
		expect(receipt.value.fullRead).toContain("kabane_get");
		expect(serializedBytes(receipt.value)).toBeLessThanOrEqual(RECEIPT_BYTES);
	});
	it("shrinks previews, not identity, when required metadata consumes the receipt budget", () => {
		const task = example();
		expect(task.success).toBe(true);
		if (!task.success) return;
		const receipt = taskReceipt({
			...task.data,
			id: "x".repeat(1800),
			state: "in_progress",
			version: 999999,
		});
		expect(receipt.ok).toBe(true);
		if (!receipt.ok) return;
		expect(receipt.value.id).toHaveLength(1800);
		expect(receipt.value.truncatedFields).toContain("title");
		expect(serializedBytes(receipt.value)).toBeLessThanOrEqual(RECEIPT_BYTES);
	});
	it("never truncates irreducible IDs or short labels, and never echoes them in errors", () => {
		const task = example();
		expect(task.success).toBe(true);
		if (!task.success) return;
		for (const identity of [
			{ id: "x".repeat(20000) },
			{ shortId: "x".repeat(20000) },
		]) {
			const oversized = { ...task.data, ...identity };
			for (const result of [taskSummary(oversized), taskReceipt(oversized)]) {
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error.message.length).toBeLessThan(200);
					expect(result.error.message).toContain("full");
					expect(result.error.message).toContain("no mutation occurred");
				}
			}
		}
	});
});
