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
	configureTestRuntime({ modules: [questionsModule] });
	unwrap(await Planner.init(base));
});
afterEach(() => {
	configureTestRuntime();
	rmSync(base, { recursive: true, force: true });
});
const connect = async (
	scopeRequired: boolean,
	defaultScope?: string,
	humanActor?: string,
) => {
	const server = unwrap(
		createMcpServer({
			basePath: base,
			actor: "cabane://actor/agent/test",
			humanActor,
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

it("rejects invalid MCP inputs, answers by the id kabane_ask returns, and records the connected answer author", async () => {
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
		const [line] = (created.content as { text: string }[]).map((c) => c.text);
		const id = line?.match(/^\S+:1 id:(\S+)$/)?.[1];
		expect(id).toBeDefined();
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
			arguments: { question: id, answer: "b" },
		});
		expect(answer.isError).not.toBe(true);
		const row = unwrap(await Questions.list(base, { id: task.id }))[0];
		expect(row).toMatchObject({
			id,
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
	const [one, two] = unwrap(
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
			`## ${task.shortId} Paged · normal · waiting\n\n${task.shortId}:1 First? (choices only) id:${one?.id}\n- A\n- B ★\nwhy: B is local\n\nnextCursor: ${cursor}`,
		);
		expect(await text({ id: task.id, limit: 1, cursor })).toBe(
			`## ${task.shortId} Paged · normal · waiting\n\n${task.shortId}:2 Second? id:${two?.id}`,
		);
		expect(await text({ scopeUri: "nowhere" })).toBe("No questions found.");
	} finally {
		await client.close();
	}
});

it("refuses a question over the page budget with a kabane_context hint that works as written", async () => {
	const task = unwrap(
		await Planner.addTask(base, { title: "Oversize", kind: "issue" }),
	);
	unwrap(
		await Questions.ask(base, {
			id: task.id,
			questions: [{ question: "é".repeat(8000), why: "è".repeat(8000) }],
		}),
	);
	const client = await connect(false);
	try {
		const page = await client.callTool({
			name: "kabane_questions",
			arguments: { id: task.id },
		});
		expect(page.isError).toBe(true);
		const hint = (page.content as { text: string }[])[0]?.text ?? "";
		expect(hint).toContain(
			'kabane_context, responseFormat: "concise", sections: ["questions.decisions"]',
		);
		const brief = await client.callTool({
			name: "kabane_context",
			arguments: {
				id: task.id,
				responseFormat: "concise",
				sections: ["questions.decisions"],
			},
		});
		expect(brief.isError).not.toBe(true);
		expect(JSON.stringify(brief.content)).toContain("## Decisions");
	} finally {
		await client.close();
	}
});

it("withdraws open questions when kabane_done or kabane_edit closes the issue", async () => {
	const client = await connect(false);
	try {
		for (const [name, extra] of [
			["kabane_done", {}],
			["kabane_edit", { state: "cancelled" }],
		] as const) {
			const task = unwrap(
				await Planner.addTask(base, { title: name, kind: "issue" }),
			);
			unwrap(
				await Questions.ask(base, {
					id: task.id,
					questions: [{ question: "Still needed?" }],
				}),
			);
			const closed = await client.callTool({
				name,
				arguments: { id: task.id, ...extra },
			});
			expect(closed.isError).not.toBe(true);
			const open = await client.callTool({
				name: "kabane_questions",
				arguments: { id: task.id },
			});
			expect((open.content as { text: string }[])[0]?.text).toBe(
				"No questions found.",
			);
			expect(
				unwrap(await Questions.list(base, { id: task.id }))[0],
			).toMatchObject({
				status: "withdrawn",
				reasoning: Questions.CLOSED_REASON,
			});
		}
	} finally {
		await client.close();
	}
});

it("credits a relayed answer to the human, the plain one to the agent, and refuses relayed without a human", async () => {
	// As `kabane mcp --as <agent>` runs: every write stamped by the agent.
	configureTestRuntime({
		modules: [questionsModule],
		actor: () => "cabane://actor/agent/test",
	});
	const task = unwrap(
		await Planner.addTask(base, { title: "Relay", kind: "issue" }),
	);
	unwrap(
		await Questions.ask(base, {
			id: task.id,
			questions: [
				{ question: "Relayed?" },
				{ question: "Own?" },
				{ question: "Nobody?" },
			],
		}),
	);
	const answer = async (
		client: Awaited<ReturnType<typeof connect>>,
		args: Record<string, unknown>,
	) => {
		const result = await client.callTool({
			name: "kabane_answer",
			arguments: args,
		});
		return {
			isError: result.isError === true,
			text: (result.content as { text: string }[])[0]?.text ?? "",
		};
	};
	const relaying = await connect(
		false,
		undefined,
		"cabane://actor/human/david",
	);
	const bare = await connect(false);
	try {
		expect(
			await answer(relaying, {
				question: `${task.shortId}:1`,
				answer: "Yes",
				relayed: true,
			}),
		).toMatchObject({ isError: false });
		expect(
			await answer(relaying, { question: `${task.shortId}:2`, answer: "Mine" }),
		).toMatchObject({ isError: false });
		const refused = await answer(bare, {
			question: `${task.shortId}:3`,
			answer: "Guess",
			relayed: true,
		});
		expect(refused).toEqual({
			isError: true,
			text: "Error: relayed: true needs the human this connection relays for, and cabane://actor/agent/test has none configured. Omit relayed to record the answer as cabane://actor/agent/test.",
		});
		const rows = unwrap(await Questions.list(base, { id: task.id }));
		expect(
			rows.map((row) => [row.status, row.answeredBy, row.updatedBy]),
		).toEqual([
			["answered", "cabane://actor/human/david", "cabane://actor/agent/test"],
			["answered", "cabane://actor/agent/test", "cabane://actor/agent/test"],
			["open", undefined, "cabane://actor/agent/test"],
		]);
		const brief = await relaying.callTool({
			name: "kabane_context",
			arguments: {
				id: task.id,
				responseFormat: "concise",
				sections: ["questions.decisions"],
			},
		});
		expect(JSON.stringify(brief.content)).toContain(
			"Relayed? → Yes (cabane://actor/human/david)",
		);
	} finally {
		await relaying.close();
		await bare.close();
	}
});
