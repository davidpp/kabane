// A thin ACP client for one harness process: connect, open a session, stream a turn, cancel,
// close. Everything the board needs and nothing it does not: the SDK's types stop at this
// file, and every SDK call that can reject comes back as a Result.
import {
	type ActiveSession,
	type AgentApp,
	type ClientConnection,
	type ClientContext,
	type ContentBlock,
	client as clientApp,
	type McpServer,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	type RequestPermissionRequest,
	type SessionUpdate,
	type Stream,
} from "@agentclientprotocol/sdk";
import { err, ok, type Result, toError, tryCatch } from "@cabane/core";
import { Harnesses } from "./harnesses";
import { Stdio } from "./stdio";

export namespace AcpClient {
	export type Update =
		| { type: "text"; text: string }
		| { type: "thought"; text: string }
		| {
				type: "tool_call";
				id: string;
				title: string;
				kind?: string;
				status?: string;
		  }
		| {
				type: "tool_call_update";
				id: string;
				title?: string;
				status?: string;
		  }
		| { type: "plan"; entries: { content: string; status: string }[] }
		| { type: "stop"; reason: string }
		| { type: "error"; message: string };

	export type PromptBlock = { type: "text"; text: string };

	export type PermissionRequest = {
		toolCallId: string;
		title: string;
		options: { id: string; name: string; kind: string }[];
	};

	// Resolves with the chosen option id. An error answers "cancelled": the client never
	// picks an option on the human's behalf.
	export type OnPermission = (
		request: PermissionRequest,
	) => Promise<Result<string>>;

	export type StdioServer = {
		name: string;
		command: string;
		args: string[];
		env: Record<string, string>;
	};

	export type Connection = {
		harness: Harnesses.Id;
		agent: ClientContext;
		// Resolves once the transport is gone; for a spawned harness, with its exit code.
		closed: Promise<number | null>;
		// What the harness wrote to stderr so far, for error reporting only.
		stderr: () => string;
		close: () => void;
	};

	export type Session = {
		connection: Connection;
		id: string;
		turn: TurnState;
		active: ActiveSession;
	};

	// `dispatched` is whether the agent has seen the current turn: cancelling before that
	// must not send `session/cancel` for a prompt the agent never received.
	export type TurnState = {
		active: boolean;
		dispatched: boolean;
		cancelled: boolean;
	};

	export type ConnectOptions = {
		onPermission: OnPermission;
		handshakeMs?: number;
	};

	export type SpawnOptions = ConnectOptions & {
		overrides?: Harnesses.Overrides;
	};

	export type NewSessionOptions = {
		cwd: string;
		mcpServers: StdioServer[];
		// Applied only where the harness reads it (Claude); callers send the portable copy
		// as the first prompt themselves.
		systemPromptAppend?: string;
	};

	const DEFAULT_HANDSHAKE_MS = 30_000;
	const STDERR_CAP = 16_384;

