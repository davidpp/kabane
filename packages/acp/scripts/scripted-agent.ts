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
 *   ask color       a form that requires a field kabane cannot ask, which it refuses
 *   ask permission  a tool call that asks before it runs
 *   plan            a plan ticking through its entries
 *   tools           a few tool calls with their input and output
 *   long            a long reply, streamed in chunks
 *   anything else   echoed back
 *
 * A loop run's review triage brief (it opens with TRIAGE) is answered with a review plan, so a
 * loop run reaches its lenses through a triage live: every lens it lists but the last in one
 * group at tier fast, and the last skipped. Its implementing session's brief (it opens with "You
 * are one implementing session", or "the" for a single issue) gets one commit of a file in the
 * session's directory, then kabane_done on its issue through the kabane MCP server session/new
 * named, so the run's gates, merge and lenses follow. A lens, a recheck and the fixer are echoed,
 * which files and closes nothing.
 *
 * After an ask is answered it says what it received, so a flow is checkable end to end. Its first
 * reply in a session opens by saying what it is, since the pane's title names the harness id the
 * sandbox launches it under, claude, and that alone reads as a real harness answering.
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
import { z } from "zod";
import type { AcpClient } from "../src/client";

type Update = Parameters<typeof AcpClient.toUpdate>[0];
type Context = { client: AgentContext; sessionId: string };

