import { describe, expect, it } from "bun:test";
import {
	UpsertUpstreamLinkInputSchema,
	UpstreamLinkSchema,
} from "./upstream-link";

const input = {
	taskId: "task-1",
	provider: "linear",
	externalId: "linear-uuid",
	identifier: "ENG-123",
	url: "https://linear.app/acme/issue/ENG-123/example",
	title: "Example feature",
	description: "Team-wide product context",
	state: "In Progress",
	externalUpdatedAt: "2026-07-18T12:00:00.000Z",
};

describe("UpstreamLink schema", () => {
	it("accepts an allowlisted snapshot with a soft provider", () => {
		const result = UpsertUpstreamLinkInputSchema.safeParse({
			...input,
			provider: "jira",
		});

		expect(result.success).toBe(true);
	});

	it("rejects arbitrary provider data and storage-owned fields", () => {
		const payloadResult = UpsertUpstreamLinkInputSchema.safeParse({
			...input,
			providerPayload: { privateTeamId: "secret" },
		});
		const storageOwnedFields = [
			{ id: "link-1" },
			{ refreshedAt: "2026-07-18T12:00:00.000Z" },
			{ createdAt: "2026-07-18T12:00:00.000Z" },
			{ updatedAt: "2026-07-18T12:00:00.000Z" },
		];

		expect(payloadResult.success).toBe(false);
		for (const field of storageOwnedFields) {
			expect(
				UpsertUpstreamLinkInputSchema.safeParse({ ...input, ...field }).success,
			).toBe(false);
		}
	});

	it("rejects non-web upstream URL schemes", () => {
		for (const url of [
			"javascript:alert(document.domain)",
			"data:text/html,<script>alert(1)</script>",
			"file:///tmp/private-issue.html",
		]) {
			expect(
				UpsertUpstreamLinkInputSchema.safeParse({ ...input, url }).success,
			).toBe(false);
		}
	});

	it("validates the complete stored record", () => {
		const result = UpstreamLinkSchema.safeParse({
			...input,
			id: "link-1",
			refreshedAt: "2026-07-18T12:01:00.000Z",
			createdAt: "2026-07-18T12:01:00.000Z",
			updatedAt: "2026-07-18T12:01:00.000Z",
		});

		expect(result.success).toBe(true);
	});
});
