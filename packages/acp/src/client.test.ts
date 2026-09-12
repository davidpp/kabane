// The client against the SDK's in-process agent builder: no subprocess, no npx, same wire.
import { describe, expect, it } from "bun:test";
import {
	type AgentApp,
	agent as agentApp,
	methods,
	PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import { err, ok } from "@cabane/core";
import { AcpClient } from "./client";

type Seen = { newSession: unknown[]; prompts: unknown[]; cancels: number };

// A scripted agent: streams text, a tool call, asks permission when told, honours cancel.
const scriptedAgent = (
	seen: Seen,
	options: { permission?: boolean; hang?: boolean } = {},
): AgentApp => {
	let cancelled = false;
	return agentApp({ name: "scripted" })
		.onRequest(methods.agent.initialize, () => ({
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: { loadSession: false },
		}))
		.onRequest(methods.agent.session.new, (c) => {
			seen.newSession.push(c.params);
			return { sessionId: "s-1" };
		})
		.onNotification(methods.agent.session.cancel, () => {
			seen.cancels += 1;
			cancelled = true;
		})
		.onRequest(methods.agent.session.prompt, async (c) => {
			seen.prompts.push(c.params.prompt);
			const notify = (update: Parameters<typeof AcpClient.toUpdate>[0]) =>
				c.client.notify(methods.client.session.update, {
					sessionId: c.params.sessionId,
					update,
				});
			await notify({
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: "hello " },
			});
			await notify({
				sessionUpdate: "agent_thought_chunk",
				content: { type: "text", text: "hmm" },
			});
			await notify({
				sessionUpdate: "tool_call",
				toolCallId: "t1",
				title: "cabane_edit",
				kind: "edit",
				status: "pending",
			});
			if (options.permission) {
				const answer = await c.client.request(
					methods.client.session.requestPermission,
					{
						sessionId: c.params.sessionId,
						toolCall: { toolCallId: "t1", title: "cabane_edit" },
						options: [
							{ optionId: "allow", name: "Allow", kind: "allow_once" },
							{ optionId: "reject", name: "Reject", kind: "reject_once" },
						],
					},
				);
				await notify({
					sessionUpdate: "agent_message_chunk",
					content: {
						type: "text",
						text:
							answer.outcome.outcome === "selected"
								? `chose:${answer.outcome.optionId}`
								: "chose:cancelled",
					},
				});
			}
			if (options.hang) {
				while (!cancelled) await Bun.sleep(5);
				return { stopReason: "cancelled" };
			}
			await notify({
				sessionUpdate: "tool_call_update",
				toolCallId: "t1",
				status: "completed",
			});
			await notify({
				sessionUpdate: "plan",
				entries: [{ content: "step", priority: "medium", status: "pending" }],
			});
			return { stopReason: "end_turn" };
		});
};

const collect = async (updates: AsyncIterable<AcpClient.Update>) => {
	const out: AcpClient.Update[] = [];
	for await (const u of updates) out.push(u);
	return out;
};

const allow: AcpClient.OnPermission = async () => ok("allow");

const openSession = async (
	agent: AgentApp,
	harness: "claude" | "codex" = "claude",
	onPermission: AcpClient.OnPermission = allow,
) => {
	const conn = await AcpClient.connect(harness, agent, { onPermission });
	if (!conn.ok) throw conn.error;
	const session = await AcpClient.newSession(conn.value, {
		cwd: "/tmp/scope",
		mcpServers: [
			{
				name: "cabane",
				command: "/usr/local/bin/cabane",
				args: ["mcp", "--as", "cabane://actor/agent/claude"],
				env: { CABANE_SESSION: "1" },
			},
		],
		systemPromptAppend: "Be brief.",
	});
	if (!session.ok) throw session.error;
	return { conn: conn.value, session: session.value };
};

