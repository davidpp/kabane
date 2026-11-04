// The client against the SDK's in-process agent builder: no subprocess, no npx, same wire.
import { describe, expect, it } from "bun:test";
import {
	type AgentApp,
	type AgentContext,
	agent as agentApp,
	type CreateElicitationRequest,
	type InitializeRequest,
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
				title: "kabane_edit",
				kind: "edit",
				status: "pending",
			});
			if (options.permission) {
				const answer = await c.client.request(
					methods.client.session.requestPermission,
					{
						sessionId: c.params.sessionId,
						toolCall: { toolCallId: "t1", title: "kabane_edit" },
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
				env: { KABANE_SESSION: "1" },
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
				title: "kabane_edit",
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
					env: [{ name: "KABANE_SESSION", value: "1" }],
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
				title: "kabane_edit",
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

	it("steers only a harness that advertises it, asking an idle one for the text back", async () => {
		const steered: unknown[] = [];
		const steerable = (advertise: boolean) =>
			agentApp({ name: "steerable" })
				.onRequest(methods.agent.initialize, () => ({
					protocolVersion: PROTOCOL_VERSION,
					agentCapabilities: { loadSession: false },
					...(advertise ? { _meta: { steering: { supported: true } } } : {}),
				}))
				.onRequest(methods.agent.session.new, () => ({ sessionId: "s-3" }))
				.onRequest(
					"_session/steering",
					{ parse: (params: unknown) => params },
					(c) => {
						steered.push(c.params);
						return { outcome: "promptRequired" };
					},
				);

		const yes = await openSession(steerable(true));
		expect(yes.conn.steering).toBe(true);
		const result = await AcpClient.steer(yes.session, [
			{ type: "text", text: "use the other API" },
		]);
		expect(result).toEqual(ok("prompt_required"));
		expect(steered).toEqual([
			{
				sessionId: "s-3",
				prompt: [{ type: "text", text: "use the other API" }],
				_meta: { steering: { idleBehavior: "promptRequired" } },
			},
		]);
		AcpClient.close(yes.conn);

		const no = await openSession(steerable(false));
		expect(no.conn.steering).toBe(false);
		const refused = await AcpClient.steer(no.session, [
			{ type: "text", text: "x" },
		]);
		expect(refused.ok).toBe(false);
		expect(steered).toHaveLength(1);
		AcpClient.close(no.conn);
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

	// A harness that dies before it ever speaks ACP is the common first-run failure: not
	// logged in, or an adapter npx cannot resolve. All the SDK says is "ACP connection
	// closed", so what the harness itself printed has to come first.
	it("leads a dead harness's failure with its own stderr, not the SDK's close message", async () => {
		const conn = await AcpClient.spawn("claude", "/tmp", {
			onPermission: allow,
			overrides: {
				command: "sh",
				args: [
					"-c",
					"echo 'npm error code ETARGET' >&2; echo 'npm error notarget No matching version found' >&2; echo 'npm error A complete log of this run can be found in: /tmp/x.log' >&2; exit 1",
				],
			},
		});
		expect(conn.ok).toBe(false);
		if (conn.ok) return;
		const lines = conn.error.message.split("\n");
		expect(lines[0]).toBe("npm error code ETARGET");
		expect(lines).toContain("npm error notarget No matching version found");
		// npm's log-path line is noise on every failure and never the answer.
		expect(conn.error.message).not.toContain("A complete log of this run");
	});

	it("keeps the SDK's message alone when the harness printed nothing", async () => {
		const conn = await AcpClient.spawn("claude", "/tmp", {
			onPermission: allow,
			overrides: { command: "sh", args: ["-c", "exit 1"] },
		});
		expect(conn.ok).toBe(false);
		if (conn.ok) return;
		expect(conn.error.message.split("\n")).toHaveLength(1);
	});

	// A dead process launched through npx means npm never put the adapter on disk, so the
	// reader is looking at npm's words about a command they never typed. Cabane pinned that
	// version and chose npx, so it says what it was doing before handing over the evidence.
	// `connect` takes the process bundle directly, which is how this runs without an npx.
	const deadNpx = (stderr: string) => ({
		closed: Promise.resolve(1),
		stderr: () => stderr,
		close: () => {},
		launch: {
			command: "npx",
			args: ["-y", "@agentclientprotocol/claude-agent-acp@0.99.1"],
			env: {},
		},
	});

	const mute = () =>
		agentApp({ name: "mute" }).onRequest(
			methods.agent.initialize,
			() => new Promise<never>(() => {}),
		);

	it("explains an adapter npx could not install, in cabane's own words, above npm's", async () => {
		const conn = await AcpClient.connect(
			"claude",
			mute(),
			{ onPermission: allow, handshakeMs: 20 },
			deadNpx(
				"npm error code ETARGET\nnpm error notarget No matching version found for @agentclientprotocol/claude-agent-acp@0.99.1 with a date before 2026-09-07",
			),
		);
		expect(conn.ok).toBe(false);
		if (conn.ok) return;
		const lines = conn.error.message.split("\n");
		expect(lines[0]).toBe(
			"claude adapter 0.99.1 could not be installed by npx",
		);
		// The date-before shape is npm reporting a release-age guard, so the hint is true here.
		expect(lines[1]).toContain("hides recent publishes");
		// npm's own diagnosis stays, contiguous, under cabane's sentence.
		expect(lines[2]).toBe("npm error code ETARGET");
		expect(lines[3]).toContain("No matching version found");
		// The SDK's uninformative close message trails everything.
		expect(lines[lines.length - 1]).toContain("no ACP initialize response");
	});

	it("does not blame a release-age guard when npm's output shows no date cutoff", async () => {
		const conn = await AcpClient.connect(
			"claude",
			mute(),
			{ onPermission: allow, handshakeMs: 20 },
			deadNpx("npm error 404 Not Found - GET https://registry.npmjs.org/nope"),
		);
		expect(conn.ok).toBe(false);
		if (conn.ok) return;
		const lines = conn.error.message.split("\n");
		expect(lines[0]).toBe(
			"claude adapter 0.99.1 could not be installed by npx",
		);
		expect(conn.error.message).not.toContain("hides recent publishes");
	});

	// Still running means the adapter did install and is simply not answering; saying it
	// could not be installed would be a lie.
	it("does not claim an install failure while the process is still running", async () => {
		const conn = await AcpClient.connect(
			"claude",
			mute(),
			{ onPermission: allow, handshakeMs: 20 },
			{
				...deadNpx("npm warn something harmless"),
				closed: new Promise<number>(() => {}),
			},
		);
		expect(conn.ok).toBe(false);
		if (conn.ok) return;
		expect(conn.error.message).not.toContain("could not be installed");
		expect(conn.error.message.split("\n")[0]).toBe(
			"npm warn something harmless",
		);
	});
});

describe("AcpClient.toUpdate", () => {
	it("maps a usage update to occupancy, with cost only when reported", () => {
		expect(
			AcpClient.toUpdate({
				sessionUpdate: "usage_update",
				used: 52_000,
				size: 200_000,
				cost: { amount: 0.42, currency: "USD" },
			}),
		).toEqual({
			type: "usage",
			used: 52_000,
			size: 200_000,
			cost: { amount: 0.42, currency: "USD" },
		});
		expect(
			AcpClient.toUpdate({
				sessionUpdate: "usage_update",
				used: 10,
				size: 100,
			}),
		).toEqual({ type: "usage", used: 10, size: 100 });
	});

	it("reads a config option update as the mode its mode option holds, and nothing without one", () => {
		expect(
			AcpClient.toUpdate({
				sessionUpdate: "config_option_update",
				configOptions: [modeConfig("plan")],
			}),
		).toEqual({ type: "mode", id: "plan" });
		expect(
			AcpClient.toUpdate({
				sessionUpdate: "config_option_update",
				configOptions: [MODEL_CONFIG],
			}),
		).toBeNull();
	});

	it("maps a notice to its severity and one line of title and detail", () => {
		expect(
			AcpClient.toUpdate({
				sessionUpdate: "notice",
				severity: "warning",
				title: "Auto mode unavailable",
				description: "The selected model does not support Auto mode.",
			}),
		).toEqual({
			type: "notice",
			severity: "warning",
			text: "Auto mode unavailable: The selected model does not support Auto mode.",
		});
		expect(
			AcpClient.toUpdate({
				sessionUpdate: "notice",
				severity: "info",
				title: "Context compacted",
			}),
		).toEqual({ type: "notice", severity: "info", text: "Context compacted" });
	});
});

// Claude's mode list as claude-agent-acp 0.99.1 advertises it on session/new.
const CLAUDE_MODES = [
	"default",
	"acceptEdits",
	"plan",
	"auto",
	"bypassPermissions",
];

// The `category: "mode"` config option claude-agent-acp 0.99.1 mirrors its modes into.
const modeConfig = (currentValue: string, ids = CLAUDE_MODES) => ({
	id: "mode",
	name: "Mode",
	category: "mode",
	type: "select" as const,
	currentValue,
	options: ids.map((value) => ({ value, name: value })),
});

const MODEL_CONFIG = {
	id: "model",
	name: "Model",
	category: "model",
	type: "select" as const,
	currentValue: "sonnet",
	options: [{ value: "sonnet", name: "Sonnet" }],
};

// An agent with session modes: opens in `current`, records every session/set_mode, and during a
// prompt echoes the mode it was switched to, then moves itself to `plan`.
const modedAgent = (
	current: string,
	seen: { setMode: string[] },
	options: { refuse?: boolean; ids?: string[] } = {},
): AgentApp => {
	let mode = current;
	return agentApp({ name: "moded" })
		.onRequest(methods.agent.initialize, () => ({
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: { loadSession: false },
		}))
		.onRequest(methods.agent.session.new, () => ({
			sessionId: "s-1",
			modes: {
				currentModeId: current,
				availableModes: (options.ids ?? CLAUDE_MODES).map((id) => ({
					id,
					name: id,
				})),
			},
		}))
		.onRequest(methods.agent.session.setMode, (c) => {
			seen.setMode.push(c.params.modeId);
			if (options.refuse) throw new Error("not allowed on this plan");
			mode = c.params.modeId;
			return {};
		})
		.onRequest(methods.agent.session.prompt, async (c) => {
			for (const currentModeId of [mode, "plan"])
				await c.client.notify(methods.client.session.update, {
					sessionId: c.params.sessionId,
					update: { sessionUpdate: "current_mode_update", currentModeId },
				});
			return { stopReason: "end_turn" };
		});
};

const openModed = async (
	agent: AgentApp,
	harness: "claude" | "codex" | "gemini",
	mode?: "auto" | "default",
) => {
	const conn = await AcpClient.connect(harness, agent, { onPermission: allow });
	if (!conn.ok) throw conn.error;
	const session = await AcpClient.newSession(conn.value, {
		cwd: "/tmp/scope",
		mcpServers: [],
		...(mode ? { mode } : {}),
	});
	if (!session.ok) throw session.error;
	return { conn: conn.value, session: session.value };
};

describe("AcpClient session modes", () => {
	it("switches a session that opened in the manual mode to the harness's auto mode by default", async () => {
		const seen = { setMode: [] as string[] };
		const { conn, session } = await openModed(
			modedAgent("default", seen),
			"claude",
		);
		expect(seen.setMode).toEqual(["auto"]);
		expect(session.mode).toEqual({
			current: "auto",
			via: "set_mode",
			note: "mode auto: claude's auto mode, switched from default",
		});
		// The echo of that switch is not news; the harness's own move to plan is.
		const updates = await collect(
			AcpClient.prompt(session, [{ type: "text", text: "go" }]),
		);
		expect(updates).toEqual([
			{ type: "mode", id: "plan" },
			{ type: "stop", reason: "end_turn" },
		]);
		expect(session.mode.current).toBe("plan");
		AcpClient.close(conn);
	});

	it("selects nothing when the mode is default", async () => {
		const seen = { setMode: [] as string[] };
		const { conn, session } = await openModed(
			modedAgent("default", seen),
			"claude",
			"default",
		);
		expect(seen.setMode).toEqual([]);
		expect(session.mode).toEqual({
			current: "default",
			via: "set_mode",
			note: "mode default: auto mode is off",
		});
		AcpClient.close(conn);
	});

	it("keeps a refused switch on the mode the session opened in, without failing it", async () => {
		const seen = { setMode: [] as string[] };
		const { conn, session } = await openModed(
			modedAgent("read-only", seen, {
				refuse: true,
				ids: ["read-only", "agent", "agent-full-access"],
			}),
			"codex",
		);
		expect(seen.setMode).toEqual(["agent"]);
		expect(session.mode.current).toBe("read-only");
		expect(session.mode.note).toStartWith(
			"mode read-only: switching to agent failed: ",
		);
		AcpClient.close(conn);
	});
});

// An agent that sends its modes as a config option too, as claude-agent-acp 0.99.1 does. It opens
// in `current`, records the capabilities it was offered and every session/set_config_option, and
// with `noAuto` behaves as Claude does for a model without auto: lands on acceptEdits and sends a
// notice saying why. During a prompt it repeats its options, then moves itself to `plan`.
const configAgent = (
	current: string,
	seen: { capabilities: unknown[]; setMode: string[]; setConfig: unknown[] },
	options: { noAuto?: boolean } = {},
): AgentApp => {
	let mode = current;
	const configOptions = () => [MODEL_CONFIG, modeConfig(mode)];
	return agentApp({ name: "configured" })
		.onRequest(methods.agent.initialize, (c) => {
			seen.capabilities.push(c.params.clientCapabilities);
			return {
				protocolVersion: PROTOCOL_VERSION,
				agentCapabilities: { loadSession: false },
			};
		})
		.onRequest(methods.agent.session.new, () => ({
			sessionId: "s-1",
			modes: {
				currentModeId: current,
				availableModes: CLAUDE_MODES.map((id) => ({ id, name: id })),
			},
			configOptions: configOptions(),
		}))
		.onRequest(methods.agent.session.setMode, (c) => {
			seen.setMode.push(c.params.modeId);
			return {};
		})
		.onRequest(methods.agent.session.setConfigOption, async (c) => {
			const { configId, value } = c.params;
			seen.setConfig.push({ configId, value });
			const notify = (update: Parameters<typeof AcpClient.toUpdate>[0]) =>
				c.client.notify(methods.client.session.update, {
					sessionId: c.params.sessionId,
					update,
				});
			mode = options.noAuto && value === "auto" ? "acceptEdits" : String(value);
			if (mode !== value)
				await notify({
					sessionUpdate: "notice",
					severity: "warning",
					title: "Auto mode unavailable",
					description: "The selected model does not support Auto mode.",
				});
			await notify({
				sessionUpdate: "current_mode_update",
				currentModeId: mode,
			});
			return { configOptions: configOptions() };
		})
		.onRequest(methods.agent.session.prompt, async (c) => {
			const notify = (update: Parameters<typeof AcpClient.toUpdate>[0]) =>
				c.client.notify(methods.client.session.update, {
					sessionId: c.params.sessionId,
					update,
				});
			await notify({
				sessionUpdate: "config_option_update",
				configOptions: configOptions(),
			});
			mode = "plan";
			await notify({
				sessionUpdate: "config_option_update",
				configOptions: configOptions(),
			});
			return { stopReason: "end_turn" };
		});
};

describe("AcpClient session modes through a config option", () => {
	const fresh = () => ({
		capabilities: [] as unknown[],
		setMode: [] as string[],
		setConfig: [] as unknown[],
	});

	it("advertises notices, switches through session/set_config_option and follows the option", async () => {
		const seen = fresh();
		const { conn, session } = await openModed(
			configAgent("default", seen),
			"claude",
		);
		expect(seen.capabilities).toMatchObject([{ session: { notices: {} } }]);
		expect(seen.setConfig).toEqual([{ configId: "mode", value: "auto" }]);
		expect(seen.setMode).toEqual([]);
		expect(session.mode).toEqual({
			current: "auto",
			via: "config_option",
			note: "mode auto: claude's auto mode, switched from default",
		});
		// Neither the switch's echo nor an update that repeats the mode is news; the move is.
		expect(
			await collect(AcpClient.prompt(session, [{ type: "text", text: "go" }])),
		).toEqual([
			{ type: "mode", id: "plan" },
			{ type: "stop", reason: "end_turn" },
		]);
		expect(session.mode).toEqual({
			current: "plan",
			via: "config_option",
			note: "mode plan: moved there by claude",
		});
		AcpClient.close(conn);
	});

	it("reports where the harness landed instead of auto, and passes its notice on", async () => {
		const { conn, session } = await openModed(
			configAgent("default", fresh(), { noAuto: true }),
			"claude",
		);
		expect(session.mode).toEqual({
			current: "acceptEdits",
			via: "config_option",
			note: "mode acceptEdits: asked for claude's auto mode (auto) from default, and it chose acceptEdits",
		});
		const updates = await collect(
			AcpClient.prompt(session, [{ type: "text", text: "go" }]),
		);
		expect(updates[0]).toEqual({
			type: "notice",
			severity: "warning",
			text: "Auto mode unavailable: The selected model does not support Auto mode.",
		});
		AcpClient.close(conn);
	});

	it("selects nothing when the mode is default", async () => {
		const seen = fresh();
		const { conn, session } = await openModed(
			configAgent("default", seen),
			"claude",
			"default",
		);
		expect(seen.setConfig).toEqual([]);
		expect(session.mode.via).toBe("config_option");
		AcpClient.close(conn);
	});
});

// An agent that keeps sessions by id across connections, as a harness keeps them on disk.
const resumableAgent = (
	seen: { resumed: unknown[]; prompts: unknown[] },
	options: { advertise?: boolean; known?: string } = {},
): AgentApp =>
	agentApp({ name: "resumable" })
		.onRequest(methods.agent.initialize, () => ({
			protocolVersion: PROTOCOL_VERSION,
			agentCapabilities: {
				loadSession: true,
				sessionCapabilities: options.advertise === false ? {} : { resume: {} },
			},
		}))
		.onRequest(methods.agent.session.resume, (c) => {
			seen.resumed.push(c.params);
			if (c.params.sessionId !== (options.known ?? "s-old"))
				throw new Error(`no session ${c.params.sessionId}`);
			return {
				modes: {
					currentModeId: "default",
					availableModes: CLAUDE_MODES.map((id) => ({ id, name: id })),
				},
			};
		})
		.onRequest(methods.agent.session.new, () => ({ sessionId: "s-new" }))
		.onRequest(methods.agent.session.setMode, () => ({}))
		.onRequest(methods.agent.session.prompt, async (c) => {
			seen.prompts.push(c.params);
			await c.client.notify(methods.client.session.update, {
				sessionId: c.params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "picking up" },
				},
			});
			return { stopReason: "end_turn" };
		});

describe("AcpClient.resumeSession", () => {
	const options = { cwd: "/tmp/scope", mcpServers: [] };

	it("reopens a session by id and streams its turns, in the harness's auto mode", async () => {
		const seen = { resumed: [] as unknown[], prompts: [] as unknown[] };
		const conn = await AcpClient.connect("claude", resumableAgent(seen), {
			onPermission: allow,
		});
		if (!conn.ok) throw conn.error;
		expect(conn.value.resume).toBe(true);
		const session = await AcpClient.resumeSession(conn.value, "s-old", options);
		if (!session.ok) throw session.error;
		expect(seen.resumed).toEqual([
			{ sessionId: "s-old", cwd: "/tmp/scope", mcpServers: [] },
		]);
		expect(session.value.id).toBe("s-old");
		expect(session.value.mode.current).toBe("auto");
		for (const turn of ["continue", "and again"])
			expect(
				await collect(
					AcpClient.prompt(session.value, [{ type: "text", text: turn }]),
				),
			).toEqual([
				{ type: "text", text: "picking up" },
				{ type: "stop", reason: "end_turn" },
			]);
		expect(seen.prompts).toEqual([
			{ sessionId: "s-old", prompt: [{ type: "text", text: "continue" }] },
			{ sessionId: "s-old", prompt: [{ type: "text", text: "and again" }] },
		]);
		AcpClient.close(conn.value);
	});

	it("is an error for a harness that does not advertise resume, without asking it", async () => {
		const seen = { resumed: [] as unknown[], prompts: [] as unknown[] };
		const conn = await AcpClient.connect(
			"claude",
			resumableAgent(seen, { advertise: false }),
			{ onPermission: allow },
		);
		if (!conn.ok) throw conn.error;
		expect(conn.value.resume).toBe(false);
		const session = await AcpClient.resumeSession(conn.value, "s-old", options);
		expect(session.ok).toBe(false);
		expect(seen.resumed).toEqual([]);
		AcpClient.close(conn.value);
	});

	it("is an error when the harness refuses the id", async () => {
		const seen = { resumed: [] as unknown[], prompts: [] as unknown[] };
		const conn = await AcpClient.connect("claude", resumableAgent(seen), {
			onPermission: allow,
		});
		if (!conn.ok) throw conn.error;
		const session = await AcpClient.resumeSession(
			conn.value,
			"s-gone",
			options,
		);
		expect(session.ok).toBe(false);
		AcpClient.close(conn.value);
	});
});

describe("AcpClient.resumeOrStart", () => {
	const options = { cwd: "/tmp/scope", mcpServers: [] };

	const reopen = async (
		agent: { advertise?: boolean; known?: string },
		id: string,
	) => {
		const seen = { resumed: [] as unknown[], prompts: [] as unknown[] };
		const conn = await AcpClient.connect(
			"claude",
			resumableAgent(seen, agent),
			{
				onPermission: allow,
			},
		);
		if (!conn.ok) throw conn.error;
		const reopened = await AcpClient.resumeOrStart(conn.value, id, options);
		AcpClient.close(conn.value);
		if (!reopened.ok) throw reopened.error;
		return reopened.value;
	};

	it("resumes the session when the harness can", async () => {
		const reopened = await reopen({}, "s-old");
		expect(reopened.resumed).toBe(true);
		expect(reopened.session.id).toBe("s-old");
	});

	it("starts a new session, saying why, when the harness does not advertise resume", async () => {
		const reopened = await reopen({ advertise: false }, "s-old");
		expect(reopened).toMatchObject({
			resumed: false,
			why: "claude does not advertise session/resume",
		});
		expect(reopened.session.id).toBe("s-new");
	});

	it("starts a new session, saying why, when the harness refuses the id", async () => {
		const reopened = await reopen({}, "s-gone");
		expect(reopened.resumed).toBe(false);
		expect(reopened.session.id).toBe("s-new");
		if (!reopened.resumed) expect(reopened.why).not.toBe("");
	});
});

describe("AcpClient.modeControl", () => {
	const modes = {
		currentModeId: "default",
		availableModes: CLAUDE_MODES.map((id) => ({ id, name: id })),
	};

	it("prefers the mode config option over the session modes", () => {
		expect(
			AcpClient.modeControl([MODEL_CONFIG, modeConfig("acceptEdits")], modes),
		).toEqual({
			via: "config_option",
			configId: "mode",
			current: "acceptEdits",
			available: CLAUDE_MODES,
		});
	});

	it("reads the values of a grouped mode option", () => {
		const grouped = {
			...modeConfig("read-only"),
			options: [
				{
					group: "sandboxed",
					name: "Sandboxed",
					options: [
						{ value: "read-only", name: "Read only" },
						{ value: "agent", name: "Auto review" },
					],
				},
			],
		};
		expect(AcpClient.modeControl([grouped], undefined)?.available).toEqual([
			"read-only",
			"agent",
		]);
	});

	it("falls back to the session modes without a mode option, and is absent with neither", () => {
		expect(AcpClient.modeControl([MODEL_CONFIG], modes)).toEqual({
			via: "set_mode",
			current: "default",
			available: CLAUDE_MODES,
		});
		expect(AcpClient.modeControl(undefined, undefined)).toBeUndefined();
	});
});

describe("AcpClient.planMode", () => {
	const control = (
		current: string,
		available = CLAUDE_MODES,
	): AcpClient.ModeControl => ({ via: "set_mode", current, available });

	it("leaves a mode the session did not open in its manual mode, without naming who chose it", () => {
		expect(
			AcpClient.planMode("claude", "auto", control("acceptEdits")),
		).toEqual({
			current: "acceptEdits",
			via: "set_mode",
			note: "mode acceptEdits: claude opened in it, not in its manual mode (default), so kabane keeps it over auto",
		});
	});

	it("does nothing for a session already in auto mode", () => {
		expect(
			AcpClient.planMode(
				"codex",
				"auto",
				control("agent", ["read-only", "agent", "agent-full-access"]),
			),
		).toEqual({
			current: "agent",
			via: "set_mode",
			note: "mode agent: codex's auto mode",
		});
	});

	it("plans the switch from the manual mode through whichever control the harness offers", () => {
		const option: AcpClient.ModeControl = {
			via: "config_option",
			configId: "mode",
			current: "default",
			available: CLAUDE_MODES,
		};
		expect(AcpClient.planMode("claude", "auto", option)).toEqual({
			switchTo: "auto",
			control: option,
		});
		expect(AcpClient.planMode("claude", "auto", control("default"))).toEqual({
			switchTo: "auto",
			control: control("default"),
		});
	});

	it("says so when the harness has no known auto mode, does not advertise it, or has no modes", () => {
		expect(
			AcpClient.planMode("gemini", "auto", control("default", ["default"])),
		).toEqual({
			current: "default",
			via: "set_mode",
			note: "mode default: kabane knows no auto mode for gemini",
		});
		expect(
			AcpClient.planMode("claude", "auto", control("default", ["default"])),
		).toEqual({
			current: "default",
			via: "set_mode",
			note: "mode default: claude does not advertise its auto mode (auto)",
		});
		expect(AcpClient.planMode("claude", "auto", undefined)).toEqual({
			note: "no session mode: claude advertises none",
		});
	});
});

// An agent whose one turn asks the client something through `ask` and says what came back.
const askingAgent = (
	initialized: InitializeRequest[],
	ask: (client: AgentContext, sessionId: string) => Promise<string>,
): AgentApp =>
	agentApp({ name: "asking" })
		.onRequest(methods.agent.initialize, (c) => {
			initialized.push(c.params);
			return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} };
		})
		.onRequest(methods.agent.session.new, () => ({ sessionId: "s-1" }))
		.onRequest(methods.agent.session.prompt, async (c) => {
			const said = await ask(c.client, c.params.sessionId);
			await c.client.notify(methods.client.session.update, {
				sessionId: c.params.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: said },
				},
			});
			return { stopReason: "end_turn" };
		});

