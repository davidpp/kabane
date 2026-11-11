import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpServer, Planner, type Result } from "@cabane/core";
import { configureTestRuntime } from "@cabane/core/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { handoffModule } from "./module";
import { HANDOFF_KIND } from "./template";

const AGENT = "cabane://actor/agent/test";
const FRAMING =
	"The author's own account of its work: check the evidence before relying on it.";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
let base: string;
let client: Client;
beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "handoff-tools-"));
	configureTestRuntime("", { modules: [handoffModule] });
	unwrap(await Planner.init(base));
	const server = unwrap(
		createMcpServer({ basePath: base, actor: AGENT, scopeRequired: false }),
	);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	client = new Client({ name: "handoff", version: "1" });
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
const issue = async (title: string) => {
	const task = unwrap(
		await Planner.addTask(base, {
			title,
			description: `What ${title} is for.`,
			kind: "issue",
			state: "in_progress",
		}),
	);
	return { task, label: task.shortId ?? task.id };
};

it("lists kabane_handoff with the template, and carries the hand-off paragraph in the server instructions", async () => {
	const { tools } = await client.listTools();
	const tool = tools.find((t) => t.name === "kabane_handoff");
	expect(tool?.annotations?.readOnlyHint).toBe(false);
	expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
		"id",
		"body",
	]);
	for (const line of [
		"Show, do not tell.",
		"### Summary: The smallest picture of what was made or changed.",
		"### Evidence: What you saw, not what you concluded",
		"### Not verified: ",
		"### Risk: ",
	])
		expect(tool?.description).toContain(line);
	const context = tools.find((t) => t.name === "kabane_context");
	expect(JSON.stringify(context?.inputSchema)).toContain("handoff.latest");
	expect(client.getInstructions()).toContain(
		"When you finish your part of an issue, hand it off with kabane_handoff before anyone closes it, whatever the work was",
	);
});

it("records an entry of kind handoff by the caller, answers in one line and leaves the issue as it was", async () => {
	const { task, label } = await issue("Mock the screen");
	expect(
		await call("kabane_handoff", {
			id: label,
			body: "### Summary\n\nThree states: empty, loading, filled.\n",
		}),
	).toEqual({
		isError: false,
		text: `${label} handed off · 0 earlier on record`,
	});
	expect(
		await call("kabane_handoff", {
			id: task.id,
			body: "### Summary\n\nFour states: an error state too.",
		}),
	).toEqual({
		isError: false,
		text: `${label} handed off · 1 earlier on record`,
	});

	const entries = unwrap(
		await Planner.getEntries(base, task.id, { kind: HANDOFF_KIND }),
	);
	expect(entries.map((e) => [e.author, e.authorType, e.content])).toEqual([
		[AGENT, "ai", "### Summary\n\nThree states: empty, loading, filled."],
		[AGENT, "ai", "### Summary\n\nFour states: an error state too."],
	]);
	expect(unwrap(await Planner.getTask(base, task.id))).toEqual(task);
});

it("refuses a blank body and a missing issue in one line, and writes nothing", async () => {
	const { task, label } = await issue("Read the vendor docs");
	const blank = await call("kabane_handoff", { id: label, body: " \n\t" });
	expect(blank).toEqual({
		isError: true,
		text: "Error: A handoff needs a body: markdown under Summary, Evidence, Not verified and Risk, or the headings the work needs.",
	});
	expect(
		await call("kabane_handoff", { id: "NOPE-404", body: "### Summary" }),
	).toEqual({
		isError: true,
		text: 'Error: No task found with ID "NOPE-404": give its short id (JCAB-12) or its ULID, as list and search show them.',
	});
	expect(
		await call("kabane_handoff", {
			id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
			body: "### Summary",
		}),
	).toEqual({
		isError: true,
		text: 'Error: No task found with ID "01ARZ3NDEKTSV4RRFFQ69G5FAV": give its short id (JCAB-12) or its ULID, as list and search show them.',
	});
	expect(unwrap(await Planner.getEntries(base, task.id))).toEqual([]);
});

it("opens the brief with the latest handoff under the description, framed, counting the earlier ones and keeping them out of the Discussion", async () => {
	const { task, label } = await issue("Sketch the onboarding");
	unwrap(
		await Planner.addComment(base, {
			taskId: task.id,
			author: "cabane://actor/human/test",
			authorType: "human",
			content: "Keep it to one screen.",
		}),
	);
	await call("kabane_handoff", { id: label, body: "First pass: two screens." });
	await call("kabane_handoff", { id: label, body: "Second pass: one screen." });

	const brief = (await call("kabane_context", { id: label })).text;
	const { markdown } = JSON.parse(brief) as { markdown: string };
	const description = markdown.indexOf("What Sketch the onboarding is for.");
	const handoff = markdown.indexOf(`## Handoff from ${AGENT} · `);
	const discussion = markdown.indexOf("## Discussion");
	expect(description).toBeGreaterThan(-1);
	expect(handoff).toBeGreaterThan(description);
	expect(discussion).toBeGreaterThan(handoff);
	const section = markdown.slice(handoff, discussion);
	expect(section).toContain(`\n\n${FRAMING}\n\nSecond pass: one screen.\n\n`);
	expect(section).toContain("1 earlier handoff entry on record.");
	expect(markdown).not.toContain("First pass: two screens.");
	expect(markdown.slice(discussion)).toContain("Keep it to one screen.");
});
