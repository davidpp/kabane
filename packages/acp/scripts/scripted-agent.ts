#!/usr/bin/env bun
/**
 * A deterministic ACP agent over stdio, for driving the board's copilot without a real harness:
 * `bun run sandbox --scripted` points the copilot's launch command here. It is the SDK's own agent
 * builder, the double `client.test.ts` and `copilot.test.ts` run in process, served over a real
 * subprocess and the real wire, so `AcpClient`, the copilot and the board are the ones that ship.
 * It proves nothing about what a real adapter sends: a real harness's asks stay a manual check.
 *
 * The prompt's last block (what the human typed) picks the turn:
 *
 *   ask form        a single choice with descriptions and an Other box (claude's AskUserQuestion)
 *   ask multi       a multi-select with descriptions and no item cap
 *   ask text        a text field
 *   ask permission  a tool call that asks before it runs
 *   plan            a plan ticking through its entries
 *   tools           a few tool calls with their input and output
 *   long            a long reply, streamed in chunks
 *   anything else   echoed back
 *
 * After an ask is answered it says what it received, so a flow is checkable end to end.
 */
import {
	agent,
	type AgentContext,
	type CreateElicitationRequest,
	type CreateElicitationResponse,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type { AcpClient } from "../src/client";

type Update = Parameters<typeof AcpClient.toUpdate>[0];
type Context = { client: AgentContext; sessionId: string };

const KEYWORDS = [
	"ask form",
	"ask multi",
	"ask text",
	"ask permission",
	"plan",
	"tools",
	"long",
] as const;
type Keyword = (typeof KEYWORDS)[number];

// The copilot sends its instructions and the board's context ahead of what was typed; only the
// last block is the human's.
const typed = (prompt: readonly { type: string; text?: string }[]): string =>
	prompt.findLast((block) => block.type === "text")?.text?.trim() ?? "";

const keywordOf = (text: string): Keyword | undefined =>
	KEYWORDS.find((keyword) => text.toLowerCase().startsWith(keyword));

// A session/cancel flips this; every pause checks it, so a cancelled turn ends at the next one.
let cancelled = false;
const pause = async (ms: number): Promise<boolean> => {
	await Bun.sleep(ms);
	return cancelled;
};

const notify = (ctx: Context, update: Update) =>
	ctx.client.notify(methods.client.session.update, {
		sessionId: ctx.sessionId,
		update,
	});

const say = (ctx: Context, text: string) =>
	notify(ctx, {
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text },
	});

const FORMS: Record<
	"ask form" | "ask multi" | "ask text",
	(sessionId: string) => CreateElicitationRequest
> = {
	"ask form": (sessionId) => ({
		mode: "form",
		sessionId,
		toolCallId: "ask-form",
		message:
			"Which delivery contract should the runner hold to when a harness drops its session?",
		requestedSchema: {
			type: "object",
			properties: {
				question_0: {
					type: "string",
					title: "Delivery",
					oneOf: [
						{
							const: "At most once",
							title: "At most once",
							description: "Drop the turn and report it failed",
						},
						{
							const: "At least once",
							title: "At least once",
							description: "Replay the turn from its last checkpoint",
						},
						{ const: "Ask the human", title: "Ask the human" },
					],
				},
				question_0_custom: { type: "string", title: "Other" },
			},
		},
	}),
	"ask multi": (sessionId) => ({
		mode: "form",
		sessionId,
		toolCallId: "ask-multi",
		message: "Which checks should the gate run before a merge?",
		requestedSchema: {
			type: "object",
			properties: {
				checks: {
					type: "array",
					title: "Checks",
					items: {
						anyOf: [
							{
								const: "lint",
								title: "Lint",
								description: "oxlint, both passes",
							},
							{
								const: "types",
								title: "Types",
								description: "tsc in every package",
							},
							{ const: "tests", title: "Tests", description: "bun and vitest" },
							{ const: "dupes", title: "Duplicates" },
						],
					},
				},
			},
			required: ["checks"],
		},
	}),
	"ask text": (sessionId) => ({
		mode: "form",
		sessionId,
		toolCallId: "ask-text",
		message: "What should the new scope be called?",
		requestedSchema: {
			type: "object",
			properties: {
				slug: {
					type: "string",
					title: "Slug",
					description: "Lowercase letters, used in every issue id",
					maxLength: 12,
				},
			},
			required: ["slug"],
		},
	}),
};

const askForm = async (ctx: Context, keyword: keyof typeof FORMS) => {
	await say(ctx, "One question first.");
	const answer = await ctx.client.request(
		methods.client.elicitation.create,
		FORMS[keyword](ctx.sessionId),
	);
	await say(ctx, `Received: ${received(answer)}`);
};

// What a form came back with, as `key = value` pairs. Not JSON: the transcript renders markdown,
// where a multi-select's `["a","b"]` reads as a link and loses its brackets.
const received = (answer: CreateElicitationResponse): string => {
	if (answer.action !== "accept") return answer.action;
	const pairs = Object.entries(answer.content ?? {}).map(
		([key, value]) =>
			`${key} = ${Array.isArray(value) ? value.join(", ") : String(value)}`,
	);
	return pairs.length > 0 ? pairs.join("; ") : "accepted, nothing filled in";
};