// The two fields claude-agent-acp 0.99.1 sends for one AskUserQuestion question: the choice,
// then its optional "Other" box. Nothing is required.
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
					{
						const: "Redis",
						title: "Redis",
						description: "Shared, survives restarts",
					},
					{ const: "Memory", title: "Memory" },
				],
			},
			question_0_custom: {
				type: "string",
				title: "Other",
				description:
					"Type your own answer, or add a note to the option you chose above (optional).",
			},
		},
	},
});

const elicit =
	(request: (sessionId: string) => CreateElicitationRequest) =>
	async (client: AgentContext, sessionId: string): Promise<string> =>
		JSON.stringify(
			await client.request(
				methods.client.elicitation.create,
				request(sessionId),
			),
		);

const turnText = async (session: AcpClient.Session): Promise<string> =>
	(await collect(AcpClient.prompt(session, [{ type: "text", text: "go" }])))
		.flatMap((u) => (u.type === "text" ? [u.text] : []))
		.join("");

const openWith = async (agent: AgentApp, options: AcpClient.ConnectOptions) => {
	const conn = await AcpClient.connect("claude", agent, options);
	if (!conn.ok) throw conn.error;
	const session = await AcpClient.newSession(conn.value, {
		cwd: "/tmp/scope",
		mcpServers: [],
	});
	if (!session.ok) throw session.error;
	return { conn: conn.value, session: session.value };
};

