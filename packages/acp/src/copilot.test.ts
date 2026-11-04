// The copilot against the SDK's in-process agent: what reaches the harness on session/new and on
// each prompt, and what the board gets back. No subprocess, no npx, same wire as client.test.ts.
import { describe, expect, it } from "bun:test";
import {
	type AgentApp,
	agent as agentApp,
	type CreateElicitationRequest,
	methods,
	type PlanEntry,
	PROTOCOL_VERSION,
	type ToolCallStatus,
} from "@agentclientprotocol/sdk";
import type { BoardContext } from "@cabane/board/context";
import type {
	CopilotElicitation,
	CopilotPermission,
	CopilotUpdate,
} from "@cabane/board/ports";
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
	initialize: unknown[];
	newSession: unknown[];
	prompts: unknown[];
	// The outcome each permission request came back with, as the agent saw it.
	permissions: unknown[];
	// The answer each form came back with, as the agent saw it.
	forms: unknown[];
};

const fresh = (): Seen => ({
	initialize: [],
	newSession: [],
	prompts: [],
	permissions: [],
	forms: [],
});

// What claude-agent-acp sends for one AskUserQuestion question: the choice, then its optional
// "Other" box.
const ASK_USER_QUESTION = (sessionId: string): CreateElicitationRequest => ({
	mode: "form",
	sessionId,
	toolCallId: "toolu_ask",
	message: "Which store should the cache use?",
	requestedSchema: {
		type: "object",
		properties: {
			question_0: {
				type: "string",
				title: "Store",
				oneOf: [
					{ const: "Redis", title: "Redis" },
					{ const: "Memory", title: "Memory" },
				],
			},
			question_0_custom: { type: "string", title: "Other" },
		},
	},
});

