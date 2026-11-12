import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
	CONTEXT_BYTES,
	CONTEXT_SECTIONS,
	ContextPageSchema,
} from "../context-output";
import type { KabaneModule } from "../module";
import { err, ok, type Result } from "../result";
import { Planner } from "../storage";
import { configureTestRuntime } from "../testing";
import { createMcpServer, handleHttpRequest } from "./server";
import { KABANE_TOOLS, SERVER_INSTRUCTIONS, type ToolDef } from "./tools";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
const module: KabaneModule = {
	name: "decisions",
	contextSections: [
		{
			name: "decisions.answers",
			after: "description",
			render: async (_base, task) => ok(`## Answers\n\nFor ${task.title}`),
		},
	],
	tools: [
		{
			name: "decisions_read",
			description: "Read decisions",
			kind: "read",
			input: {},
			handler: async () => ok("Decision recorded"),
		},
	],
	instructions: "Use decisions_read to read decisions.",
};
let base: string;
beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "kabane-modules-"));
	configureTestRuntime({ modules: [module] });
	unwrap(await Planner.init(base));
});
afterEach(() => {
	configureTestRuntime();
	rmSync(base, { recursive: true, force: true });
});
const context = () => ({
	basePath: base,
	actor: "cabane://actor/agent/test",
	scopeRequired: false,
});

it("renders a module after its core anchor, including when the anchor is empty", async () => {
	const task = unwrap(
		await Planner.addTask(base, {
			title: "Module brief",
			description: "Description here",
		}),
	);
	const brief = unwrap(await Planner.assembleContext(base, task.id));
	expect(brief.indexOf("Description here")).toBeLessThan(
		brief.indexOf("## Answers"),
	);
	expect(brief).toContain("For Module brief");
	const empty = unwrap(
		await Planner.addTask(base, { title: "No description" }),
	);
	expect(unwrap(await Planner.assembleContext(base, empty.id))).toContain(
		"For No description",
	);
});

it("degrades a failed or empty module section in the full brief", async () => {
	const task = unwrap(await Planner.addTask(base, { title: "Still readable" }));
	for (const result of [err(new Error("unavailable")), ok(null)]) {
		configureTestRuntime({
			modules: [
				{
					name: "empty",
					contextSections: [
						{
							name: "empty.section",
							after: "description",
							render: async () => result,
						},
					],
				},
			],
		});
		const bounded = await Planner.getContextPage(base, task.id, {
			sections: ["empty.section"],
		});
		expect(bounded.ok).toBe(result.ok);
		if (bounded.ok) {
			expect(bounded.value.markdown).toBe("");
			expect(bounded.value.completeness.completedSections).toEqual([
				"empty.section",
			]);
		}
		expect(unwrap(await Planner.assembleContext(base, task.id))).toContain(
			"Still readable",
		);
	}
});

it("lists and calls registered module tools and advertises their instructions", async () => {
	const server = unwrap(createMcpServer(context()));
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "modules-test", version: "1" });
	await server.connect(serverSide);
	await client.connect(clientSide);
	try {
		expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
			...KABANE_TOOLS.map((tool) => tool.name),
			"decisions_read",
		]);
		expect(
			await client.callTool({ name: "decisions_read", arguments: {} }),
		).toMatchObject({ content: [{ type: "text", text: "Decision recorded" }] });
		const task = unwrap(
			await Planner.addTask(base, { title: "Selected over MCP" }),
		);
		const response = await client.callTool({
			name: "kabane_context",
			arguments: {
				id: task.id,
				responseFormat: "concise",
				sections: ["decisions.answers"],
			},
		});
		expect(response.isError).not.toBe(true);
		const content = response.content;
		if (!Array.isArray(content) || content[0]?.type !== "text")
			throw new Error("Expected MCP text content");
		const parsed = ContextPageSchema.safeParse(JSON.parse(content[0].text));
		expect(parsed.success).toBe(true);
		if (parsed.success)
			expect(parsed.data.markdown).toBe("## Answers\n\nFor Selected over MCP");
		const invalid = await client.callTool({
			name: "kabane_context",
			arguments: {
				id: task.id,
				responseFormat: "concise",
				sections: ["missing.section".repeat(1000)],
			},
		});
		expect(invalid.isError).toBe(true);
		expect(JSON.stringify(invalid.content)).toContain(
			"Valid sections: metadata, description, decisions.answers, upstream, position, context, priorWork, discussion",
		);
		expect(client.getInstructions()).toBe(
			`${SERVER_INSTRUCTIONS}\n\n${module.instructions}`,
		);
	} finally {
		await client.close();
	}
});