describe("AcpClient elicitation", () => {
	it("advertises form elicitation only to a launcher that passes a handler, and never URL", async () => {
		const initialized: InitializeRequest[] = [];
		const ask = async () => "";
		const without = await openWith(askingAgent(initialized, ask), {
			onPermission: allow,
		});
		const withHandler = await openWith(askingAgent(initialized, ask), {
			onPermission: allow,
			onElicitation: async () => ok({ action: "decline" }),
		});
		// The agent side parses in ACP's defaults for the other keys; only this one is kabane's.
		expect(initialized.map((i) => i.clientCapabilities?.elicitation)).toEqual([
			undefined,
			{ form: {} },
		]);
		AcpClient.close(without.conn);
		AcpClient.close(withHandler.conn);
	});

	it("hands the handler the form verbatim and the harness the human's answer", async () => {
		const asked: AcpClient.ElicitationRequest[] = [];
		const { conn, session } = await openWith(
			askingAgent([], elicit(ASK_USER_QUESTION)),
			{
				onPermission: allow,
				onElicitation: async (request) => {
					asked.push(request);
					return ok({ action: "accept", content: { question_0: "Redis" } });
				},
			},
		);
		expect(await turnText(session)).toBe(
			JSON.stringify({ action: "accept", content: { question_0: "Redis" } }),
		);
		expect(asked).toEqual([
			{
				message: "Which store should the cache use?",
				toolCallId: "toolu_ask",
				fields: [
					{
						key: "question_0",
						title: "Store",
						required: false,
						type: "choice",
						options: [
							{
								value: "Redis",
								label: "Redis",
								description: "Shared, survives restarts",
							},
							{ value: "Memory", label: "Memory" },
						],
					},
					{
						key: "question_0_custom",
						title: "Other",
						description:
							"Type your own answer, or add a note to the option you chose above (optional).",
						required: false,
						type: "text",
					},
				],
			},
		]);
		AcpClient.close(conn);
	});

	it("a failed handler answers cancel, and a URL request is cancelled without asking", async () => {
		let calls = 0;
		const options: AcpClient.ConnectOptions = {
			onPermission: allow,
			onElicitation: async () => {
				calls += 1;
				return err(new Error("nobody to ask"));
			},
		};
		const failed = await openWith(
			askingAgent([], elicit(ASK_USER_QUESTION)),
			options,
		);
		expect(await turnText(failed.session)).toBe(
			JSON.stringify({ action: "cancel" }),
		);
		const url = await openWith(
			askingAgent(
				[],
				elicit((sessionId) => ({
					mode: "url",
					sessionId,
					elicitationId: "e-1",
					url: "https://example.com/oauth",
					message: "Sign in",
				})),
			),
			options,
		);
		expect(await turnText(url.session)).toBe(
			JSON.stringify({ action: "cancel" }),
		);
		expect(calls).toBe(1);
		AcpClient.close(failed.conn);
		AcpClient.close(url.conn);
	});
});