// An agent that runs a scripted list of tool steps, then stops. `permission` makes it ask once
// before the steps, so the decline path is observable.
const scriptedAgent = (
	seen: Seen,
	options: {
		steps?: ToolStep[];
		permission?: boolean;
		// A form the agent puts to the client before the steps.
		form?: (sessionId: string) => CreateElicitationRequest;
		// The agent takes its permission request or form back (`$/cancel_request`) after this many
		// ms, before anyone answers.
		withdrawAfter?: number;
		text?: string;
		plans?: PlanEntry[][];
		// Prose deltas and tool calls in order, to exercise the chunk buffering.
		script?: ({ chunk: "text" | "thought"; text: string } | { tool: string })[];
		// Claude's session modes, opening in this one; `move` is a mode the agent moves itself to
		// during each turn.
		mode?: string;
		move?: string;
		// A notice the agent sends before anything else in the turn.
		notice?: { severity: string; title: string; description?: string };
	} = {},
): AgentApp =>
	agentApp({ name: "scripted" })
		.onRequest(methods.agent.initialize, (c) => {
			seen.initialize.push(c.params);
			return {
				protocolVersion: PROTOCOL_VERSION,
				agentCapabilities: { loadSession: false },
			};
		})
		.onRequest(methods.agent.session.new, (c) => {
			seen.newSession.push(c.params);
			return {
				sessionId: "s-1",
				...(options.mode
					? {
							modes: {
								currentModeId: options.mode,
								availableModes: ["default", "acceptEdits", "plan", "auto"].map(
									(id) => ({
										id,
										name: id,
									}),
								),
							},
						}
					: {}),
			};
		})
		.onRequest(methods.agent.session.setMode, () => ({}))
		.onRequest(methods.agent.session.prompt, async (c) => {
			seen.prompts.push(c.params.prompt);
			const notify = (update: Parameters<typeof AcpClient.toUpdate>[0]) =>
				c.client.notify(methods.client.session.update, {
					sessionId: c.params.sessionId,
					update,
				});
			// What the agent's request is cancelled by, when it withdraws it.
			const withdrawing = ():
				| { cancellationSignal: AbortSignal }
				| undefined => {
				if (options.withdrawAfter === undefined) return undefined;
				const controller = new AbortController();
				setTimeout(() => controller.abort(), options.withdrawAfter);
				return { cancellationSignal: controller.signal };
			};
			if (options.permission) {
				const answer = await c.client.request(
					methods.client.session.requestPermission,
					{
						sessionId: c.params.sessionId,
						toolCall: { toolCallId: "t0", title: "kabane_edit" },
						options: [
							{ optionId: "allow", name: "Allow", kind: "allow_once" },
							{ optionId: "reject", name: "Reject", kind: "reject_once" },
						],
					},
					withdrawing(),
				);
				seen.permissions.push(answer.outcome);
			}
			if (options.form)
				seen.forms.push(
					await c.client.request(
						methods.client.elicitation.create,
						options.form(c.params.sessionId),
						withdrawing(),
					),
				);
			if (options.notice)
				await notify({ sessionUpdate: "notice", ...options.notice });
			if (options.move)
				await notify({
					sessionUpdate: "current_mode_update",
					currentModeId: options.move,
				});
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

const SETUP = {
	configPath: "/home/me/.kabane/config.json",
	extensions: ["loop"],
};

// A copilot wired to an in-process agent instead of a spawned harness.
const copilotOver = (
	agent: AgentApp,
	over: Partial<BoardCopilot.Options> = {},
) =>
	BoardCopilot.create({
		harness: "claude",
		scopeDir: "/repos/cabane",
		scopeUri: "jake://scope/cabane",
		kabaneBin: "/usr/local/bin/kabane",
		home: "/home/me/.kabane",
		setup: SETUP,
		connect: (handlers) => AcpClient.connect("claude", agent, handlers),
		...over,
	});

const collectAll = async (updates: AsyncIterable<{ type: string }>) => {
	const out: { type: string; summary?: string }[] = [];
	for await (const u of updates) out.push(u);
	return out;
};

// A session's first turn opens on its mode line; the tests of the turn's own stream skip it.
const opening = <T extends { type: string }>(updates: T[]): T[] =>
	updates[0]?.type === "mode" ? updates.slice(1) : updates;

const collect = async (updates: AsyncIterable<{ type: string }>) =>
	opening(await collectAll(updates));

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
			connect: (handlers) => {
				connects += 1;
				return AcpClient.connect("claude", scriptedAgent(seen), handlers);
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
					name: "kabane-session",
					command: "/usr/local/bin/kabane",
					args: [
						"mcp",
						"--scope",
						"jake://scope/cabane",
						"--as",
						"cabane://actor/agent/claude",
					],
					env: [{ name: "KABANE_HOME", value: "/home/me/.kabane" }],
				},
			],
			_meta: {
				systemPrompt: { append: CopilotInstructions.systemPrompt(SETUP) },
			},
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

		expect(textOf(seen.prompts[0], 0)).toBe(
			CopilotInstructions.systemPrompt(SETUP),
		);
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

	it("opens the session's first turn on the mode it runs in, and shows the harness's own moves", async () => {
		const copilot = copilotOver(
			scriptedAgent(fresh(), { mode: "default", move: "plan", text: "ok" }),
		);
		const first = await collectAll(copilot.run("go", context()));
		expect(first.slice(0, 2).map((u) => [u.type, u.summary])).toEqual([
			["mode", "mode auto: claude's auto mode, switched from default"],
			["mode", "mode plan: moved there by the harness"],
		]);
		// Neither line again once the session is open and the harness stays put.
		const second = await collectAll(copilot.run("again", context()));
		expect(types(second)).toEqual(["text", "done"]);
		copilot.close();
	});

	it("shows the harness's notice as a step of the turn, after the mode line", async () => {
		const copilot = copilotOver(
			scriptedAgent(fresh(), {
				mode: "acceptEdits",
				notice: {
					severity: "warning",
					title: "Auto mode unavailable",
					description: "Using Accept edits instead.",
				},
				text: "ok",
			}),
		);
		const updates = await collectAll(copilot.run("go", context()));
		expect(updates.slice(0, 2).map((u) => [u.type, u.summary])).toEqual([
			[
				"mode",
				"mode acceptEdits: claude opened in it, not in its manual mode (default), so kabane keeps it over auto",
			],
			[
				"mode",
				"claude warning: Auto mode unavailable: Using Accept edits instead.",
			],
		]);
		copilot.close();
	});

	it("leaves the mode alone when the config turns auto mode off", async () => {
		const copilot = copilotOver(scriptedAgent(fresh(), { mode: "default" }), {
			mode: "default",
		});
		const updates = await collectAll(copilot.run("go", context()));
		expect(updates[0]?.summary).toBe("mode default: auto mode is off");
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
						title: "kabane_context",
						status: "pending",
					},
					{ kind: "update", id: "t1", status: "completed" },
					{ kind: "call", id: "t2", title: "kabane_edit", status: "pending" },
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
			"kabane_edit",
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
						title: "kabane_upstream_link",
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
						title: "mcp__kabane__kabane_link",
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
					{ tool: "kabane_context" },
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
		return opening(updates);
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
				title: "kabane_edit",
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

	// A form blocks the turn the same way, so it is answered from inside the loop as well.
	const filling = async (
		copilot: BoardCopilot.Handle,
		answer: (request: CopilotElicitation) => void | Promise<void>,
	): Promise<CopilotUpdate[]> => {
		const updates: CopilotUpdate[] = [];
		for await (const update of copilot.run("ask me", context())) {
			updates.push(update);
			if (update.type === "elicitation") await answer(update.request);
		}
		return opening(updates);
	};

	it("advertises forms, carries one to the board verbatim and gives the harness the human's answer", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, { form: ASK_USER_QUESTION, text: "Redis it is" }),
		);
		const updates = await filling(copilot, (request) =>
			copilot.answerElicitation(request.id, {
				action: "accept",
				content: { question_0: "Redis" },
			}),
		);
		expect(seen.initialize).toMatchObject([
			{ clientCapabilities: { elicitation: { form: {} } } },
		]);
		expect(types(updates)).toEqual(["elicitation", "text", "done"]);
		expect(updates[0]).toMatchObject({
			request: {
				message: "Which store should the cache use?",
				fields: [
					{
						key: "question_0",
						title: "Store",
						type: "choice",
						options: [
							{ value: "Redis", label: "Redis" },
							{ value: "Memory", label: "Memory" },
						],
					},
					{ key: "question_0_custom", title: "Other", type: "text" },
				],
			},
		});
		expect(seen.forms).toEqual([
			{ action: "accept", content: { question_0: "Redis" } },
		]);
		copilot.close();
	});

	it("a declined form reaches the harness as declined, and a multi-select as a list", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, { form: ASK_USER_QUESTION, text: "ok" }),
		);
		await filling(copilot, (request) =>
			copilot.answerElicitation(request.id, { action: "decline" }),
		);
		await filling(copilot, (request) =>
			copilot.answerElicitation(request.id, {
				action: "accept",
				content: { picks: ["a", "b"] as readonly string[] },
			}),
		);
		expect(seen.forms).toEqual([
			{ action: "decline" },
			{ action: "accept", content: { picks: ["a", "b"] } },
		]);
		copilot.close();
	});

	it("cancel lets go of a form nobody filled in, and nothing answers it twice", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, { form: ASK_USER_QUESTION, text: "ok" }),
		);
		let asked: CopilotElicitation | undefined;
		await filling(copilot, async (request) => {
			asked = request;
			await copilot.cancel();
		});
		if (asked)
			copilot.answerElicitation(asked.id, {
				action: "accept",
				content: { question_0: "Redis" },
			});
		expect(seen.forms).toEqual([{ action: "cancel" }]);
		copilot.close();
	});

	it("a permission the harness withdraws reaches the board as withdrawn, and a late answer is dropped", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, {
				permission: true,
				withdrawAfter: 10,
				text: "moved on",
			}),
		);
		let asked: CopilotPermission | undefined;
		const updates = await answering(copilot, (request) => {
			asked = request;
		});
		if (asked) copilot.answerPermission(asked.id, "allow");
		expect(types(updates)).toEqual(["permission", "withdrawn", "text", "done"]);
		expect(updates[1]).toMatchObject({
			id: "t0",
			summary: "withdrawn by the harness: kabane_edit",
		});
		expect(seen.permissions).toEqual([{ outcome: "cancelled" }]);
		copilot.close();
	});

	it("a form the harness withdraws reaches the board as withdrawn, by the id the board knows it by", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, {
				form: ASK_USER_QUESTION,
				withdrawAfter: 10,
				text: "moved on",
			}),
		);
		let asked: CopilotElicitation | undefined;
		const updates = await filling(copilot, (request) => {
			asked = request;
		});
		if (asked)
			copilot.answerElicitation(asked.id, {
				action: "accept",
				content: { question_0: "Redis" },
			});
		expect(types(updates)).toEqual([
			"elicitation",
			"withdrawn",
			"text",
			"done",
		]);
		expect(updates[1]).toMatchObject({
			id: asked?.id,
			summary: "withdrawn by the harness: Which store should the cache use?",
		});
		expect(seen.forms).toEqual([{ action: "cancel" }]);
		copilot.close();
	});

	it("a request the board let go of first is not reported withdrawn when the harness takes it back", async () => {
		const seen = fresh();
		const copilot = copilotOver(
			scriptedAgent(seen, {
				permission: true,
				withdrawAfter: 30,
				text: "moved on",
			}),
		);
		const updates = await answering(copilot, (request) =>
			copilot.answerPermission(request.id, "allow"),
		);
		expect(types(updates)).toEqual(["permission", "text", "done"]);
		copilot.close();
	});

	it("a harness that will not start ends the turn as one error update", async () => {
		const copilot = copilotOver(scriptedAgent(fresh()), {
			connect: async () => err(new Error("npx: command not found")),
		});
		const updates = await collect(copilot.run("go", context()));
		expect(updates).toHaveLength(1);
		expect(updates[0]?.type).toBe("error");
		expect(updates[0]?.summary).toBe(
			"npx: command not found · another harness: copilot.harness in /home/me/.kabane/config.json, or kabane board --copilot <harness>",
		);
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
			"setup",
			"setup-dispatch",
		]);
		for (const shortcut of copilot.shortcuts()) {
			expect(shortcut.template.length).toBeGreaterThan(20);
			expect(shortcut.hint).not.toBe("");
		}
		copilot.close();
	});
});