describe("AcpClient", () => {
	it("streams a turn as cabane's own update union and stops", async () => {
		const seen: Seen = { newSession: [], prompts: [], cancels: 0 };
		const { conn, session } = await openSession(scriptedAgent(seen));
		const updates = await collect(
			AcpClient.prompt(session, [{ type: "text", text: "triage" }]),
		);
		expect(updates).toEqual([
			{ type: "text", text: "hello " },
			{ type: "thought", text: "hmm" },
			{
				type: "tool_call",
				id: "t1",
				title: "cabane_edit",
				kind: "edit",
				status: "pending",
			},
			{ type: "tool_call_update", id: "t1", status: "completed" },
			{ type: "plan", entries: [{ content: "step", status: "pending" }] },
			{ type: "stop", reason: "end_turn" },
		]);
		expect(seen.prompts).toEqual([[{ type: "text", text: "triage" }]]);
		expect(session.turn).toEqual({
			active: false,
			dispatched: false,
			cancelled: false,
		});
		AcpClient.close(conn);
	});

	it("puts the MCP server and, on claude only, the system prompt append on session/new", async () => {
		const claude: Seen = { newSession: [], prompts: [], cancels: 0 };
		const a = await openSession(scriptedAgent(claude), "claude");
		expect(claude.newSession[0]).toEqual({
			cwd: "/tmp/scope",
			mcpServers: [
				{
					name: "cabane",
					command: "/usr/local/bin/cabane",
					args: ["mcp", "--as", "cabane://actor/agent/claude"],
					env: [{ name: "CABANE_SESSION", value: "1" }],
				},
			],
			_meta: { systemPrompt: { append: "Be brief." } },
		});
		AcpClient.close(a.conn);

		const codex: Seen = { newSession: [], prompts: [], cancels: 0 };
		const b = await openSession(scriptedAgent(codex), "codex");
		expect(codex.newSession[0]).not.toHaveProperty("_meta");
		AcpClient.close(b.conn);
	});

	it("answers a permission request with the caller's option and never on its own", async () => {
		const asked: AcpClient.PermissionRequest[] = [];
		const seen: Seen = { newSession: [], prompts: [], cancels: 0 };
		const { conn, session } = await openSession(
			scriptedAgent(seen, { permission: true }),
			"claude",
			async (request) => {
				asked.push(request);
				return ok("reject");
			},
		);
		const updates = await collect(
			AcpClient.prompt(session, [{ type: "text", text: "go" }]),
		);
		expect(asked).toEqual([
			{
				toolCallId: "t1",
				title: "cabane_edit",
				options: [
					{ id: "allow", name: "Allow", kind: "allow_once" },
					{ id: "reject", name: "Reject", kind: "reject_once" },
				],
			},
		]);
		expect(updates).toContainEqual({ type: "text", text: "chose:reject" });
		AcpClient.close(conn);
	});

	it("a failed permission callback answers cancelled", async () => {
		const seen: Seen = { newSession: [], prompts: [], cancels: 0 };
		const { conn, session } = await openSession(
			scriptedAgent(seen, { permission: true }),
			"claude",
			async () => err(new Error("board closed")),
		);
		const updates = await collect(
			AcpClient.prompt(session, [{ type: "text", text: "go" }]),
		);
		expect(updates).toContainEqual({ type: "text", text: "chose:cancelled" });
		AcpClient.close(conn);
	});

	it("cancel before dispatch never sends session/cancel and the turn stops as cancelled", async () => {
		const seen: Seen = { newSession: [], prompts: [], cancels: 0 };
		const { conn, session } = await openSession(scriptedAgent(seen));
		const turn = AcpClient.prompt(session, [{ type: "text", text: "late" }]);
		expect((await AcpClient.cancel(session)).ok).toBe(true);
		expect(await collect(turn)).toEqual([
			{ type: "stop", reason: "cancelled" },
		]);
		expect(seen.cancels).toBe(0);
		expect(seen.prompts).toHaveLength(0);
		AcpClient.close(conn);
	});

	it("cancel during a dispatched turn sends session/cancel and the agent stops", async () => {
		const seen: Seen = { newSession: [], prompts: [], cancels: 0 };
		const { conn, session } = await openSession(
			scriptedAgent(seen, { hang: true }),
		);
		const iterator = AcpClient.prompt(session, [
			{ type: "text", text: "hang" },
		])[Symbol.asyncIterator]();
		expect(await iterator.next()).toEqual({
			done: false,
			value: { type: "text", text: "hello " },
		});
		expect((await AcpClient.cancel(session)).ok).toBe(true);
		const rest: AcpClient.Update[] = [];
		for (;;) {
			const next = await iterator.next();
			if (next.done) break;
			rest.push(next.value);
		}
		expect(seen.cancels).toBe(1);
		expect(rest.at(-1)).toEqual({ type: "stop", reason: "cancelled" });
		AcpClient.close(conn);
	});

	it("a handshake that never answers fails within the cap", async () => {
		const mute = agentApp({ name: "mute" }).onRequest(
			methods.agent.initialize,
			() => new Promise(() => {}),
		);
		const conn = await AcpClient.connect("claude", mute, {
			onPermission: allow,
			handshakeMs: 20,
		});
		expect(conn.ok).toBe(false);
		if (!conn.ok)
			expect(conn.error.message).toContain("no ACP initialize response");
	});

	it("a rejected prompt surfaces as an error update, not a throw", async () => {
		const failing = agentApp({ name: "failing" })
			.onRequest(methods.agent.initialize, () => ({
				protocolVersion: PROTOCOL_VERSION,
				agentCapabilities: { loadSession: false },
			}))
			.onRequest(methods.agent.session.new, () => ({ sessionId: "s-2" }))
			.onRequest(methods.agent.session.prompt, () => {
				throw new Error("agent exploded");
			});
		const { conn, session } = await openSession(failing);
		const updates = await collect(
			AcpClient.prompt(session, [{ type: "text", text: "x" }]),
		);
		// The SDK maps a thrown handler error to a JSON-RPC "Internal error"; the point here is
		// that it arrives as one error update and the iterator ends.
		expect(updates).toHaveLength(1);
		expect(updates[0]?.type).toBe("error");
		AcpClient.close(conn);
	});
});
