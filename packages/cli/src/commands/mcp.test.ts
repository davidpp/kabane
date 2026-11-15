import "@cabane/core/testing";
import { expect, test } from "bun:test";
import { createMcpServer, KABANE_TOOLS, ok, type ToolDef } from "@cabane/core";
import { Settings } from "@cabane/extension";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MODULES } from "../context";
import { extensionMcp } from "./mcp";

test("enabled loop contributes its tool and instructions on the MCP wire; disabled contributes nothing", async () => {
	const ctx = {
		home: "/unused",
		store: "/unused",
		cwd: "/unused",
		actor: "test",
		harnessMode: "default" as const,
		settings: Settings.port(async () => ok([])),
	};
	expect(await extensionMcp(ctx, [])).toEqual(
		ok({ tools: [], instructions: [] }),
	);
	const contribution = await extensionMcp(ctx, ["loop"]);
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
			description: "Read without declared hints",
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
			{ name: "test_read", annotations: { readOnlyHint: true } },
		]);
	} finally {
		await client.close();
		await server.value.close();
	}
});