describe("AcpClient.toElicitationRequest", () => {
	const form = (
		properties: Record<string, unknown>,
		required: string[] = [],
	): CreateElicitationRequest =>
		({
			mode: "form",
			sessionId: "s-1",
			message: "Settings",
			requestedSchema: { type: "object", properties, required },
		}) as CreateElicitationRequest;

	it("maps every field type ACP defines, with its bounds and whether it is required", () => {
		const mapped = AcpClient.toElicitationRequest(
			form(
				{
					name: {
						type: "string",
						minLength: 1,
						maxLength: 20,
						pattern: "^[a-z]+$",
					},
					tier: { type: "string", enum: ["free", "pro"] },
					count: {
						type: "integer",
						minimum: 1,
						maximum: 9,
						description: "How many",
					},
					ratio: { type: "number" },
					confirm: { type: "boolean", title: "Confirm?" },
					tags: {
						type: "array",
						minItems: 1,
						items: {
							anyOf: [
								{ const: "a", title: "Alpha" },
								{ const: "b", title: "Beta" },
							],
						},
					},
					plain: { type: "array", items: { type: "string", enum: ["x", "y"] } },
				},
				["name", "count"],
			),
		);
		expect(mapped.ok && mapped.value.fields).toEqual([
			{
				key: "name",
				title: "name",
				required: true,
				type: "text",
				minLength: 1,
				maxLength: 20,
				pattern: "^[a-z]+$",
			},
			{
				key: "tier",
				title: "tier",
				required: false,
				type: "choice",
				options: [
					{ value: "free", label: "free" },
					{ value: "pro", label: "pro" },
				],
			},
			{
				key: "count",
				title: "count",
				description: "How many",
				required: true,
				type: "number",
				integer: true,
				minimum: 1,
				maximum: 9,
			},
			{
				key: "ratio",
				title: "ratio",
				required: false,
				type: "number",
				integer: false,
			},
			{ key: "confirm", title: "Confirm?", required: false, type: "boolean" },
			{
				key: "tags",
				title: "tags",
				required: false,
				type: "choices",
				minItems: 1,
				options: [
					{ value: "a", label: "Alpha" },
					{ value: "b", label: "Beta" },
				],
			},
			{
				key: "plain",
				title: "plain",
				required: false,
				type: "choices",
				options: [
					{ value: "x", label: "x" },
					{ value: "y", label: "y" },
				],
			},
		]);
	});

	it("leaves out an optional field of a type it cannot ask, and refuses a form that requires one", () => {
		const custom = { _vendor: { type: "_color" }, note: { type: "string" } };
		const optional = AcpClient.toElicitationRequest(form(custom));
		expect(optional.ok && optional.value.fields.map((f) => f.key)).toEqual([
			"note",
		]);
		const required = AcpClient.toElicitationRequest(form(custom, ["_vendor"]));
		expect(required.ok).toBe(false);
	});
});

