/**
 * The tool surface, driven two ways: handlers called directly against a
 * scratch database, and the full server over an in-memory MCP transport
 * (initialize, tools/list, tools/call) so the wire shape is what a client sees.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { err, type Result } from "../result";
import { Runtime } from "../runtime";
import type { Task, TaskComment, TaskWorkLog } from "../schemas";
import { Planner } from "../storage";
import { configureTestRuntime } from "../testing";
import { createMcpServer } from "./server";
import { KABANE_TOOLS, type ToolContext, type ToolDef } from "./tools";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const tool = (name: string): ToolDef => {
	const found = KABANE_TOOLS.find((t) => t.name === name);
	if (!found) throw new Error(`no tool ${name}`);
	return found;
};

const AGENT = "cabane://actor/agent/hermes";
const COMMENT_ALIASES = ["body", "text", "content"];
const COMMENT_CONFLICTS = [
	{ body: "a", text: "b" },
	{ body: "a", content: "b" },
	{ text: "a", content: "b" },
	{ body: "a", text: "a", content: "b" },
	{ body: "a", text: "b", content: "a" },
	{ body: "b", text: "a", content: "a" },
	{ body: "a", text: "b", content: "c" },
	{ body: "a", text: " a" },
	{ body: "a\n", content: "a" },
];

describe("cabane tools", () => {
	let base: string;
	let ctx: ToolContext;

	beforeEach(async () => {
		base = join(tmpdir(), `cabane-mcp-${crypto.randomUUID()}`);
		mkdirSync(base, { recursive: true });
		configureTestRuntime("", { actor: () => AGENT });
		unwrap(await Planner.init(base));
		ctx = { basePath: base, actor: AGENT, scopeRequired: true };
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	it("refuses a scopeless write when scope is required, and names the fix", async () => {
		const result = await tool("kabane_add").handler({ title: "x" }, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("kabane_scopeList");
	});

	it("falls back to the default scope when one is configured", async () => {
		const withDefault = { ...ctx, defaultScope: "demo" };
		const created = unwrap(
			await tool("kabane_add").handler({ title: "scoped" }, withDefault),
		) as Task;
		expect(created.scopeUri).toBe("jake://scope/demo");
		expect(created.updatedBy).toBe(AGENT);
		expect(created.provenance.source).toBe("ai");
	});

	it("takes a due date as YYYY-MM-DD or an ISO datetime, and names the fix for anything else", async () => {
		const scoped = { ...ctx, defaultScope: "demo" };
		const byDate = unwrap(
			await tool("kabane_add").handler(
				{ title: "by date", dueDate: "2026-02-06" },
				scoped,
			),
		) as Task;
		expect(byDate.deadline).toBe("2026-02-06");
		const byTime = unwrap(
			await tool("kabane_add").handler(
				{ title: "by time", dueDate: "2026-02-06T10:00:00Z" },
				scoped,
			),
		) as Task;
		expect(byTime.deadline).toBe("2026-02-06T10:00:00.000Z");
		configureTestRuntime("", { timezone: () => "America/Montreal" });
		try {
			const byLocalTime = unwrap(
				await tool("kabane_add").handler(
					{ title: "by local time", dueDate: "2026-02-06T17:00" },
					scoped,
				),
			) as Task;
			expect(byLocalTime.deadline).toBe("2026-02-06T22:00:00.000Z");
		} finally {
			configureTestRuntime();
		}
		const bad = await tool("kabane_edit").handler(
			{ id: byTime.id, dueDate: "friday" },
			scoped,
		);
		expect(bad.ok).toBe(false);
		if (!bad.ok)
			expect(bad.error.message).toContain("YYYY-MM-DD or an ISO datetime");
	});

	it("runs the pickup flow: add, list by assignee, context, edit, log, comment, done", async () => {
		const issue = unwrap(
			await tool("kabane_add").handler(
				{
					title: "Wire the hub",
					kind: "issue",
					state: "next",
					assignee: "hermes",
					scopeUri: "cabane",
					description: "The brief.",
				},
				ctx,
			),
		) as Task;
		expect(issue.shortId).toMatch(/^JCAB-\d+$/);

		const queue = unwrap(
			await tool("kabane_list").handler(
				{ assignee: "hermes", state: "next" },
				ctx,
			),
		) as Task[];
		expect(queue.map((t) => t.id)).toEqual([issue.id]);

		const brief = unwrap(
			await tool("kabane_context").handler({ id: issue.shortId ?? "" }, ctx),
		) as { markdown: string };
		expect(brief.markdown).toContain("Wire the hub");
		expect(brief.markdown).toContain("The brief.");

		const claimed = unwrap(
			await tool("kabane_edit").handler(
				{ id: issue.shortId ?? "", state: "in_progress" },
				ctx,
			),
		) as Task;
		expect(claimed.state).toBe("in_progress");
		expect(claimed.version).toBe(2);

		unwrap(
			await tool("kabane_log").handler(
				{ id: issue.id, refs: [{ uri: "commit:abc123" }], note: "landed" },
				ctx,
			),
		);
		unwrap(
			await tool("kabane_comment").handler(
				{ id: issue.id, content: "done, see the commit" },
				ctx,
			),
		);
		const logs = unwrap(await Planner.getWorkLogs(base, issue.id));
		expect(logs[0]?.refs[0]?.addedByType).toBe("ai");
		const comments = unwrap(await Planner.getComments(base, issue.id));
		expect(comments[0]?.authorType).toBe("ai");

		const finished = unwrap(
			await tool("kabane_done").handler({ id: issue.id }, ctx),
		) as Task;
		expect(finished.state).toBe("done");
	});

	it("preserves Markdown and authors for every comment alias and identical combination", async () => {
		const issue = unwrap(await Planner.addTask(base, { title: "Comments" }));
		const markdown = "  ## Kept verbatim\n\n```ts\nconst x = 1;\n```\n";
		const combinations = [
			["body"],
			["text"],
			["content"],
			["body", "text"],
			["body", "content"],
			["text", "content"],
			COMMENT_ALIASES,
		];
		for (const aliases of combinations) {
			const comment = unwrap(
				await tool("kabane_comment").handler(
					{
						id: issue.id,
						...Object.fromEntries(aliases.map((alias) => [alias, markdown])),
					},
					ctx,
				),
			) as TaskComment;
			expect(comment.content).toBe(markdown);
			expect(comment.author).toBe(AGENT);
			expect(comment.authorType).toBe("ai");
			expect(unwrap(await Planner.getComment(base, comment.id))).toEqual(
				comment,
			);
		}
		expect(unwrap(await Planner.getComments(base, issue.id))).toHaveLength(7);
	});

	it("rejects missing or differing write inputs before any storage or ID lookup", async () => {
		let accesses = 0;
		Runtime.configure({
			provider: {
				withDb: async () => {
					accesses++;
					return err(new Error("Storage must not be reached"));
				},
			},
		});
		try {
			for (const args of [{}, ...COMMENT_CONFLICTS]) {
				const result = await tool("kabane_comment").handler(
					{ id: "JCAB-999", ...args },
					ctx,
				);
				expect(result.ok).toBe(false);
				if (!result.ok) {
					expect(result.error.message).toContain("body");
					expect(result.error.message).toContain("supply");
				}
			}
			const missingLog = await tool("kabane_log").handler(
				{ id: "JCAB-999" },
				ctx,
			);
			expect(missingLog.ok).toBe(false);
			if (!missingLog.ok)
				expect(missingLog.error.message).toContain("supply commit");
			expect(accesses).toBe(0);
		} finally {
			configureTestRuntime("", { actor: () => AGENT });
		}
	});

	it("normalizes commit shorthand without changing explicit refs, labels or duplicates", async () => {
		const issue = unwrap(await Planner.addTask(base, { title: "Work logs" }));
		const labeled = { uri: "commit:abc123", label: "Kept label" };
		const explicit = [labeled, { uri: "file:src/index.ts" }];
		const cases = [
			{ args: { refs: explicit }, refs: explicit },
			{ args: { refs: [labeled, labeled] }, refs: [labeled, labeled] },
			{ args: { commit: "abc123" }, refs: [{ uri: "commit:abc123" }] },
			{ args: { commit: "HEAD~1" }, refs: [{ uri: "commit:HEAD~1" }] },
			{
				args: { refs: explicit, commit: "def456" },
				refs: [...explicit, { uri: "commit:def456" }],
			},
			{ args: { refs: explicit, commit: "abc123" }, refs: explicit },
			{
				args: { refs: [labeled, labeled], commit: "abc123" },
				refs: [labeled, labeled],
			},
		];
		for (const { args, refs } of cases) {
			const entry = unwrap(
				await tool("kabane_log").handler(
					{ id: issue.id, ...args, note: "Summary" },
					ctx,
				),
			) as TaskWorkLog;
			expect(entry.refs.map(({ uri, label }) => ({ uri, label }))).toEqual(
				refs.map((ref) => ({
					uri: ref.uri,
					label: "label" in ref ? ref.label : undefined,
				})),
			);
			expect(entry.note).toBe("Summary");
			for (const ref of entry.refs) {
				expect(ref.addedBy).toBe(AGENT);
				expect(ref.addedByType).toBe("ai");
			}
			expect(
				unwrap(await Planner.getWorkLogs(base, issue.id)).find(
					(log) => log.id === entry.id,
				),
			).toEqual(entry);
		}
		expect(explicit).toHaveLength(2);
		expect(unwrap(await Planner.getWorkLogs(base, issue.id))).toHaveLength(
			cases.length,
		);
	});

	it("links, searches, lists scopes, and manages context refs", async () => {
		const a = unwrap(
			await tool("kabane_add").handler(
				{ title: "Alpha durable", scopeUri: "one" },
				ctx,
			),
		) as Task;
		const b = unwrap(
			await tool("kabane_add").handler({ title: "Beta", scopeUri: "two" }, ctx),
		) as Task;

		unwrap(
			await tool("kabane_link").handler(
				{ sourceId: a.id, targetId: b.id, type: "blocks" },
				ctx,
			),
		);
		const links = unwrap(await Planner.getLinksForTask(base, b.id));
		expect(links.map((l) => l.type)).toContain("blocks");

		const found = unwrap(
			await tool("kabane_search").handler({ query: "durable" }, ctx),
		) as Task[];
		expect(found.map((t) => t.id)).toEqual([a.id]);

		const scopes = unwrap(await tool("kabane_scopeList").handler({}, ctx)) as {
			scopeId: string;
			count: number;
		}[];
		expect(scopes.map((s) => s.scopeId).sort()).toEqual(["one", "two"]);

		const ref = unwrap(
			await tool("kabane_contextAdd").handler(
				{ id: a.id, uri: "file:docs/auth.md", kind: "ADR" },
				ctx,
			),
		) as { id: string };
		const listed = unwrap(
			await tool("kabane_contextList").handler({ id: a.id }, ctx),
		) as { id: string }[];
		expect(listed.map((r) => r.id)).toEqual([ref.id]);
		unwrap(await tool("kabane_contextRemove").handler({ refId: ref.id }, ctx));
		expect(
			unwrap(await tool("kabane_contextList").handler({ id: a.id }, ctx)),
		).toEqual([]);

		const today = unwrap(await tool("kabane_today").handler({}, ctx)) as {
			next: Task[];
		};
		expect(Array.isArray(today.next)).toBe(true);
	});

	// parentTaskId 'none' used to write an empty string. Every JS reader sees
	// undefined either way, so the break only shows in SQL: '' IS NULL is false,
	// and topLevelOnly filters on IS NULL — a detached task fell out of both
	// sides of the tree.
	it("detaches a subtask to NULL, not an empty string", async () => {
		const parent = unwrap(
			await tool("kabane_add").handler(
				{ title: "Parent", scopeUri: "cabane" },
				ctx,
			),
		) as Task;
		const child = unwrap(
			await tool("kabane_add").handler(
				{ title: "Child", scopeUri: "cabane", parentTaskId: parent.id },
				ctx,
			),
		) as Task;
		expect(child.parentTaskId).toBe(parent.id);

		const detached = unwrap(
			await tool("kabane_edit").handler(
				{ id: child.id, parentTaskId: "none" },
				ctx,
			),
		) as Task;
		expect(detached.parentTaskId).toBeUndefined();

		const topLevel = unwrap(
			await Planner.queryTasks(base, { topLevelOnly: true }),
		);
		expect(topLevel.map((t) => t.id).sort()).toEqual(
			[parent.id, child.id].sort(),
		);
		expect(
			unwrap(await Planner.queryTasks(base, { parentTaskId: parent.id })),
		).toEqual([]);
	});

	it("leaves the parent alone when the edit omits it", async () => {
		const parent = unwrap(
			await tool("kabane_add").handler(
				{ title: "Parent", scopeUri: "cabane" },
				ctx,
			),
		) as Task;
		const child = unwrap(
			await tool("kabane_add").handler(
				{ title: "Child", scopeUri: "cabane", parentTaskId: parent.id },
				ctx,
			),
		) as Task;

		const edited = unwrap(
			await tool("kabane_edit").handler(
				{ id: child.id, title: "Renamed" },
				ctx,
			),
		) as Task;
		expect(edited.parentTaskId).toBe(parent.id);
	});

	it("reports an unknown id as a tool error, not a throw", async () => {
		const result = await tool("kabane_get").handler({ id: "JCAB-999" }, ctx);
		expect(result.ok).toBe(false);
	});
	it("links and unlinks an external issue by the pair that made it", async () => {
		const task = unwrap(
			await tool("kabane_add").handler(
				{ title: "has a team-facing twin", scopeUri: "demo" },
				ctx,
			),
		) as Task;
		const args = {
			id: task.shortId ?? task.id,
			provider: "linear",
			externalId: "linear-uuid",
		};

		unwrap(
			await tool("kabane_upstream_link").handler(
				{
					...args,
					identifier: "ENG-123",
					url: "https://linear.app/acme/issue/ENG-123/x",
					title: "Team feature",
				},
				ctx,
			),
		);

		// The brief is the read path; there is deliberately no upstream read tool.
		const brief = unwrap(
			await tool("kabane_context").handler({ id: args.id }, ctx),
		) as { markdown: string };
		expect(brief.markdown).toContain("## Upstream");
		expect(brief.markdown).toContain("- linear · ENG-123 — Team feature");

		const removed = unwrap(
			await tool("kabane_upstream_unlink").handler(args, ctx),
		) as { unlinked: string };
		expect(removed.unlinked).toBe("ENG-123");

		const after = unwrap(
			await tool("kabane_context").handler({ id: args.id }, ctx),
		) as { markdown: string };
		expect(after.markdown).not.toContain("## Upstream");
	});

	it("refuses to unlink an external issue the task is not linked to", async () => {
		const task = unwrap(
			await tool("kabane_add").handler(
				{ title: "unlinked", scopeUri: "demo" },
				ctx,
			),
		) as Task;

		const result = await tool("kabane_upstream_unlink").handler(
			{
				id: task.shortId ?? task.id,
				provider: "linear",
				externalId: "never-linked",
			},
			ctx,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("never-linked");
	});
});

describe("cabane MCP server over an in-memory transport", () => {
	let base: string;

	beforeEach(async () => {
		base = join(tmpdir(), `cabane-mcp-wire-${crypto.randomUUID()}`);
		mkdirSync(base, { recursive: true });
		configureTestRuntime();
		unwrap(await Planner.init(base));
	});

	afterEach(() => {
		rmSync(base, { recursive: true, force: true });
	});

	const connect = async (afterWrite?: (tool: ToolDef) => void) => {
		const ctx: ToolContext = {
			basePath: base,
			actor: "cabane://actor/human/david",
			scopeRequired: true,
		};
		const server = createMcpServer(ctx, {}, afterWrite);
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		await server.connect(serverSide);
		const client = new Client({ name: "test", version: "0" });
		await client.connect(clientSide);
		return { client, server };
	};

	it("lists every tool with a JSON schema and read-only annotations", async () => {
		const { client, server } = await connect();
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual(
			KABANE_TOOLS.map((t) => t.name).sort(),
		);
		const add = tools.find((t) => t.name === "kabane_add");
		expect(add?.inputSchema.required).toContain("title");
		expect(add?.annotations?.readOnlyHint).toBe(false);
		const list = tools.find((t) => t.name === "kabane_list");
		expect(list?.annotations?.readOnlyHint).toBe(true);
		const comment = tools.find((t) => t.name === "kabane_comment");
		expect(comment?.inputSchema.required).toEqual(["id"]);
		for (const alias of COMMENT_ALIASES) {
			expect(comment?.inputSchema.properties?.[alias]).toMatchObject({
				type: "string",
				minLength: 1,
				description: expect.stringContaining(
					alias === "body" ? "recommended" : "body",
				),
			});
		}
		const log = tools.find((t) => t.name === "kabane_log");
		expect(log?.inputSchema.required).toEqual(["id"]);
		expect(log?.inputSchema.properties?.commit).toMatchObject({
			type: "string",
			minLength: 1,
			description: expect.stringContaining("Bare SHA or revision"),
		});
		expect(log?.inputSchema.properties?.refs).toMatchObject({
			type: "array",
			minItems: 1,
		});
		expect(server.getClientVersion()).toBeDefined();
		await client.close();
	});

	it("validates write inputs without mutation or afterWrite on errors", async () => {
		const writes: string[] = [];
		const { client } = await connect((t) => writes.push(t.name));
		const issue = unwrap(await Planner.addTask(base, { title: "Validation" }));
		try {
			const invalidValues: unknown[] = ["", null, 42, true, [], {}];
			const invalidComments = [
				{},
				...COMMENT_CONFLICTS,
				...COMMENT_ALIASES.flatMap((alias) =>
					invalidValues.map((value) => ({ [alias]: value })),
				),
				{ body: "valid", content: "" },
			];
			for (const args of invalidComments) {
				const response = await client.callTool({
					name: "kabane_comment",
					arguments: { id: issue.id, ...args },
				});
				expect(response.isError).toBe(true);
			}
			const invalidLogs = [
				{},
				...invalidValues.map((commit) => ({ commit })),
				...[
					null,
					42,
					true,
					"refs",
					[],
					{},
					[{ uri: "" }],
					[{ uri: 42 }],
					[{ uri: "file:x", label: 42 }],
				].map((refs) => ({ refs })),
				{ commit: "valid", refs: [] },
				{ commit: "", refs: [{ uri: "file:x" }] },
			];
			for (const args of invalidLogs) {
				const response = await client.callTool({
					name: "kabane_log",
					arguments: { id: issue.id, ...args },
				});
				expect(response.isError).toBe(true);
			}
			expect(writes).toEqual([]);
			expect(unwrap(await Planner.getComments(base, issue.id))).toEqual([]);
			expect(unwrap(await Planner.getWorkLogs(base, issue.id))).toEqual([]);
			const comment = await client.callTool({
				name: "kabane_comment",
				arguments: { id: issue.id, body: " " },
			});
			expect(comment.isError).toBeFalsy();
			expect(
				unwrap(await Planner.getComments(base, issue.id))[0],
			).toMatchObject({
				content: " ",
				author: "cabane://actor/human/david",
				authorType: "human",
			});
			const log = await client.callTool({
				name: "kabane_log",
				arguments: { id: issue.id, commit: "HEAD" },
			});
			expect(log.isError).toBeFalsy();
			expect(writes).toEqual(["kabane_comment", "kabane_log"]);
		} finally {
			await client.close();
		}
	});

	it("calls a write, fires afterWrite, and surfaces errors as isError", async () => {
		const writes: string[] = [];
		const { client } = await connect((t) => writes.push(t.name));

		const created = await client.callTool({
			name: "kabane_add",
			arguments: { title: "From the wire", scopeUri: "wire" },
		});
		expect(created.isError).toBeFalsy();
		expect(writes).toEqual(["kabane_add"]);
		const text = (created.content as { text: string }[])[0]?.text ?? "";
		expect(JSON.parse(text).title).toBe("From the wire");

		const bad = await client.callTool({
			name: "kabane_add",
			arguments: { title: "no scope" },
		});
		expect(bad.isError).toBe(true);
		expect(writes).toHaveLength(1);

		const invalid = await client.callTool({
			name: "kabane_link",
			arguments: { sourceId: "x" },
		});
		expect(invalid.isError).toBe(true);
		expect((invalid.content as { text: string }[])[0]?.text).toContain(
			"Invalid arguments",
		);
		await client.close();
	});
});
