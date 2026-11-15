import "@cabane/core/testing";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const installMcp = (name: string, body: string) => {
	const dir = join(ctx.home, "extensions", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ kabane: { extension: "./index.ts", api: 1 } }),
	);
	writeFileSync(
		join(dir, "index.ts"),
		`export default () => ({name: ${JSON.stringify(name)}, mcp: async () => {${body}}});`,
	);
};

test("real extension failures discard whole contributions while core and good tools remain on the wire", async () => {
	configure(["good", "throws", "bad", "duplicate", "badshape", "upstream"]);
	const tool = (name: string) =>
		`{name: "${name}", description: "Read", kind: "read", input: {}, handler: async () => ({ok:true, value:null})}`;
	installMcp(
		"good",
		`return {instructions: "good vocabulary", tools: [${tool("kabane_good_read")}]};`,
	);
	installMcp("throws", 'throw new Error("broken contribution");');
	installMcp(
		"bad",
		`return {instructions: "bad vocabulary", tools: [${tool("kabane_bad_read")}, ${tool("other_read")}]};`,
	);
	installMcp(
		"duplicate",
		`return {instructions: "duplicate vocabulary", tools: [${tool("kabane_duplicate_read")}, ${tool("kabane_duplicate_read")}]};`,
	);
	installMcp("badshape", 'return {tools: [{description: "x"}]};');
	installMcp("upstream", `return {tools: [${tool("kabane_upstream_link")}]};`);
	const contribution = await extensionMcp(ctx, KABANE_TOOLS);
	if (!contribution.ok) throw contribution.error;
	expect(contribution.value.tools.map((t) => t.name)).toEqual([
		"kabane_good_read",
	]);
	expect(contribution.value.instructions).toEqual(["good vocabulary"]);
	const server = createMcpServer(
		{ basePath: ctx.store, actor: ctx.actor, scopeRequired: false },
		{},
		undefined,
		[...KABANE_TOOLS, ...contribution.value.tools],
		contribution.value.instructions,
	);
	if (!server.ok) throw server.error;
	const client = new Client({ name: "isolation-test", version: "1" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.value.connect(serverTransport);
	await client.connect(clientTransport);
	try {
		expect((await client.listTools()).tools.map((t) => t.name)).toEqual([
			...KABANE_TOOLS.map((t) => t.name),
			"kabane_good_read",
		]);
		expect(client.getInstructions()).toContain("good vocabulary");
		expect(client.getInstructions()).not.toContain("bad vocabulary");
	} finally {
		await client.close();
		await server.value.close();
	}
});

test("real extension handler failures name their owner", async () => {
	configure(["handler"]);
	installMcp(
		"handler",
		'return {tools: [{name: "kabane_handler_read", description: "Read", kind: "read", input: {}, handler: async () => {throw new Error("broken handler");}}]};',
	);
	const result = await extensionMcp(ctx, []);
	if (!result.ok) throw result.error;
	const tool = result.value.tools[0];
	if (!tool) throw new Error("Missing tool");
	const called = await tool.handler(
		{},
		{ basePath: ctx.store, actor: ctx.actor, scopeRequired: false },
	);
	expect(called.ok).toBe(false);
	if (called.ok) throw new Error("Expected failure");
	expect(called.error.message).toContain(
		"Extension handler MCP tool kabane_handler_read failed: broken handler",
	);
});

test("an extension cannot replace the core kabane_upstream_link tool", async () => {
	configure(["upstream"]);
	installMcp(
		"upstream",
		'return {tools: [{name:"kabane_upstream_link",description:"Replacement",input:{},kind:"write",handler:async()=>({ok:true,value:null})}]};',
	);
	const contribution = await extensionMcp(ctx, KABANE_TOOLS);
	if (!contribution.ok) throw contribution.error;
	expect(contribution.value).toEqual({ tools: [], instructions: [] });
	expect(
		KABANE_TOOLS.some((tool) => tool.name === "kabane_upstream_link"),
	).toBe(true);
});

test.each([
	'{tools:"nope"}',
	"{instructions:42}",
	'{tools:[{name:"kabane_invalid_read", description:"Read",kind:"read",input:{id:"not a schema"},handler:async()=>({ok:true,value:null})}]}',
	'{tools:[{name:"kabane_invalid_read", description:"Read",kind:"read",input:{},handler:"nope"}]}',
])("invalid MCP contribution is isolated: %s", async (result) => {
	configure(["invalid"]);
	installMcp("invalid", `return ${result};`);
	const contribution = await extensionMcp(ctx, KABANE_TOOLS);
	if (!contribution.ok) throw contribution.error;
	expect(contribution.value).toEqual({ tools: [], instructions: [] });
});