	export const spawn = async (
		harness: Harnesses.Id,
		cwd: string,
		options: SpawnOptions,
	): Promise<Result<Connection>> => {
		const launch = Harnesses.resolve(harness, options.overrides);
		const spawned = await tryCatch(async () =>
			Bun.spawn([launch.command, ...launch.args], {
				cwd,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, ...launch.env },
			}),
		);
		if (!spawned.ok) return spawned;
		const proc = spawned.value;
		const stderr = collectStderr(proc.stderr);
		const stream = ndJsonStream(
			Stdio.stdinSink(proc.stdin),
			proc.stdout.pipeThrough(Stdio.jsonLines()),
		);
		const connected = await connect(harness, stream, options, {
			closed: proc.exited,
			stderr: stderr.text,
			close: () => void closeGracefully(proc),
		});
		if (!connected.ok) proc.kill();
		return connected;
	};

	const EXIT_GRACE_MS = 2_000;

	// An npx wrapper killed outright orphans the adapter's own child (the real `claude`
	// process kept running after SIGTERM to the wrapper). Stdin EOF lets the adapter shut
	// its child down; the kill is only for one that ignores it.
	const closeGracefully = async (
		proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
	) => {
		await tryCatch(async () => {
			await proc.stdin.end();
		});
		const exited = await withTimeout(
			proc.exited,
			EXIT_GRACE_MS,
			"still running",
		);
		if (!exited.ok) proc.kill();
	};

	type Process = Pick<Connection, "closed" | "stderr" | "close">;

	const NO_PROCESS: Process = {
		closed: Promise.resolve(null),
		stderr: () => "",
		close: () => {},
	};

	// The transport can be a real ndjson stream or an in-process AgentApp (tests).
	export const connect = async (
		harness: Harnesses.Id,
		transport: Stream | AgentApp,
		options: ConnectOptions,
		process: Process = NO_PROCESS,
	): Promise<Result<Connection>> => {
		const app = clientApp({ name: "cabane" }).onRequest(
			methods.client.session.requestPermission,
			async (c) => answerPermission(options.onPermission, c.params),
		);
		// Identical branches: `connect` is overloaded per transport and needs the narrowing.
		const opened = await tryCatch(async () =>
			isAgentApp(transport) ? app.connect(transport) : app.connect(transport),
		);
		if (!opened.ok) return opened;
		const raw: ClientConnection = opened.value;
		const connection: Connection = {
			harness,
			agent: raw.agent,
			closed: process.closed,
			stderr: process.stderr,
			close: () => {
				raw.close();
				process.close();
			},
		};
		const handshake = await withTimeout(
			raw.agent.request(methods.agent.initialize, {
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {},
			}),
			options.handshakeMs ?? DEFAULT_HANDSHAKE_MS,
			`${harness}: no ACP initialize response`,
		);
		if (!handshake.ok) {
			connection.close();
			return err(withStderr(handshake.error, connection));
		}
		return ok(connection);
	};

	export const newSession = async (
		connection: Connection,
		options: NewSessionOptions,
	): Promise<Result<Session>> => {
		const meta =
			options.systemPromptAppend !== undefined &&
			Harnesses.acceptsSystemPrompt(connection.harness)
				? { systemPrompt: { append: options.systemPromptAppend } }
				: undefined;
		const started = await tryCatch(() =>
			connection.agent
				.buildSession({
					cwd: options.cwd,
					mcpServers: options.mcpServers.map(toMcpServer),
					...(meta ? { _meta: meta } : {}),
				})
				.start(),
		);
		if (!started.ok) return err(withStderr(started.error, connection));
		return ok({
			connection,
			id: started.value.sessionId,
			active: started.value,
			turn: { active: false, dispatched: false, cancelled: false },
		});
	};

	// Lazy: nothing is sent until the caller starts iterating, which is what makes
	// cancel-before-dispatch observable.
	export async function* prompt(
		session: Session,
		blocks: PromptBlock[],
	): AsyncIterable<Update> {
		const { turn } = session;
		if (turn.cancelled) {
			turn.cancelled = false;
			yield { type: "stop", reason: "cancelled" };
			return;
		}
		turn.active = true;
		turn.dispatched = true;
		// Rejections surface through nextUpdate(); this keeps the promise from being unhandled.
		void session.active.prompt(blocks.map(toContentBlock)).catch(() => {});
		try {
			for (;;) {
				const next = await tryCatch(() => session.active.nextUpdate());
				if (!next.ok) {
					yield {
						type: "error",
						message: withStderr(next.error, session.connection).message,
					};
					return;
				}
				if (next.value.kind === "stop") {
					yield { type: "stop", reason: next.value.stopReason };
					return;
				}
				const update = toUpdate(next.value.update);
				if (update) yield update;
			}
		} finally {
			turn.active = false;
			turn.dispatched = false;
			turn.cancelled = false;
		}
	}

	export const cancel = async (session: Session): Promise<Result<void>> => {
		const { turn } = session;
		if (!turn.active || !turn.dispatched) {
			turn.cancelled = true;
			return ok(undefined);
		}
		return tryCatch(() =>
			session.connection.agent.notify(methods.agent.session.cancel, {
				sessionId: session.id,
			}),
		);
	};

	export const close = (connection: Connection): void => connection.close();

	const isAgentApp = (transport: Stream | AgentApp): transport is AgentApp =>
		!("readable" in transport);

	const answerPermission = async (
		onPermission: OnPermission,
		params: RequestPermissionRequest,
	) => {
		const answer = await onPermission({
			toolCallId: params.toolCall.toolCallId,
			title: params.toolCall.title ?? params.toolCall.toolCallId,
			options: params.options.map((o) => ({
				id: o.optionId,
				name: o.name,
				kind: o.kind,
			})),
		});
		return answer.ok
			? { outcome: { outcome: "selected" as const, optionId: answer.value } }
			: { outcome: { outcome: "cancelled" as const } };
	};

	const toMcpServer = (server: StdioServer): McpServer => ({
		name: server.name,
		command: server.command,
		args: server.args,
		env: Object.entries(server.env).map(([name, value]) => ({ name, value })),
	});

	const toContentBlock = (block: PromptBlock): ContentBlock => ({
		type: "text",
		text: block.text,
	});

	export const toUpdate = (update: SessionUpdate): Update | null => {
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				return update.content.type === "text"
					? { type: "text", text: update.content.text }
					: null;
			case "agent_thought_chunk":
				return update.content.type === "text"
					? { type: "thought", text: update.content.text }
					: null;
			case "tool_call":
				return {
					type: "tool_call",
					id: update.toolCallId,
					title: update.title,
					...(update.kind ? { kind: update.kind } : {}),
					...(update.status ? { status: update.status } : {}),
				};
			case "tool_call_update":
				return {
					type: "tool_call_update",
					id: update.toolCallId,
					...(update.title ? { title: update.title } : {}),
					...(update.status ? { status: update.status } : {}),
				};
			case "plan":
				return {
					type: "plan",
					entries: update.entries.map((e) => ({
						content: e.content,
						status: e.status,
					})),
				};
			default:
				return null;
		}
	};

	const withTimeout = async <T>(
		promise: Promise<T>,
		ms: number,
		message: string,
	): Promise<Result<T>> => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<Result<T>>((resolve) => {
			timer = setTimeout(() => resolve(err(new Error(message))), ms);
		});
		const result = await Promise.race([tryCatch(() => promise), timeout]);
		clearTimeout(timer);
		return result;
	};

	// npm prints this after every failure and it is never the diagnosis.
	const NPM_LOG_NOTE = "A complete log of this run can be found in:";

	const meaningfulStderr = (tail: string): string[] =>
		tail
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line !== "" && !line.includes(NPM_LOG_NOTE));

	// The SDK reports every transport failure as the same "ACP connection closed", so a
	// renderer with room for one line must never be handed that first. The harness's own
	// opening words lead instead, with the generic message and the rest of the stderr
	// behind them for whoever reads the whole thing.
	const withStderr = (error: unknown, connection: Connection): Error => {
		const base = toError(error);
		const [headline, ...rest] = meaningfulStderr(connection.stderr());
		if (headline === undefined) return base;
		return new Error([headline, base.message, ...rest].join("\n"));
	};

	const collectStderr = (stream: ReadableStream<Uint8Array>) => {
		let text = "";
		const decoder = new TextDecoder();
		// A reader loop rather than `for await`: the CLI compiles with the DOM lib,
		// whose ReadableStream has no async iterator, and it imports this package.
		void (async () => {
			const reader = stream.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				text = (text + decoder.decode(value, { stream: true })).slice(
					-STDERR_CAP,
				);
			}
		})().catch(() => {});
		return { text: () => text };
	};
}
