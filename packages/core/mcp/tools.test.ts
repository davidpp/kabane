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
import type { Result } from "../result";
import type { Task } from "../schemas";
import { Planner } from "../storage";
import { configureTestRuntime } from "../testing";
import { createMcpServer } from "./server";
import { CABANE_TOOLS, type ToolContext, type ToolDef } from "./tools";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const tool = (name: string): ToolDef => {
	const found = CABANE_TOOLS.find((t) => t.name === name);
	if (!found) throw new Error(`no tool ${name}`);
	return found;
};

const AGENT = "cabane://actor/agent/hermes";

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
		const result = await tool("cabane_add").handler({ title: "x" }, ctx);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("cabane_scopeList");
	});

	it("falls back to the default scope when one is configured", async () => {
		const withDefault = { ...ctx, defaultScope: "demo" };
		const created = unwrap(
			await tool("cabane_add").handler({ title: "scoped" }, withDefault),
		) as Task;
		expect(created.scopeUri).toBe("jake://scope/demo");
		expect(created.updatedBy).toBe(AGENT);
		expect(created.provenance.source).toBe("ai");
	});

	it("runs the pickup flow: add, list by assignee, context, edit, log, comment, done", async () => {
		const issue = unwrap(
			await tool("cabane_add").handler(
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
			await tool("cabane_list").handler(
				{ assignee: "hermes", state: "next" },
				ctx,
			),
		) as Task[];
		expect(queue.map((t) => t.id)).toEqual([issue.id]);

		const brief = unwrap(
			await tool("cabane_context").handler({ id: issue.shortId ?? "" }, ctx),
		) as { markdown: string };
		expect(brief.markdown).toContain("Wire the hub");
		expect(brief.markdown).toContain("The brief.");

		const claimed = unwrap(
			await tool("cabane_edit").handler(
				{ id: issue.shortId ?? "", state: "in_progress" },
				ctx,
			),
		) as Task;
		expect(claimed.state).toBe("in_progress");
		expect(claimed.version).toBe(2);

		unwrap(
			await tool("cabane_log").handler(
				{ id: issue.id, refs: [{ uri: "commit:abc123" }], note: "landed" },
				ctx,
			),
		);
		unwrap(
			await tool("cabane_comment").handler(
				{ id: issue.id, content: "done, see the commit" },
				ctx,
			),
		);
		const logs = unwrap(await Planner.getWorkLogs(base, issue.id));
		expect(logs[0]?.refs[0]?.addedByType).toBe("ai");
		const comments = unwrap(await Planner.getComments(base, issue.id));
		expect(comments[0]?.authorType).toBe("ai");

		const finished = unwrap(
			await tool("cabane_done").handler({ id: issue.id }, ctx),
		) as Task;
		expect(finished.state).toBe("done");
	});

	it("links, searches, lists scopes, and manages context refs", async () => {
		const a = unwrap(
			await tool("cabane_add").handler(
				{ title: "Alpha durable", scopeUri: "one" },
				ctx,
			),
		) as Task;
		const b = unwrap(
			await tool("cabane_add").handler({ title: "Beta", scopeUri: "two" }, ctx),
		) as Task;

		unwrap(
			await tool("cabane_link").handler(
				{ sourceId: a.id, targetId: b.id, type: "blocks" },
				ctx,
			),
		);
		const links = unwrap(await Planner.getLinksForTask(base, b.id));
		expect(links.map((l) => l.type)).toContain("blocks");

		const found = unwrap(
			await tool("cabane_search").handler({ query: "durable" }, ctx),
		) as Task[];
		expect(found.map((t) => t.id)).toEqual([a.id]);

		const scopes = unwrap(await tool("cabane_scopeList").handler({}, ctx)) as {
			scopeId: string;
			count: number;
		}[];
		expect(scopes.map((s) => s.scopeId).sort()).toEqual(["one", "two"]);

		const ref = unwrap(
			await tool("cabane_contextAdd").handler(
				{ id: a.id, uri: "file:docs/auth.md", kind: "ADR" },
				ctx,
			),
		) as { id: string };
		const listed = unwrap(
			await tool("cabane_contextList").handler({ id: a.id }, ctx),
		) as { id: string }[];
		expect(listed.map((r) => r.id)).toEqual([ref.id]);
		unwrap(await tool("cabane_contextRemove").handler({ refId: ref.id }, ctx));
		expect(
			unwrap(await tool("cabane_contextList").handler({ id: a.id }, ctx)),
		).toEqual([]);

		const today = unwrap(await tool("cabane_today").handler({}, ctx)) as {
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
			await tool("cabane_add").handler(
				{ title: "Parent", scopeUri: "cabane" },
				ctx,
			),
		) as Task;
		const child = unwrap(
			await tool("cabane_add").handler(
				{ title: "Child", scopeUri: "cabane", parentTaskId: parent.id },
				ctx,
			),
		) as Task;
		expect(child.parentTaskId).toBe(parent.id);

		const detached = unwrap(
			await tool("cabane_edit").handler(
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
			await tool("cabane_add").handler(
				{ title: "Parent", scopeUri: "cabane" },
				ctx,
			),
		) as Task;
		const child = unwrap(
			await tool("cabane_add").handler(
				{ title: "Child", scopeUri: "cabane", parentTaskId: parent.id },
				ctx,
			),
		) as Task;

		const edited = unwrap(
			await tool("cabane_edit").handler(
				{ id: child.id, title: "Renamed" },
				ctx,
			),
		) as Task;
		expect(edited.parentTaskId).toBe(parent.id);
	});

	it("reports an unknown id as a tool error, not a throw", async () => {
		const result = await tool("cabane_get").handler({ id: "JCAB-999" }, ctx);
		expect(result.ok).toBe(false);
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
			CABANE_TOOLS.map((t) => t.name).sort(),
		);
		const add = tools.find((t) => t.name === "cabane_add");
		expect(add?.inputSchema.required).toContain("title");
		expect(add?.annotations?.readOnlyHint).toBe(false);
		const list = tools.find((t) => t.name === "cabane_list");
		expect(list?.annotations?.readOnlyHint).toBe(true);
		expect(server.getClientVersion()).toBeDefined();
		await client.close();
	});

	it("calls a write, fires afterWrite, and surfaces errors as isError", async () => {
		const writes: string[] = [];
		const { client } = await connect((t) => writes.push(t.name));

		const created = await client.callTool({
			name: "cabane_add",
			arguments: { title: "From the wire", scopeUri: "wire" },
		});
		expect(created.isError).toBeFalsy();
		expect(writes).toEqual(["cabane_add"]);
		const text = (created.content as { text: string }[])[0]?.text ?? "";
		expect(JSON.parse(text).title).toBe("From the wire");

		const bad = await client.callTool({
			name: "cabane_add",
			arguments: { title: "no scope" },
		});
		expect(bad.isError).toBe(true);
		expect(writes).toHaveLength(1);

		const invalid = await client.callTool({
			name: "cabane_link",
			arguments: { sourceId: "x" },
		});
		expect(invalid.isError).toBe(true);
		expect((invalid.content as { text: string }[])[0]?.text).toContain(
			"Invalid arguments",
		);
		await client.close();
	});
});
