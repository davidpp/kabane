// The copilot against the SDK's in-process agent: what reaches the harness on session/new and on
// each prompt, and what the board gets back. No subprocess, no npx, same wire as client.test.ts.
import { describe, expect, it } from "bun:test";
import {
	type AgentApp,
	agent as agentApp,
	methods,
	type PlanEntry,
	PROTOCOL_VERSION,
	type ToolCallStatus,
} from "@agentclientprotocol/sdk";
import type { BoardContext } from "@cabane/board/context";
import type { CopilotPermission, CopilotUpdate } from "@cabane/board/ports";
import { err } from "@cabane/core";
import { AcpClient } from "./client";
import { BoardCopilot } from "./copilot";
import { CopilotInstructions } from "./instructions";

type ToolStep = {
	kind: "call" | "update";
	id: string;
	title?: string;
	status?: ToolCallStatus;
};

type Seen = {
	newSession: unknown[];
	prompts: unknown[];
	// The outcome each permission request came back with, as the agent saw it.
	permissions: unknown[];
};

const fresh = (): Seen => ({ newSession: [], prompts: [], permissions: [] });

// An agent that runs a scripted list of tool steps, then stops. `permission` makes it ask once
// before the steps, so the decline path is observable.
const scriptedAgent = (
	seen: Seen,
	options: {
		steps?: ToolStep[];
		permission?: boolean;
		text?: string;
		plans?: PlanEntry[][];
		// Prose deltas and tool calls in order, to exercise the chunk buffering.
		script?: ({ chunk: "text" | "thought"; text: string } | { tool: string })[];
	} = {},
): AgentApp =>
	agentApp({ name: "scripted" })
		.onRequest(methods.agent.initialize, () => ({
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: { loadSession: false },
		}))
		.onRequest(methods.agent.session.new, (c) => {
			seen.newSession.push(c.params);
			return { sessionId: "s-1" };
		})
		.onRequest(methods.agent.session.prompt, async (c) => {
			seen.prompts.push(c.params.prompt);
			const notify = (update: Parameters<typeof AcpClient.toUpdate>[0]) =>
				c.client.notify(methods.client.session.update, {
					sessionId: c.params.sessionId,
					update,
				});
			if (options.permission) {
				const answer = await c.client.request(
					methods.client.session.requestPermission,
					{
						sessionId: c.params.sessionId,
						toolCall: { toolCallId: "t0", title: "cabane_edit" },
						options: [
							{ optionId: "allow", name: "Allow", kind: "allow_once" },
							{ optionId: "reject", name: "Reject", kind: "reject_once" },
						],
					},
				);
				seen.permissions.push(answer.outcome);
			}
			if (options.text)
				await notify({
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: options.text },
				});
			for (const step of options.script ?? [])
				await notify(
					"chunk" in step
						? {
								sessionUpdate:
									step.chunk === "text"
										? "agent_message_chunk"
										: "agent_thought_chunk",
								content: { type: "text", text: step.text },
							}
						: {
								sessionUpdate: "tool_call",
								toolCallId: step.tool,
								title: step.tool,
							},
				);
			for (const entries of options.plans ?? [])
				await notify({ sessionUpdate: "plan", entries });
			for (const step of options.steps ?? [])
				await notify(
					step.kind === "call"
						? {
								sessionUpdate: "tool_call",
								toolCallId: step.id,
								title: step.title ?? step.id,
								...(step.status ? { status: step.status } : {}),
							}
						: {
								sessionUpdate: "tool_call_update",
								toolCallId: step.id,
								...(step.title ? { title: step.title } : {}),
								...(step.status ? { status: step.status } : {}),
							},
				);
			return { stopReason: "end_turn" };
		});