it("refuses tool collisions introduced after configuration before serving either transport", async () => {
	const core = KABANE_TOOLS[0];
	if (!core) throw new Error("Missing core tools");
	const tools: ToolDef[] = [];
	configureTestRuntime({ modules: [{ name: "collision", tools }] });
	tools.push(core);
	const result = createMcpServer(context());
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.message).toContain(core.name);
	const response = await handleHttpRequest(
		context(),
		new Request("https://example.test/mcp", { method: "POST" }),
	);
	expect(response.status).toBe(500);
	expect(response.headers.get("content-type")).toContain("application/json");
	expect(await response.json()).toEqual({
		error: `Duplicate MCP tool name: ${core.name}. Rename the module or host tool.`,
	});
});

it("includes module sections by default and reports canonical selection and omissions", async () => {
	const task = unwrap(
		await Planner.addTask(base, { title: "Ordered", description: "Anchor" }),
	);
	const full = unwrap(await Planner.assembleContext(base, task.id));
	const all = unwrap(await Planner.getContextPage(base, task.id));
	expect(all.markdown).toBe(full);
	expect(all.completeness.completedSections).toEqual([
		"metadata",
		"description",
		"decisions.answers",
		"upstream",
		"position",
		"context",
		"priorWork",
		"discussion",
	]);
	const selected = unwrap(
		await Planner.getContextPage(base, task.id, {
			sections: ["decisions.answers", "description", "decisions.answers"],
		}),
	);
	expect(selected.completeness.completedSections).toEqual([
		"description",
		"decisions.answers",
	]);
	expect(selected.markdown.indexOf("Anchor")).toBeLessThan(
		selected.markdown.indexOf("## Answers"),
	);
	const omitted = unwrap(
		await Planner.getContextPage(base, task.id, { sections: ["metadata"] }),
	);
	expect(omitted.completeness.omittedSections).toContain("decisions.answers");
	const unknown = await Planner.getContextPage(base, task.id, {
		sections: ["missing.section"],
	});
	expect(unknown.ok).toBe(false);
	if (!unknown.ok) {
		expect(unknown.error.message).toContain(
			"Valid sections: metadata, description, decisions.answers",
		);
		expect(unknown.error.message).toContain("missing.section");
	}
});

it("fails bounded reads only when a failing module section is selected", async () => {
	const task = unwrap(await Planner.addTask(base, { title: "Readable core" }));
	configureTestRuntime({
		modules: [
			{
				name: "failed",
				contextSections: [
					{
						name: "failed.section",
						after: "description",
						render: async () => err(new Error("module unavailable")),
					},
				],
			},
		],
	});
	const failed = await Planner.getContextPage(base, task.id);
	expect(failed.ok).toBe(false);
	if (!failed.ok) expect(failed.error.message).toContain("module unavailable");
	expect(
		unwrap(
			await Planner.getContextPage(base, task.id, { sections: ["metadata"] }),
		).markdown,
	).toContain("Readable core");
	expect(unwrap(await Planner.assembleContext(base, task.id))).toContain(
		"Readable core",
	);
});

it("paginates module sections within 16KiB and invalidates changed module content", async () => {
	const task = unwrap(await Planner.addTask(base, { title: "Large section" }));
	let markdown = "## Long answers\n\n" + "Answer 🌲\n".repeat(6000);
	configureTestRuntime({
		modules: [
			{
				name: "large",
				contextSections: [
					{
						name: "large.answers",
						after: "description",
						render: async () => ok(markdown),
					},
				],
			},
		],
	});
	const options = { sections: ["large.answers"] };
	let page = unwrap(await Planner.getContextPage(base, task.id, options));
	const firstCursor = page.nextCursor;
	expect(firstCursor).toBeDefined();
	expect(page.completeness.remainingSections).toEqual(["large.answers"]);
	let joined = "";
	let count = 0;
	while (true) {
		expect(
			new TextEncoder().encode(JSON.stringify(page)).length,
		).toBeLessThanOrEqual(CONTEXT_BYTES);
		expect(ContextPageSchema.safeParse(page).success).toBe(true);
		expect(page.offset).toBe(joined.length);
		joined += page.markdown;
		count++;
		if (!page.nextCursor) break;
		if (count > 20) throw new Error("Pagination did not finish");
		page = unwrap(
			await Planner.getContextPage(base, task.id, {
				...options,
				cursor: page.nextCursor,
			}),
		);
	}
	expect(joined).toBe(markdown);
	expect(page.completeness.completedSections).toEqual(["large.answers"]);
	expect(page.completeness.selectedComplete).toBe(true);
	markdown += "Changed";
	const stale = await Planner.getContextPage(base, task.id, {
		...options,
		cursor: firstCursor,
	});
	expect(stale.ok).toBe(false);
	if (!stale.ok) expect(stale.error.message).toContain("Stale context cursor");
});

