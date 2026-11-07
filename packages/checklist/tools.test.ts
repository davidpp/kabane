import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpServer, Planner, type Result } from "@cabane/core";
import { configureTestRuntime } from "@cabane/core/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { checklistModule } from "./module";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
let base: string;
let client: Client;
beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "checklist-tools-"));
	configureTestRuntime("", { modules: [checklistModule] });
	unwrap(await Planner.init(base));
	const server = unwrap(
		createMcpServer({
			basePath: base,
			actor: "cabane://actor/agent/test",
			scopeRequired: false,
		}),
	);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	client = new Client({ name: "checklist", version: "1" });
	await client.connect(clientSide);
});
afterEach(async () => {
	await client.close();
	configureTestRuntime();
	rmSync(base, { recursive: true, force: true });
});
const call = async (name: string, args: Record<string, unknown>) => {
	const result = await client.callTool({ name, arguments: args });
	const [content] = result.content as { text: string }[];
	return { isError: result.isError === true, text: content?.text ?? "" };
};

it("lists the tools and carries the item-or-subtask rule in the server instructions", async () => {
	const { tools } = await client.listTools();
	const names = tools.map((tool) => tool.name);
	for (const name of [
		"kabane_checklistAdd",
		"kabane_checklistTick",
		"kabane_checklistEdit",
	])
		expect(names).toContain(name);
	const context = tools.find((tool) => tool.name === "kabane_context");
	expect(JSON.stringify(context?.inputSchema)).toContain("checklist.items");
	expect(client.getInstructions()).toContain(
		"make it a subtask (kabane_add with parentTaskId) instead of an item",
	);
});

it("answers each write with one line: the issue, its progress and the items", async () => {
	const task = unwrap(
		await Planner.addTask(base, { title: "Steps", kind: "issue" }),
	);
	const label = task.shortId ?? task.id;
	const added = await call("kabane_checklistAdd", {
		id: label,
		items: ["Write", "Test", "Ship"],
	});
	expect(added.isError).toBe(false);
	expect(added.text).toMatch(
		new RegExp(
			`^${label} 0/3 · added ${label}\\.1 id:\\w{26}, ${label}\\.2 id:\\w{26}, ${label}\\.3 id:\\w{26}$`,
		),
	);
	expect(
		await call("kabane_checklistTick", { items: [`${label}.1`, `${label}.2`] }),
	).toEqual({
		isError: false,
		text: `${label} 2/3 · ticked ${label}.1, ${label}.2`,
	});
	expect(
		(await call("kabane_checklistTick", { items: [`${label}.2`], done: false }))
			.text,
	).toBe(`${label} 1/3 · unticked ${label}.2`);
	expect(
		(await call("kabane_checklistEdit", { item: `${label}.3`, position: 1 }))
			.text,
	).toBe(`${label} 1/3 · moved ${label}.3 to 1`);
	expect(
		(
			await call("kabane_checklistEdit", {
				item: `${label}.2`,
				text: "Test more",
				position: 3,
			})
		).text,
	).toBe(`${label} 1/3 · edited ${label}.2 and moved to 3`);
	expect(
		(await call("kabane_checklistEdit", { item: `${label}.1`, remove: true }))
			.text,
	).toBe(`${label} 0/2 · removed ${label}.1`);
	const refused = await call("kabane_checklistEdit", { item: `${label}.3` });
	expect(refused.isError).toBe(true);
	expect(refused.text).toContain("Supply text, position or both");

	const brief = await call("kabane_context", {
		id: label,
		responseFormat: "concise",
		sections: ["checklist.items"],
	});
	const { markdown } = JSON.parse(brief.text) as { markdown: string };
	expect(markdown).toMatch(
		new RegExp(
			`^## Checklist 0/2\n\n- \\[ \\] ${label}\\.3 Ship id:\\w{26}\n- \\[ \\] ${label}\\.2 Test more id:\\w{26}$`,
		),
	);
});