describe("AcpClient withdrawn requests", () => {
	// The harness asks, then takes the request back (`$/cancel_request`) before anyone answers.
	const withdrawing =
		<P>(
			method:
				| typeof methods.client.session.requestPermission
				| typeof methods.client.elicitation.create,
			params: (sessionId: string) => P,
		) =>
		async (client: AgentContext, sessionId: string): Promise<string> => {
			const controller = new AbortController();
			const answer = client.request(method, params(sessionId) as never, {
				cancellationSignal: controller.signal,
			});
			await Bun.sleep(10);
			controller.abort();
			return JSON.stringify(await answer);
		};

	it("answers a withdrawn permission request cancelled and tells the handler it was withdrawn", async () => {
		let withdrawn: AbortSignal | undefined;
		const { conn, session } = await openWith(
			askingAgent(
				[],
				withdrawing(methods.client.session.requestPermission, (sessionId) => ({
					sessionId,
					toolCall: { toolCallId: "t1", title: "rm -rf build" },
					options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
				})),
			),
			{
				onPermission: (_request, signal) => {
					withdrawn = signal;
					// A handler that never answers: the client still lets the harness go.
					return new Promise(() => {});
				},
			},
		);
		expect(await turnText(session)).toBe(
			JSON.stringify({ outcome: { outcome: "cancelled" } }),
		);
		expect(withdrawn?.aborted).toBe(true);
		AcpClient.close(conn);
	});

	it("answers a withdrawn form cancel and tells the handler it was withdrawn", async () => {
		let withdrawn: AbortSignal | undefined;
		const { conn, session } = await openWith(
			askingAgent(
				[],
				withdrawing(methods.client.elicitation.create, ASK_USER_QUESTION),
			),
			{
				onPermission: allow,
				onElicitation: (_request, signal) => {
					withdrawn = signal;
					return new Promise(() => {});
				},
			},
		);
		expect(await turnText(session)).toBe(JSON.stringify({ action: "cancel" }));
		expect(withdrawn?.aborted).toBe(true);
		AcpClient.close(conn);
	});
});
