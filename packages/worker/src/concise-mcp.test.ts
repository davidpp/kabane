import { SELF } from "cloudflare:test";
import { ContextPageSchema } from "@cabane/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import issues from "../../core/testing/fixtures/issue-corpus/issues.json";
import { HUMAN, withAccess } from "./test-access";

const toolResult = z.object({
	result: z.object({
		isError: z.boolean().optional(),
		content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
	}),
});
const pageSchema = z.object({
	items: z.array(
		z.object({
			id: z.string(),
			title: z.string(),
			state: z.string(),
			kind: z.string(),
			priority: z.string(),
		}),
	),
	hasMore: z.boolean(),
	nextCursor: z.string().optional(),
});
let requestId = 1;
const call = async (
	name: string,
	args: Record<string, unknown>,
	expectedError = false,
) => {
	const response = await SELF.fetch("https://cabane.test/mcp", {
		method: "POST",
		headers: withAccess(HUMAN, {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		}),
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: requestId++,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
	expect(response.status).toBe(200);
	const parsed = toolResult.safeParse(await response.json());
	expect(parsed.success).toBe(true);
	if (!parsed.success) return "";
	expect(Boolean(parsed.data.result.isError)).toBe(expectedError);
	return parsed.data.result.content.map((block) => block.text).join("");
};
const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("concise formats through authenticated Worker HTTP", () => {
	it("keeps auth/scope enforcement and enumerates the retained public corpus with bounded pages/receipts", async () => {
		const noAuth = await SELF.fetch("https://cabane.test/mcp", {
			method: "POST",
			body: "{}",
		});
		expect(noAuth.status).toBe(401);
		expect(
			await call(
				"kabane_add",
				{ title: "No scope", responseFormat: "concise" },
				true,
			),
		).toContain("scopeUri");
		const ids: string[] = [];
		for (const issue of issues) {
			const text = await call("kabane_add", {
				title: issue.title,
				description: issue.body,
				kind: "issue",
				state: "next",
				scopeUri: "worker-corpus",
				responseFormat: "concise",
			});
			expect(bytes(text)).toBeLessThanOrEqual(2048);
			expect(text).not.toContain('"description"');
			const receipt = z
				.object({ id: z.string(), version: z.number() })
				.safeParse(JSON.parse(text));
			expect(receipt.success).toBe(true);
			if (receipt.success) ids.push(receipt.data.id);
		}
		const fullArgs = { scopeUri: "worker-corpus", limit: 100 };
		const legacy = await call("kabane_list", fullArgs);
		expect(
			await call("kabane_list", { ...fullArgs, responseFormat: "full" }),
		).toBe(legacy);
		const seen: string[] = [];
		let cursor: string | undefined;
		let aggregate = 0;
		do {
			const text = await call("kabane_list", {
				scopeUri: "worker-corpus",
				responseFormat: "concise",
				cursor,
			});
			expect(bytes(text)).toBeLessThanOrEqual(16384);
			aggregate += bytes(text);
			const page = pageSchema.safeParse(JSON.parse(text));
			expect(page.success).toBe(true);
			if (!page.success) return;
			seen.push(...page.data.items.map((item) => item.id));
			cursor = page.data.nextCursor;
		} while (cursor);
		expect(seen.sort()).toEqual(ids.sort());
		expect(new Set(seen).size).toBe(24);
		expect(aggregate).toBeLessThan(bytes(legacy));
		const first = pageSchema.safeParse(
			JSON.parse(
				await call("kabane_list", {
					scopeUri: "worker-corpus",
					responseFormat: "concise",
					limit: 1,
				}),
			),
		);
		if (!first.success) return;
		await call("kabane_add", {
			title: "Unrelated",
			scopeUri: "elsewhere",
			responseFormat: "concise",
		});
		await call("kabane_list", {
			scopeUri: "worker-corpus",
			responseFormat: "concise",
			cursor: first.data.nextCursor,
		});
		await call(
			"kabane_list",
			{
				scopeUri: "elsewhere",
				responseFormat: "concise",
				cursor: first.data.nextCursor,
			},
			true,
		);
		const id = ids[0];
		if (!id) return;
		for (const action of ["edit", "done"] as const) {
			const text = await call(`kabane_${action}`, {
				id,
				...(action === "edit" ? { state: "in_progress" } : {}),
				responseFormat: "concise",
			});
			expect(bytes(text)).toBeLessThanOrEqual(2048);
			expect(text).not.toContain('"description"');
			expect(
				z
					.object({ id: z.string(), state: z.string(), version: z.number() })
					.safeParse(JSON.parse(text)).success,
			).toBe(true);
		}
		expect(
			await call(
				"kabane_list",
				{
					scopeUri: "worker-corpus",
					responseFormat: "concise",
					cursor: first.data.nextCursor,
				},
				true,
			),
		).toContain("Stale cursor");
		const rawGet = await call("kabane_get", { id });
		expect(rawGet).toContain('"description"');
		const searchText = await call("kabane_search", {
			query: "dataset",
			scopeUri: "worker-corpus",
			responseFormat: "concise",
		});
		expect(bytes(searchText)).toBeLessThanOrEqual(16384);
		expect(pageSchema.safeParse(JSON.parse(searchText)).success).toBe(true);
		await call("kabane_list", { responseFormat: "concise", limit: 101 }, true);
		await call(
			"kabane_search",
			{ query: "dataset", responseFormat: "concise", cursor: "bad" },
			true,
		);
	});
	it("bounds the final today response and every bucket with independent continuations", async () => {
		const day = new Date().toISOString().slice(0, 10);
		for (const bucket of ["overdue", "dueToday", "next"] as const)
			for (let index = 0; index < 25; index++) {
				await call("kabane_add", {
					title: `Synthetic ${bucket} ${index}` + "漢字\\\n".repeat(60),
					description: "Synthetic body ".repeat(5000),
					assignee: "a".repeat(2000),
					state: "next",
					scopeUri: "worker-today",
					dueDate:
						bucket === "overdue"
							? "2000-01-01"
							: bucket === "dueToday"
								? day
								: undefined,
					responseFormat: "concise",
				});
			}
		const firstText = await call("kabane_today", {
			scopeUri: "worker-today",
			responseFormat: "concise",
			limit: 100,
		});
		expect(bytes(firstText)).toBeLessThanOrEqual(16384);
		const first = z
			.object({ overdue: pageSchema, dueToday: pageSchema, next: pageSchema })
			.safeParse(JSON.parse(firstText));
		expect(first.success).toBe(true);
		if (!first.success) return;
		for (const bucket of ["overdue", "dueToday", "next"] as const) {
			const seen = first.data[bucket].items.map((item) => item.id);
			let cursor = first.data[bucket].nextCursor;
			expect(cursor).toBeDefined();
			while (cursor) {
				const text = await call("kabane_today", {
					scopeUri: "worker-today",
					responseFormat: "concise",
					limit: 100,
					cursors: { [bucket]: cursor },
				});
				expect(bytes(text)).toBeLessThanOrEqual(16384);
				const page = z
					.object({
						overdue: pageSchema,
						dueToday: pageSchema,
						next: pageSchema,
					})
					.safeParse(JSON.parse(text));
				expect(page.success).toBe(true);
				if (!page.success) return;
				seen.push(...page.data[bucket].items.map((item) => item.id));
				cursor = page.data[bucket].nextCursor;
			}
			expect(new Set(seen).size).toBe(25);
		}
	}, 30_000);
	it("streams complete replicated context with bounded Unicode chunks, section selection and stale protection", async () => {
		const issue = issues[0];
		if (!issue) return;
		const description = `${issue.body}\n${'🧭漢字"\\\n'.repeat(10000)}`;
		const created = z.object({ id: z.string() }).safeParse(
			JSON.parse(
				await call("kabane_add", {
					title: issue.title,
					description,
					kind: "issue",
					scopeUri: "worker-context",
					responseFormat: "concise",
				}),
			),
		);
		expect(created.success).toBe(true);
		if (!created.success) return;
		const id = created.data.id;
		const comments = [
			"EARLY_REQUIRED_STEERING",
			...issue.comments,
			'GIANT_HUMAN 🐛"\\\n'.repeat(12000),
			"LATE_REQUIRED_STEERING",
		];
		for (const content of comments)
			await call("kabane_comment", { id, content });
		const refNote = "HUGE_REF_NOTE 🧭 ".repeat(2000);
		await call("kabane_contextAdd", {
			id,
			kind: "spec",
			uri: "url:https://example.test/spec",
			note: refNote,
		});
		await call("kabane_log", {
			id,
			refs: [{ uri: "commit:replicated" }],
			note: "PRIOR_WORK 🧪 ".repeat(2000),
		});
		const args = { id, deref: false, includeSubtasks: true };
		const legacy = await call("kabane_context", args);
		expect(
			await call("kabane_context", { ...args, responseFormat: "full" }),
		).toBe(legacy);
		const full = z
			.object({ markdown: z.string() })
			.safeParse(JSON.parse(legacy));
		if (!full.success) return;
		let markdown = "";
		let cursor: string | undefined;
		let firstCursor: string | undefined;
		let calls = 0;
		do {
			const text = await call("kabane_context", {
				...args,
				responseFormat: "concise",
				cursor,
			});
			expect(bytes(text)).toBeLessThanOrEqual(16384);
			expect(text.startsWith('{"completeness":')).toBe(true);
			const page = ContextPageSchema.safeParse(JSON.parse(text));
			expect(page.success).toBe(true);
			if (!page.success) return;
			expect(page.data.offset).toBe(markdown.length);
			expect(page.data.taskId).toBe(id);
			expect(page.data.markdown).not.toMatch(/[\ud800-\udbff]$/u);
			expect(page.data.markdown).not.toMatch(/^[\udc00-\udfff]/u);
			expect(page.data.completeness.selectedComplete).toBe(
				page.data.nextCursor === undefined,
			);
			if (calls === 0) {
				firstCursor = page.data.nextCursor;
				expect(page.data.completeness.descriptionComplete).toBe(false);
				expect(page.data.completeness.humanSteeringComplete).toBe(false);
			}
			if (!page.data.nextCursor)
				expect(page.data.completeness.humanSteeringComplete).toBe(true);
			markdown += page.data.markdown;
			cursor = page.data.nextCursor;
			calls++;
			expect(calls).toBeLessThan(100);
		} while (cursor);
		expect(markdown).toBe(full.data.markdown);
		expect(markdown).toContain(description);
		expect(markdown).toContain(refNote);
		for (const comment of comments) expect(markdown).toContain(comment);
		let selected = "";
		cursor = undefined;
		do {
			const text = await call("kabane_context", {
				...args,
				responseFormat: "concise",
				sections: ["description", "description"],
				cursor,
			});
			expect(bytes(text)).toBeLessThanOrEqual(16384);
			const page = ContextPageSchema.safeParse(JSON.parse(text));
			if (!page.success) return;
			expect(page.data.completeness.humanSteeringComplete).toBe(false);
			expect(page.data.completeness.omittedSections).toContain("discussion");
			selected += page.data.markdown;
			cursor = page.data.nextCursor;
		} while (cursor);
		// Same selected-description contract as the local CLI over the retained corpus.
		expect(selected).toBe(`## Description\n\n${description}`);
		expect(
			await call(
				"kabane_context",
				{ ...args, responseFormat: "concise", cursor: "{" },
				true,
			),
		).toContain("cursor");
		expect(
			await call(
				"kabane_context",
				{
					...args,
					responseFormat: "concise",
					cursor: firstCursor,
					sections: ["discussion"],
				},
				true,
			),
		).toContain("mismatched");
		await call("kabane_comment", { id, content: "NEW_REQUIRED_STEERING" });
		expect(
			await call(
				"kabane_context",
				{ ...args, responseFormat: "concise", cursor: firstCursor },
				true,
			),
		).toContain("Stale context cursor");
	}, 60000);
});