const KEYWORDS = [
	"ask form",
	"ask multi",
	"ask text",
	"ask color",
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
	"ask form" | "ask multi" | "ask text" | "ask color",
	(sessionId: string) => CreateElicitationRequest
> = {
	"ask form": (sessionId) => ({
		mode: "form",
		sessionId,
		toolCallId: crypto.randomUUID(),
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
		toolCallId: crypto.randomUUID(),
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
		toolCallId: crypto.randomUUID(),
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
	// A type outside ACP's form schema, as a vendor extension would send it.
	"ask color": (sessionId) => ({
		mode: "form",
		sessionId,
		message: "Which accent should the board use?",
		requestedSchema: {
			type: "object",
			properties: { accent: { type: "_color", title: "Accent" } as never },
			required: ["accent"],
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
	// ACP call ids are unique across the session, including repeated scripted turns.
	const toolCallId = crypto.randomUUID();
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
	for (const tool of TOOLS) {
		const toolCallId = crypto.randomUUID();
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

// `Review.OPENING` in extensions/loop/src/review.ts: a loop run's triage brief starts with it.
const TRIAGE = "You are the review triage of kabane loop run";

const runTriage = async (ctx: Context, text: string): Promise<boolean> => {
	const lenses = [...text.matchAll(/^- `([a-z][a-z0-9-]*)`/gm)].map(
		([, name]) => name,
	);
	const last = lenses.at(-1);
	const plan = {
		groups: [
			{
				lenses: lenses.slice(0, -1),
				tier: "fast",
				reason: "scripted: one session for every lens but the last",
			},
		],
		skipped: last
			? [{ lens: last, reason: "scripted: the last lens is skipped" }]
			: [],
	};
	await say(ctx, `\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\``);
	return false;
};

// `Brief.instructions` in extensions/loop/src/brief.ts: a loop run's implementing session is told
// which issue is its own in its first two lines.
const IMPLEMENTING =
	/^You are (?:one|the) implementing session of kabane loop run [^\n]*\n\nYour (?:subtask|issue) is (\S+?)\. /;

// What session/new handed the session: where it works, and the MCP servers a harness connects to.
type Opened = { cwd: string; servers: readonly Server[] };
type Server = {
	command: string;
	args: string[];
	env: { name: string; value: string }[];
};
const opened = new Map<string, Opened>();

const JsonRpcReply = z.object({
	id: z.unknown().optional(),
	result: z.unknown().optional(),
	error: z.object({ message: z.string() }).optional(),
});

const parsed = (line: string): unknown => {
	try {
		return JSON.parse(line);
	} catch {
		return undefined;
	}
};

/**
 * One tool call over the MCP server the session was given, as a harness makes it: spawn it, the
 * initialize handshake, `tools/call`, then close it. What the call answered, or why it failed.
 */
const callTool = async (
	server: Server,
	name: string,
	args: Record<string, unknown>,
): Promise<string> => {
	const proc = Bun.spawn([server.command, ...server.args], {
		env: {
			...process.env,
			...Object.fromEntries(server.env.map((e) => [e.name, e.value])),
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	// Read from the start, so a server that writes a lot to stderr never blocks on a full pipe.
	const said = new Response(proc.stderr).text();
	// A server that has exited breaks the pipe: what it printed says why, below.
	const send = async (message: Record<string, unknown>) => {
		try {
			await proc.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`,
			);
			await proc.stdin.flush();
		} catch {
			// Its exit and stderr are the answer.
		}
	};
	const lines = (async function* () {
		let buffered = "";
		for await (const chunk of proc.stdout.pipeThrough(
			new TextDecoderStream(),
		)) {
			buffered += chunk;
			let at = buffered.indexOf("\n");
			while (at >= 0) {
				yield buffered.slice(0, at);
				buffered = buffered.slice(at + 1);
				at = buffered.indexOf("\n");
			}
		}
	})();
	// Read with next(), not for-await: leaving a for-await early would close the stream for the
	// second reply.
	const reply = async (id: number) => {
		for (let next = await lines.next(); !next.done; next = await lines.next()) {
			const message = JsonRpcReply.safeParse(parsed(next.value));
			if (message.success && message.data.id === id) return message.data;
		}
		return undefined;
	};
	await send({
		id: 1,
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "kabane-scripted", version: "0.0.0" },
		},
	});
	const ready = await reply(1);
	await send({ method: "notifications/initialized" });
	await send({
		id: 2,
		method: "tools/call",
		params: { name, arguments: args },
	});
	const called = ready ? await reply(2) : undefined;
	proc.kill();
	if (!ready)
		return `the MCP server did not initialize: ${(await said).trim() || "it said nothing"}`;
	if (!called) return `${name} got no answer`;
	if (called.error) return `${name} failed: ${called.error.message}`;
	return `${name} answered ${JSON.stringify(called.result)}`;
};

const git = async (
	cwd: string,
	args: string[],
): Promise<string | undefined> => {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "ignore",
		stderr: "pipe",
	});
	const [exit, said] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
	]);
	return exit === 0 ? undefined : `git ${args[0]} failed: ${said.trim()}`;
};

/**
 * A loop run's implementer: one commit in its working directory, then kabane_done on its issue
 * through the kabane MCP server the run gave the session. A lens or a recheck needs no keyword: its
 * echo ends the turn having filed nothing.
 */
const runImplementing = async (ctx: Context, id: string): Promise<boolean> => {
	const session = opened.get(ctx.sessionId);
	const server = session?.servers[0];
	if (!session || !server) {
		await say(ctx, `No working directory or MCP server for ${id}: left open.`);
		return false;
	}
	const file = `scripted-${id}.txt`;
	await Bun.write(`${session.cwd}/${file}`, `${id}: a scripted change\n`);
	const failed =
		(await git(session.cwd, ["add", file])) ??
		(await git(session.cwd, ["commit", "-q", "-m", `${id}: scripted change`]));
	if (failed) {
		await say(ctx, `${failed}: ${id} left open.`);
		return false;
	}
	await say(
		ctx,
		`Committed ${file}. ${await callTool(server, "kabane_done", { id })}`,
	);
	return false;
};

const INTRO =
	"Scripted agent (packages/acp/scripts/scripted-agent.ts), not claude: the sandbox runs it under claude's harness id.\n\n";
const introduced = new Set<string>();

// One turn: whether it ended on a cancel.
const turn = async (ctx: Context, text: string): Promise<boolean> => {
	if (!introduced.has(ctx.sessionId)) {
		introduced.add(ctx.sessionId);
		await say(ctx, INTRO);
	}
	if (text.startsWith(TRIAGE)) return runTriage(ctx, text);
	const implementing = IMPLEMENTING.exec(text)?.[1];
	if (implementing) return runImplementing(ctx, implementing);
	const keyword = keywordOf(text);
	switch (keyword) {
		case "ask form":
		case "ask multi":
		case "ask text":
		case "ask color":
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
	.onRequest(methods.agent.session.new, (c) => {
		const sessionId = `scripted-${crypto.randomUUID()}`;
		opened.set(sessionId, {
			cwd: c.params.cwd,
			servers: c.params.mcpServers.flatMap((server) =>
				"command" in server ? [server] : [],
			),
		});
		return { sessionId };
	})
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