const askPermission = async (ctx: Context) => {
	const toolCallId = "edit-1";
	await notify(ctx, {
		sessionUpdate: "tool_call",
		toolCallId,
		title: "kabane_edit JREP-1",
		kind: "edit",
		status: "pending",
		rawInput: { id: "JREP-1", state: "next" },
	});
	const answer = await ctx.client.request(
		methods.client.session.requestPermission,
		{
			sessionId: ctx.sessionId,
			toolCall: { toolCallId, title: "kabane_edit JREP-1" },
			options: [
				{ optionId: "allow", name: "Allow once", kind: "allow_once" },
				{ optionId: "always", name: "Allow always", kind: "allow_always" },
				{ optionId: "reject", name: "Reject", kind: "reject_once" },
			],
		},
	);
	const chosen =
		answer.outcome.outcome === "selected"
			? answer.outcome.optionId
			: "cancelled";
	const ran = chosen === "allow" || chosen === "always";
	await notify(ctx, {
		sessionUpdate: "tool_call_update",
		toolCallId,
		status: ran ? "completed" : "failed",
		rawOutput: ran ? { ok: true } : { error: `not run: ${chosen}` },
	});
	await say(ctx, `Received: ${chosen}`);
};

const PLAN = [
	"Read the selection",
	"Compare the options",
	"Draft the steps",
	"File the follow-ups",
];

const runPlan = async (ctx: Context): Promise<boolean> => {
	for (let done = 0; done <= PLAN.length; done++) {
		await notify(ctx, {
			sessionUpdate: "plan",
			entries: PLAN.map((content, index) => ({
				content,
				priority: "medium",
				status:
					index < done
						? "completed"
						: index === done
							? "in_progress"
							: "pending",
			})),
		});
		if (await pause(900)) return true;
	}
	await say(ctx, `Plan done: ${PLAN.length} steps.`);
	return false;
};

const TOOLS = [
	{
		title: "kabane_list",
		kind: "read",
		input: { state: "next" },
		output: "3 issues",
	},
	{
		title: "kabane_context JREP-1",
		kind: "read",
		input: { id: "JREP-1" },
		output: "JREP-1: Session tokens survive a restart",
	},
	{
		title: "bun test",
		kind: "execute",
		input: { command: "bun test" },
		output: "42 pass, 0 fail",
	},
] as const;

const runTools = async (ctx: Context): Promise<boolean> => {
	for (const [index, tool] of TOOLS.entries()) {
		const toolCallId = `tool-${index + 1}`;
		await notify(ctx, {
			sessionUpdate: "tool_call",
			toolCallId,
			title: tool.title,
			kind: tool.kind,
			status: "in_progress",
			rawInput: tool.input,
		});
		if (await pause(500)) return true;
		await notify(ctx, {
			sessionUpdate: "tool_call_update",
			toolCallId,
			status: "completed",
			content: [
				{ type: "content", content: { type: "text", text: tool.output } },
			],
			rawOutput: { result: tool.output },
		});
	}
	await say(ctx, `Ran ${TOOLS.length} tools.`);
	return false;
};

const LONG = Array.from(
	{ length: 12 },
	(_, i) =>
		`Paragraph ${i + 1}: the runner replays a dropped turn from its last checkpoint, so a harness that loses its session mid-edit picks up where it left off rather than starting over.`,
).join("\n\n");

const runLong = async (ctx: Context): Promise<boolean> => {
	for (let at = 0; at < LONG.length; at += 40) {
		await say(ctx, LONG.slice(at, at + 40));
		if (await pause(15)) return true;
	}
	return false;
};

// One turn: whether it ended on a cancel.
const turn = async (ctx: Context, text: string): Promise<boolean> => {
	const keyword = keywordOf(text);
	switch (keyword) {
		case "ask form":
		case "ask multi":
		case "ask text":
			await askForm(ctx, keyword);
			return cancelled;
		case "ask permission":
			await askPermission(ctx);
			return cancelled;
		case "plan":
			return runPlan(ctx);
		case "tools":
			return runTools(ctx);
		case "long":
			return runLong(ctx);
		case undefined:
			await say(
				ctx,
				`Echo: ${text || "(nothing typed)"}\nTry one of: ${KEYWORDS.join(", ")}.`,
			);
			return false;
	}
};

const app = agent({ name: "kabane-scripted" })
	.onRequest(methods.agent.initialize, () => ({
		protocolVersion: PROTOCOL_VERSION,
		agentCapabilities: { loadSession: false },
		agentInfo: { name: "kabane-scripted", version: "0.0.0" },
	}))
	.onRequest(methods.agent.session.new, () => ({
		sessionId: `scripted-${crypto.randomUUID()}`,
	}))
	.onNotification(methods.agent.session.cancel, () => {
		cancelled = true;
	})
	.onRequest(methods.agent.session.prompt, async (c) => {
		cancelled = false;
		const ended = await turn(
			{ client: c.client, sessionId: c.params.sessionId },
			typed(c.params.prompt),
		);
		return { stopReason: ended ? "cancelled" : "end_turn" };
	});

const stdout = new WritableStream<Uint8Array>({
	write: (chunk) => {
		process.stdout.write(chunk);
	},
});
const connection = app.connect(ndJsonStream(stdout, Bun.stdin.stream()));
await connection.closed;