const context = (
	over: Partial<BoardContext.Context> = {},
): BoardContext.Context => ({
	scopeUri: "jake://scope/cabane",
	view: "board",
	section: "next",
	filter: { kind: "all", status: "open" },
	selected: { id: "01ABC", shortId: "JCAB-33", title: "Sweep the backlog" },
	marked: [],
	briefs: [{ shortId: "JCAB-33", brief: "# JCAB-33\n\nthe assembled brief" }],
	truncated: false,
	...over,
});

// A copilot wired to an in-process agent instead of a spawned harness.
const copilotOver = (
	agent: AgentApp,
	over: Partial<BoardCopilot.Options> = {},
) =>
	BoardCopilot.create({
		harness: "claude",
		scopeDir: "/repos/cabane",
		scopeUri: "jake://scope/cabane",
		cabaneBin: "/usr/local/bin/cabane",
		connect: (onPermission) =>
			AcpClient.connect("claude", agent, { onPermission }),
		...over,
	});

const collect = async (updates: AsyncIterable<{ type: string }>) => {
	const out: { type: string; summary?: string }[] = [];
	for await (const u of updates) out.push(u);
	return out;
};

const types = (updates: { type: string }[]): string[] =>
	updates.map((u) => u.type);

const textOf = (prompt: unknown, index: number): string => {
	const blocks = Array.isArray(prompt) ? prompt : [];
	const block = blocks[index];
	return typeof block === "object" && block !== null && "text" in block
		? String(block.text)
		: "";
};

