import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpServer, Planner, type Result } from "@cabane/core";
import { configureTestRuntime } from "@cabane/core/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { questionsModule } from "./module";
import { Questions } from "./storage";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
let base: string;
beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "questions-tools-"));
	configureTestRuntime("", { modules: [questionsModule] });
	unwrap(await Planner.init(base));
});
afterEach(() => {
	configureTestRuntime();
	rmSync(base, { recursive: true, force: true });
});
const connect = async (scopeRequired: boolean, defaultScope?: string) => {
	const server = unwrap(
		createMcpServer({
			basePath: base,
			actor: "cabane://actor/agent/test",
			scopeRequired,
			defaultScope,
		}),
	);
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: "questions", version: "1" });
	await client.connect(clientSide);
	return client;
};

it("honors default scope and requires a scope or issue on the hub", async () => {
	const task = unwrap(
		await Planner.addTask(base, {
			title: "Local issue",
			kind: "issue",
			scopeUri: "one",
		}),
	);
	const other = unwrap(
		await Planner.addTask(base, {
			title: "Other issue",
			kind: "issue",
			scopeUri: "two",
		}),
	);
	for (const issue of [task, other])
		unwrap(
			await Questions.ask(base, {
				id: issue.id,
				questions: [{ question: `Decision for ${issue.title}` }],
			}),
		);
	for (const hub of [false, true]) {
		const client = await connect(hub, hub ? undefined : "one");
		try {
			const result = await client.callTool({
				name: "kabane_questions",
				arguments: {},
			});
			if (hub) {
				expect(result.isError).toBe(true);
				expect(JSON.stringify(result.content)).toContain(
					"scopeUri is required",
				);
			} else {
				expect(result.isError).not.toBe(true);
				expect(JSON.stringify(result.content)).toContain("Local issue");
				expect(JSON.stringify(result.content)).not.toContain("Other issue");
			}
			const selected = await client.callTool({
				name: "kabane_questions",
				arguments: { id: other.id },
			});
			expect(selected.isError).not.toBe(true);
			expect(JSON.stringify(selected.content)).toContain("Other issue");
			const scoped = await client.callTool({
				name: "kabane_questions",
				arguments: { scopeUri: "two" },
			});
			expect(scoped.isError).not.toBe(true);
			expect(JSON.stringify(scoped.content)).not.toContain("Local issue");
		} finally {
			await client.close();
		}
	}
});

it("rejects invalid MCP inputs and records the connected answer author", async () => {
	const task = unwrap(
		await Planner.addTask(base, { title: "Tool validation", kind: "issue" }),
	);
	const client = await connect(false);
	try {
		for (const questions of [
			[],
			Array.from({ length: 11 }, () => ({ question: "Too many" })),
			[{ question: "Which?", recommended: "Missing" }],
		]) {
			expect(
				(
					await client.callTool({
						name: "kabane_ask",
						arguments: { id: task.id, questions },
					})
				).isError,
			).toBe(true);
		}
		const created = await client.callTool({
			name: "kabane_ask",
			arguments: {
				id: task.id,
				waiting: false,
				questions: [
					{ question: "Which?", choices: ["A", "B"], allowFreeform: false },
				],
			},
		});
		expect(created.isError).not.toBe(true);
		expect(
			(
				await client.callTool({
					name: "kabane_answer",
					arguments: { question: `${task.shortId}:1`, answer: "unknown" },
				})
			).isError,
		).toBe(true);
		const answer = await client.callTool({
			name: "kabane_answer",
			arguments: { question: `${task.shortId}:1`, answer: "b" },
		});
		expect(answer.isError).not.toBe(true);
		const row = unwrap(await Questions.list(base, { id: task.id }))[0];
		expect(row).toMatchObject({
			answer: "B",
			askedBy: "cabane://actor/agent/test",
			answeredBy: "cabane://actor/agent/test",
		});
	} finally {
		await client.close();
	}
});

it("prints kabane_questions pages byte for byte: markdown, then the cursor line", async () => {
	const task = unwrap(
		await Planner.addTask(base, { title: "Paged", kind: "issue" }),
	);
	unwrap(
		await Questions.ask(base, {
			id: task.id,
			questions: [
				{
					question: "First?",
					choices: ["A", "B"],
					recommended: "B",
					why: "B is local",
				},
				{ question: "Second?" },
			],
		}),
	);
	const client = await connect(false);
	const text = async (args: Record<string, unknown>) => {
		const result = await client.callTool({
			name: "kabane_questions",
			arguments: args,
		});
		expect(result.isError).not.toBe(true);
		return (result.content as { text: string }[])[0]?.text ?? "";
	};
	try {
		const first = await text({ id: task.id, limit: 1 });
		const cursor = first.split("\n\nnextCursor: ")[1] ?? "";
		expect(JSON.parse(cursor)).toMatchObject({ v: 1, offset: 1 });
		expect(first).toBe(
			`## ${task.shortId} Paged · normal · waiting\n\n${task.shortId}:1 First? (choices only)\n- A\n- B ★\nwhy: B is local\n\nnextCursor: ${cursor}`,
		);
		expect(await text({ id: task.id, limit: 1, cursor })).toBe(
			`## ${task.shortId} Paged · normal · waiting\n\n${task.shortId}:2 Second?`,
		);
		expect(await text({ scopeUri: "nowhere" })).toBe("No questions found.");
	} finally {
		await client.close();
	}
});