it("advertises core and registered section enums for each server", async () => {
	for (const modules of [[], [module]]) {
		configureTestRuntime({ modules });
		const server = unwrap(createMcpServer(context()));
		const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "schema-test", version: "1" });
		await server.connect(serverSide);
		await client.connect(clientSide);
		try {
			const tool = (await client.listTools()).tools.find(
				(item) => item.name === "kabane_context",
			);
			expect(tool?.inputSchema.properties?.sections).toEqual({
				type: "array",
				items: {
					type: "string",
					enum: modules.length
						? [
								"metadata",
								"description",
								"decisions.answers",
								...CONTEXT_SECTIONS.slice(2),
							]
						: [...CONTEXT_SECTIONS],
				},
				maxItems: 100,
				default: modules.length
					? [
							"metadata",
							"description",
							"decisions.answers",
							...CONTEXT_SECTIONS.slice(2),
						]
					: [...CONTEXT_SECTIONS],
			});
		} finally {
			await client.close();
		}
	}
});

it("advertises a latest kind's section after its anchor, behind its module's own sections", async () => {
	configureTestRuntime({
		modules: [
			{
				...module,
				kinds: [
					{
						name: "decisions.verdict",
						title: "Verdict",
						template: "",
						projection: {
							latest: { after: "description", framing: "The newest." },
						},
					},
				],
			},
		],
	});
	const server = unwrap(createMcpServer(context()));
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "kind-schema-test", version: "1" });
	await server.connect(serverSide);
	await client.connect(clientSide);
	try {
		const tool = (await client.listTools()).tools.find(
			(item) => item.name === "kabane_context",
		);
		expect(tool?.inputSchema.properties?.sections).toMatchObject({
			items: {
				enum: [
					"metadata",
					"description",
					"decisions.answers",
					"decisions.verdict.latest",
					...CONTEXT_SECTIONS.slice(2),
				],
			},
		});
	} finally {
		await client.close();
	}
});

it("degrades thrown module renders in full reads and refuses strict reads", async () => {
	const task = unwrap(
		await Planner.addTask(base, { title: "Throwing module" }),
	);
	configureTestRuntime({
		modules: [
			{
				name: "broken",
				contextSections: [
					{
						name: "broken.section",
						after: "description",
						render: async () => {
							throw new Error("render threw");
						},
					},
				],
			},
		],
	});
	expect(unwrap(await Planner.assembleContext(base, task.id))).toContain(
		"Throwing module",
	);
	const strict = await Planner.getContextPage(base, task.id, {
		sections: ["broken.section"],
	});
	expect(strict.ok).toBe(false);
	if (!strict.ok)
		expect(strict.error.message).toBe(
			"Cannot read context broken.section; retry the bounded read.",
		);
});

it("renders modules sharing an anchor in registration order", async () => {
	const task = unwrap(
		await Planner.addTask(base, {
			title: "Ordered modules",
			description: "Anchor",
		}),
	);
	const modules: KabaneModule[] = ["first", "second"].map((name) => ({
		name,
		contextSections: [
			{
				name: `${name}.section`,
				after: "description",
				render: async () => ok(`## ${name}`),
			},
		],
	}));
	for (const order of [modules, [...modules].reverse()]) {
		configureTestRuntime({ modules: order });
		const expected = order.map((item) => `## ${item.name}`).join("\n\n");
		expect(unwrap(await Planner.assembleContext(base, task.id))).toContain(
			`Anchor\n\n${expected}`,
		);
		const bounded = unwrap(
			await Planner.getContextPage(base, task.id, {
				sections: ["second.section", "first.section"],
			}),
		);
		expect(bounded.markdown).toBe(expected);
	}
});

it("serves module tools and instructions over Streamable HTTP", async () => {
	const request = async (
		method: string,
		params: Record<string, unknown> = {},
	) => {
		const response = await handleHttpRequest(
			context(),
			new Request("https://example.test/mcp", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			}),
		);
		expect(response.status).toBe(200);
		return response.json();
	};
	expect(
		await request("initialize", {
			protocolVersion: "2025-03-26",
			capabilities: {},
			clientInfo: { name: "http-test", version: "1" },
		}),
	).toMatchObject({
		result: {
			instructions: `${SERVER_INSTRUCTIONS}\n\n${module.instructions}`,
		},
	});
	expect(await request("tools/list")).toMatchObject({
		result: {
			tools: expect.arrayContaining([
				expect.objectContaining({ name: "decisions_read" }),
			]),
		},
	});
});