describe("BoardCopilot", () => {
	it("starts no harness until the first run", async () => {
		const seen = fresh();
		let connects = 0;
		const copilot = copilotOver(scriptedAgent(seen), {
			connect: (onPermission) => {
				connects += 1;
				return AcpClient.connect("claude", scriptedAgent(seen), {
					onPermission,
				});
			},
		});
		expect(connects).toBe(0);
		expect(copilot.shortcuts().map((s) => s.name)).toContain("triage");
		await collect(copilot.run("triage this", context()));
		expect(connects).toBe(1);
		copilot.close();
	});

	it("gives session/new the scope dir and cabane mcp as its one tool server", async () => {
		const seen = fresh();
		const copilot = copilotOver(scriptedAgent(seen));
		await collect(copilot.run("go", context()));
		expect(seen.newSession[0]).toEqual({
			cwd: "/repos/cabane",
			mcpServers: [
				{
					name: "cabane",
					command: "/usr/local/bin/cabane",
					args: [
						"mcp",
						"--scope",
						"jake://scope/cabane",
						"--as",
						"cabane://actor/agent/claude",
					],
					env: [],
				},
			],
			_meta: { systemPrompt: { append: CopilotInstructions.SYSTEM_PROMPT } },
		});
		copilot.close();
	});

	it("omits --scope when the board is open on every scope", async () => {
		const seen = fresh();
		const copilot = copilotOver(scriptedAgent(seen), { scopeUri: undefined });
		await collect(copilot.run("go", context({ scopeUri: undefined })));
		const server = (seen.newSession[0] as { mcpServers: { args: string[] }[] })
			.mcpServers[0];
		expect(server?.args).toEqual([
			"mcp",
			"--as",
			"cabane://actor/agent/claude",
		]);
		copilot.close();
	});

	it("carries the instruction block on the first prompt only, the context block on every one", async () => {
		const seen = fresh();
		const copilot = copilotOver(scriptedAgent(seen));
		await collect(
			copilot.run("verify which of these are still real todos", context()),
		);
		await collect(copilot.run("now split the first one", context()));

		expect(textOf(seen.prompts[0], 0)).toBe(CopilotInstructions.SYSTEM_PROMPT);
		const firstContext = textOf(seen.prompts[0], 1);
		expect(firstContext).toContain("scope: jake://scope/cabane");
		expect(firstContext).toContain("selected: JCAB-33 · Sweep the backlog");
		expect(firstContext).toContain("the assembled brief");
		expect(textOf(seen.prompts[0], 2)).toBe(
			"verify which of these are still real todos",
		);

		// Second turn: context block, then the prompt. No instructions.
		expect(textOf(seen.prompts[1], 0)).toContain("scope: jake://scope/cabane");
		expect(textOf(seen.prompts[1], 1)).toBe("now split the first one");
		copilot.close();
	});

	it("a completed cabane write yields tool_result, a read does not", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, {
				steps: [
					{
						kind: "call",
						id: "t1",
						title: "cabane_context",
						status: "pending",
					},
					{ kind: "update", id: "t1", status: "completed" },
					{ kind: "call", id: "t2", title: "cabane_edit", status: "pending" },
					{ kind: "update", id: "t2", status: "completed" },
				],
			}),
		);
		const updates = await collect(copilot.run("triage", context()));
		expect(types(updates)).toEqual([
			"tool_call",
			"tool_call",
			"tool_result",
			"done",
		]);
		expect(updates.find((u) => u.type === "tool_result")?.summary).toBe(
			"cabane_edit",
		);
		copilot.close();
	});

	// Recording a link is what makes the row's linked-issue glyph appear, so it has to reach the
	// board the same way any other write does.
	it("a completed upstream link is a write, so the board reloads", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, {
				steps: [
					{
						kind: "call",
						id: "t1",
						title: "cabane_upstream_link",
						status: "completed",
					},
				],
			}),
		);
		const updates = await collect(copilot.run("/linear", context()));
		expect(types(updates)).toEqual(["tool_call", "tool_result", "done"]);
		copilot.close();
	});

	it("recognises a write through a namespaced title and a call that completes in one step", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, {
				steps: [
					{
						kind: "call",
						id: "t1",
						title: "mcp__cabane__cabane_link",
						status: "completed",
					},
					{ kind: "call", id: "t2", title: "Read", status: "completed" },
				],
			}),
		);
		const updates = await collect(copilot.run("link them", context()));
		expect(types(updates)).toEqual([
			"tool_call",
			"tool_result",
			"tool_call",
			"done",
		]);
		copilot.close();
	});

	it("joins a run of prose deltas into one update, and keeps runs either side of a tool call apart", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, {
				script: [
					// Exactly the shape the codex harness sends: split mid-word.
					{ chunk: "text", text: "I" },
					{ chunk: "text", text: "'ll read" },
					{ chunk: "text", text: " the iss" },
					{ chunk: "text", text: "ue's context first." },
					{ tool: "cabane_context" },
					{ chunk: "text", text: "Two are stale." },
				],
			}),
		);
		const updates = await collect(copilot.run("check", context()));
		expect(types(updates)).toEqual(["text", "tool_call", "text", "done"]);
		const [first, second] = updates.filter((u) => u.type === "text");
		expect(first?.summary).toBe("I'll read the issue's context first.");
		// The run that follows the tool call is its own message, not a continuation.
		expect(second?.summary).toBe("Two are stale.");
		copilot.close();
	});

	it("a thought run and a message run stay separate updates", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, {
				script: [
					{ chunk: "thought", text: "weighing " },
					{ chunk: "thought", text: "the options" },
					{ chunk: "text", text: "Here is " },
					{ chunk: "text", text: "what I found." },
				],
			}),
		);
		const updates = await collect(copilot.run("check", context()));
		expect(types(updates)).toEqual(["thought", "text", "done"]);
		expect(updates[0]?.summary).toBe("weighing the options");
		expect(updates[1]?.summary).toBe("Here is what I found.");
		copilot.close();
	});

	it("streams the harness's plan through, entry for entry", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, {
				plans: [
					[
						{
							content: "read the issue",
							priority: "high",
							status: "in_progress",
						},
						{ content: "split it", priority: "medium", status: "pending" },
					],
					[
						{
							content: "read the issue",
							priority: "high",
							status: "completed",
						},
						{ content: "split it", priority: "medium", status: "in_progress" },
					],
				],
			}),
		);
		const updates = await collect(copilot.run("split this", context()));
		expect(types(updates)).toEqual(["plan", "plan", "done"]);
		const [first, second] = updates.filter((u) => u.type === "plan");
		expect(first).toMatchObject({
			entries: [
				{ content: "read the issue", status: "in_progress" },
				{ content: "split it", status: "pending" },
			],
		});
		expect(second).toMatchObject({
			entries: [
				{ content: "read the issue", status: "completed" },
				{ content: "split it", status: "in_progress" },
			],
		});
		copilot.close();
	});

	// The turn is BLOCKED from the request until the answer, so these drive the stream by hand:
	// nothing else can arrive on it in the meantime, which is the whole reason the request has to
	// reach the board out of band.
	const answering = async (
		copilot: BoardCopilot.Handle,
		answer: (request: CopilotPermission) => void | Promise<void>,
	): Promise<CopilotUpdate[]> => {
		const updates: CopilotUpdate[] = [];
		for await (const update of copilot.run("edit it", context())) {
			updates.push(update);
			if (update.type === "permission") await answer(update.request);
		}
		return updates;
	};

	it("carries a permission request to the board and lets it pick an option", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, { permission: true, text: "carrying on" }),
		);
		const updates = await answering(copilot, (request) =>
			copilot.answerPermission(request.id, "allow"),
		);
		expect(types(updates)).toEqual(["permission", "text", "done"]);
		expect(updates[0]).toMatchObject({
			request: {
				id: "t0",
				title: "cabane_edit",
				options: [
					{ id: "allow", label: "Allow" },
					{ id: "reject", label: "Reject" },
				],
			},
		});
		expect(seen.permissions).toEqual([
			{ outcome: "selected", optionId: "allow" },
		]);
		copilot.close();
	});

	it("a decline reaches the harness as cancelled, and the turn carries on", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, { permission: true, text: "carrying on" }),
		);
		const updates = await answering(copilot, (request) =>
			copilot.answerPermission(request.id, null),
		);
		expect(types(updates)).toEqual(["permission", "text", "done"]);
		expect(seen.permissions).toEqual([{ outcome: "cancelled" }]);
		copilot.close();
	});

	it("cancel lets go of a request nobody answered, so the harness is not left waiting", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, { permission: true, text: "carrying on" }),
		);
		const updates = await answering(copilot, () => copilot.cancel());
		expect(types(updates)).toContain("permission");
		expect(seen.permissions).toEqual([{ outcome: "cancelled" }]);
		copilot.close();
	});

	it("answering a request that is no longer outstanding changes nothing", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, { permission: true, text: "carrying on" }),
		);
		const updates = await answering(copilot, (request) => {
			copilot.answerPermission(request.id, "allow");
			copilot.answerPermission(request.id, "reject");
			copilot.answerPermission("never-asked", "allow");
		});
		expect(types(updates)).toEqual(["permission", "text", "done"]);
		expect(seen.permissions).toEqual([
			{ outcome: "selected", optionId: "allow" },
		]);
		copilot.close();
	});

	it("a harness that will not start ends the turn as one error update", async () => {
		const copilot = copilotOver(scriptedAgent(fresh()), {
			connect: async () => err(new Error("npx: command not found")),
		});
		const updates = await collect(copilot.run("go", context()));
		expect(updates).toHaveLength(1);
		expect(updates[0]?.type).toBe("error");
		expect(updates[0]?.summary).toBe("npx: command not found");
		copilot.close();
	});

	it("cancel before any turn is a no-op, and shortcuts are stable names with templates", async () => {
		const copilot = copilotOver(scriptedAgent(fresh()));
		await copilot.cancel();
		const names = copilot.shortcuts().map((s) => s.name);
		expect(names).toEqual([
			"triage",
			"refine",
			"split",
			"duplicates",
			"reparent",
			"check-plan",
			"linear",
			"github",
		]);
		for (const shortcut of copilot.shortcuts()) {
			expect(shortcut.template.length).toBeGreaterThan(20);
			expect(shortcut.hint).not.toBe("");
		}
		copilot.close();
	});
});
