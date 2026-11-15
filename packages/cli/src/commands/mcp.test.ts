import "@cabane/core/testing";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpServer, KABANE_TOOLS, ok, type ToolDef } from "@cabane/core";
import { type Extension, Settings } from "@cabane/extension";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MODULES } from "../context";
import { extensionMcp } from "./mcp";

let ctx: Extension.Ctx;
const configure = (extensions: string[]) =>
	writeFileSync(
		join(ctx.home, "config.json"),
		JSON.stringify({
			actor: "test",
			deviceId: "test",
			extensions,
		}),
	);

beforeEach(() => {
	const home = mkdtempSync(join(tmpdir(), "kabane-mcp-"));
	ctx = {
		home,
		store: home,
		cwd: home,
		actor: "test",
		harnessMode: "default",
		settings: Settings.port(async () => ok([])),
	};
	configure(["loop"]);
});

afterEach(() => rmSync(ctx.home, { recursive: true, force: true }));

const readTool: ToolDef = {
	name: "kabane_loop_read",
	description: "Injected read",
	kind: "read",
	input: {},
	handler: async () => ok(null),
};

const inject = (extension: Extension) => async (names: readonly string[]) =>
	ok(names.map(() => extension));

test("enabled loop contributes its tool and instructions on the MCP wire", async () => {
	const contribution = await extensionMcp(ctx, []);
	if (!contribution.ok) throw contribution.error;
	const { tools, instructions } = contribution.value;
	const server = createMcpServer(
		{ basePath: ctx.store, actor: ctx.actor, scopeRequired: false },
		{},
		undefined,
		tools,
		instructions,
	);
	if (!server.ok) throw server.error;
	const client = new Client({ name: "extension-test", version: "1" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.value.connect(serverTransport);
	await client.connect(clientTransport);
	try {
		expect(client.getInstructions()).toContain("tier:<harness>/<name>");
		expect(client.getInstructions()?.endsWith(instructions.join("\n\n"))).toBe(
			true,
		);
		expect(
			await client.callTool({ name: "kabane_loop_advise", arguments: {} }),
		).toMatchObject({ isError: true });
		const listed = (await client.listTools()).tools;
		expect(listed.map((tool) => tool.name)).toEqual(["kabane_loop_advise"]);
		const entry = listed[0];
		if (!entry) throw new Error("Missing loop advice tool");
		expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThan(700);
		expect(Object.keys(entry.inputSchema.properties ?? {})).toEqual(["id"]);
		expect(
			createMcpServer(
				{ basePath: ctx.store, actor: ctx.actor, scopeRequired: false },
				{},
				undefined,
				[...tools, ...tools],
			).ok,
		).toBe(false);
	} finally {
		await client.close();
		await server.value.close();
	}
});

test("tool annotations preserve core and module listings and add only declared hints", async () => {
	const acceptsReadOnlyHint: "readOnlyHint" extends keyof NonNullable<
		ToolDef["annotations"]
	>
		? true
		: false = false;
	expect(acceptsReadOnlyHint).toBe(false);
	const existing = [
		...KABANE_TOOLS,
		...MODULES.flatMap((module) => module.tools ?? []),
	];
	const annotations = {
		readOnlyHint: false,
		destructiveHint: false,
		openWorldHint: undefined,
		title: "Must not pass through",
		idempotentHint: true,
	};
	const tools: ToolDef[] = [
		...existing,
		{
			name: "test_write",
			description: "Write with declared hints",
			kind: "write",
			input: {},
			annotations: { destructiveHint: true, openWorldHint: true },
			handler: async () => ok(null),
		},
		{
			name: "test_read",
			description: "Read with annotations from a variable",
			annotations,
			kind: "read",
			input: {},
			handler: async () => ok(null),
		},
	];
	const server = createMcpServer(
		{ basePath: "/unused", actor: "test", scopeRequired: false },
		{},
		undefined,
		tools,
	);
	if (!server.ok) throw server.error;
	const client = new Client({ name: "annotations-test", version: "1" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.value.connect(serverTransport);
	await client.connect(clientTransport);
	try {
		const listed = (await client.listTools()).tools;
		expect(
			listed.map((tool) => ({
				name: tool.name,
				annotations: tool.annotations,
			})),
		).toEqual([
			...existing.map((tool) => ({
				name: tool.name,
				annotations: { readOnlyHint: tool.kind === "read" },
			})),
			{
				name: "test_write",
				annotations: {
					readOnlyHint: false,
					destructiveHint: true,
					openWorldHint: true,
				},
			},
			{
				name: "test_read",
				annotations: { readOnlyHint: true, destructiveHint: false },
			},
		]);
	} finally {
		await client.close();
		await server.value.close();
	}
});

test.each(["other_read", "kabane_loop_"])(
	"refuses extension tool name %s",
	async (name) => {
		const result = await extensionMcp(
			ctx,
			[],
			inject({
				name: "loop",
				mcp: async () => ({ tools: [{ ...readTool, name }] }),
			}),
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Expected naming refusal");
		expect(result.error.message).toBe(
			`Extension loop MCP tool ${name} must be named kabane_loop_<verb>`,
		);
	},
);

test("labels an extension mcp contribution that throws", async () => {
	const result = await extensionMcp(
		ctx,
		[],
		inject({
			name: "loop",
			mcp: async () => {
				throw new Error("broken contribution");
			},
		}),
	);
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("Expected contribution failure");
	expect(result.error.message).toBe(
		"Extension loop MCP failed: broken contribution",
	);
});

test("labels an extension tool handler that throws", async () => {
	const result = await extensionMcp(
		ctx,
		[],
		inject({
			name: "loop",
			mcp: async () => ({
				tools: [
					{
						...readTool,
						handler: async () => {
							throw new Error("broken handler");
						},
					},
				],
			}),
		}),
	);
	if (!result.ok) throw result.error;
	const tool = result.value.tools[0];
	if (!tool) throw new Error("Missing injected tool");
	const called = await tool.handler(
		{},
		{ basePath: ctx.store, actor: ctx.actor, scopeRequired: false },
	);
	expect(called.ok).toBe(false);
	if (called.ok) throw new Error("Expected handler failure");
	expect(called.error.message).toBe(
		"Extension loop MCP tool kabane_loop_read failed: broken handler",
	);
});

test("command contributions omit a configured-off extension", async () => {
	configure([]);
	let calls = 0;
	const result = await extensionMcp(
		ctx,
		[],
		inject({
			name: "loop",
			mcp: async () => {
				calls++;
				return { instructions: "Injected vocabulary", tools: [readTool] };
			},
		}),
	);
	expect(result).toEqual(ok({ tools: [], instructions: [] }));
	expect(calls).toBe(0);
});

test("command contributions load duplicate configured names only once", async () => {
	configure(["loop", "loop"]);
	let calls = 0;
	const result = await extensionMcp(
		ctx,
		[],
		inject({
			name: "loop",
			mcp: async () => {
				calls++;
				return { instructions: "Injected vocabulary", tools: [readTool] };
			},
		}),
	);
	if (!result.ok) throw result.error;
	expect(calls).toBe(1);
	expect(result.value.tools.map((tool) => tool.name)).toEqual([readTool.name]);
	expect(result.value.instructions).toEqual(["Injected vocabulary"]);
});

test("extension collision with a core tool names the extension and remedy", async () => {
	const result = await extensionMcp(
		ctx,
		KABANE_TOOLS,
		inject({
			name: "upstream",
			mcp: async () => ({
				tools: [{ ...readTool, name: "kabane_upstream_link" }],
			}),
		}),
	);
	expect(result.ok).toBe(false);
	if (result.ok) throw new Error("Expected duplicate refusal");
	expect(result.error.message).toBe(
		"Extension upstream MCP tool kabane_upstream_link duplicates an existing tool. Rename the extension tool.",
	);
});
