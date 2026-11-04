// A thin ACP client for one harness process: connect, open a session, stream a turn, cancel,
// close. Everything the board needs and nothing it does not: the SDK's types stop at this
// file, and every SDK call that can reject comes back as a Result.
import {
	type ActiveSession,
	type ActiveSessionMessage,
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
	type SessionConfigOption,
	type SessionModeState,
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
		| {
				type: "plan";
				entries: {
					content: string;
					status: "pending" | "in_progress" | "completed";
				}[];
		  }
		// Context occupancy, not a running token count: `used` is what is in the window now.
		// `cost` is cumulative for the session, and only some harnesses report it.
		| {
				type: "usage";
				used: number;
				size: number;
				cost?: { amount: number; currency: string };
		  }
		// The harness moved the session to another of its modes (`current_mode_update`).
		| { type: "mode"; id: string }
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
		// The harness advertised `_session/steering` (`_meta.steering.supported` on initialize),
		// so `steer` can put text into a turn while it runs.
		steering: boolean;
		// The harness advertised `sessionCapabilities.resume` on initialize, so `resumeSession`
		// can reopen one of its sessions by id.
		resume: boolean;
		// Updates for the sessions `resumeSession` reopened, by session id. Not dead weight: SDK
		// 2.x still attaches only `session/new` sessions (`attachSession` is private).
		resumed: Map<string, UpdateQueue>;
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
		active: Turns;
		mode: SessionMode;
		/** The modes the harness advertised on opening, before any switch. */
		modes: SessionModeState | null | undefined;
		/** The session's config options as the harness sent them on opening (its model among them). */
		configOptions: SessionConfigOption[];
	};

	/**
	 * What a session's turns run through: the SDK's `ActiveSession` for one `newSession` opened,
	 * or `resumedTurns` for one `resumeSession` reopened, since the SDK routes updates only to the
	 * sessions it opened with `session/new`.
	 */
	type Turns = Pick<ActiveSession, "nextUpdate"> & {
		prompt: (blocks: ContentBlock[]) => Promise<unknown>;
	};

	export type SessionMode = {
		/** The mode the session runs in, by the harness's id; absent when it advertises none. */
		current?: string;
		/** What was selected, or why nothing was, as one line for the session's log. */
		note: string;
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
		// The board copilot's profile when absent.
		profile?: Harnesses.Profile;
	};

	export type ResumeOptions = {
		cwd: string;
		mcpServers: StdioServer[];
		// The harness's own auto mode when absent.
		mode?: Harnesses.Mode;
	};

	export type NewSessionOptions = {
		cwd: string;
		mcpServers: StdioServer[];
		// Applied only where the harness reads it (Claude); callers send the portable copy
		// as the first prompt themselves.
		systemPromptAppend?: string;
		// The harness's own auto mode when absent.
		mode?: Harnesses.Mode;
	};

	const DEFAULT_HANDSHAKE_MS = 30_000;
	const STDERR_CAP = 16_384;

	export const spawn = async (
		harness: Harnesses.Id,
		cwd: string,
		options: SpawnOptions,
	): Promise<Result<Connection>> => {
		const launch = Harnesses.resolve(
			harness,
			options.overrides,
			options.profile,
		);
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
			// Exit alone does not mean the stderr reader has caught up; a failure report
			// read at exit can miss the harness's own words (seen on Linux as a bare EPIPE).
			closed: proc.exited.then(async (code) => {
				await stderr.drained;
				return code;
			}),
			stderr: stderr.text,
			close: () => void closeGracefully(proc),
			launch,
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

	type Process = Pick<Connection, "closed" | "stderr" | "close"> & {
		// What was launched, so a start that failed can say what cabane was trying to run.
		// Absent for an in-process transport, which never started anything.
		launch?: Harnesses.Launch;
	};

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
		const resumed = new Map<string, UpdateQueue>();
		const app = clientApp({ name: "kabane" })
			.onRequest(methods.client.session.requestPermission, async (c) =>
				answerPermission(options.onPermission, c.params),
			)
			.onNotification(methods.client.session.update, (c) => {
				resumed.get(c.params.sessionId)?.push({
					kind: "session_update",
					notification: c.params,
					update: c.params.update,
				});
			});
		// Identical branches: `connect` is overloaded per transport and needs the narrowing.
		const opened = await tryCatch(async () =>
			isAgentApp(transport) ? app.connect(transport) : app.connect(transport),
		);
		if (!opened.ok) return opened;
		const raw: ClientConnection = opened.value;
		const connection: Connection = {
			harness,
			agent: raw.agent,
			steering: false,
			resume: false,
			resumed,
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
			return err(await startFailure(handshake.error, connection, process));
		}
		connection.steering = advertisesSteering(handshake.value._meta);
		connection.resume = Boolean(
			handshake.value.agentCapabilities?.sessionCapabilities?.resume,
		);
		void raw.closed.then(() => {
			for (const queue of resumed.values())
				queue.close(new Error("ACP connection closed"));
		});
		return ok(connection);
	};

	const field = (value: unknown, key: string): unknown =>
		typeof value === "object" && value !== null
			? Object.entries(value).find(([k]) => k === key)?.[1]
			: undefined;

	// The steering extension's advert, a sibling of `agentCapabilities` on initialize. Both pinned
	// adapters send it (claude-agent-acp 0.76.0, codex-acp 1.11.0); Gemini's does not.
	const advertisesSteering = (meta: unknown): boolean =>
		field(field(meta, "steering"), "supported") === true;

	/**
	 * Where steered text went: into the running turn; into a turn the harness started for it,
	 * because the one it was aimed at had just ended; or nowhere, because the session was idle and
	 * the text is still the caller's to send as a prompt.
	 */
	export type Steered = "injected" | "new_turn" | "prompt_required";

	const STEERED: Readonly<Record<string, Steered>> = {
		injected: "injected",
		startedNewTurn: "new_turn",
		promptRequired: "prompt_required",
	};

	/**
	 * Put text into the session's running turn through the `_session/steering` extension method.
	 * An idle session is asked to hand the text back (`idleBehavior: promptRequired`) rather than
	 * start a turn that no `prompt` is reading; an adapter that ignores the hint (codex-acp) and
	 * starts one says so as `new_turn`. An error for a harness that does not advertise steering.
	 */
	export const steer = async (
		session: Session,
		blocks: PromptBlock[],
	): Promise<Result<Steered>> => {
		const { connection } = session;
		if (!connection.steering)
			return err(
				new Error(`${connection.harness} does not advertise ACP steering`),
			);
		const sent = await tryCatch(() =>
			connection.agent.request("_session/steering", {
				sessionId: session.id,
				prompt: blocks.map(toContentBlock),
				_meta: { steering: { idleBehavior: "promptRequired" } },
			}),
		);
		if (!sent.ok) return err(withStderr(sent.error, connection));
		const outcome = field(sent.value, "outcome");
		const steered = typeof outcome === "string" ? STEERED[outcome] : undefined;
		return steered
			? ok(steered)
			: err(
					new Error(
						`${connection.harness}: unexpected _session/steering response ${JSON.stringify(sent.value)}`,
					),
				);
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
		const active = started.value;
		return ok({
			connection,
			id: active.sessionId,
			active,
			turn: { active: false, dispatched: false, cancelled: false },
			mode: await selectMode(
				connection,
				active.sessionId,
				planMode(connection.harness, options.mode ?? "auto", active.modes),
			),
			modes: active.modes,
			configOptions: active.newSessionResponse.configOptions ?? [],
		});
	};

	/**
	 * Reopen session `id` through `session/resume`, which restores its conversation without
	 * replaying it. An error for a harness that does not advertise resume, or when it refuses
	 * (an id it no longer has).
	 */
	export const resumeSession = async (
		connection: Connection,
		id: string,
		options: ResumeOptions,
	): Promise<Result<Session>> => {
		if (!connection.resume)
			return err(
				new Error(`${connection.harness} does not advertise session/resume`),
			);
		// Listening before the request: the harness may send updates while it answers.
		const queue = updateQueue();
		connection.resumed.set(id, queue);
		const resumed = await tryCatch(() =>
			connection.agent.request(methods.agent.session.resume, {
				sessionId: id,
				cwd: options.cwd,
				mcpServers: options.mcpServers.map(toMcpServer),
			}),
		);
		if (!resumed.ok) {
			connection.resumed.delete(id);
			return err(withStderr(resumed.error, connection));
		}
		return ok({
			connection,
			id,
			active: resumedTurns(connection, id, queue),
			turn: { active: false, dispatched: false, cancelled: false },
			mode: await selectMode(
				connection,
				id,
				planMode(
					connection.harness,
					options.mode ?? "auto",
					resumed.value.modes,
				),
			),
			modes: resumed.value.modes,
			configOptions: resumed.value.configOptions ?? [],
		});
	};

	export type Reopened =
		| { session: Session; resumed: true }
		/** `why`: what kept session `id` from being resumed. */
		| { session: Session; resumed: false; why: string };

	/**
	 * Session `id` resumed where the harness can; else, or when it refuses the id, a new session
	 * that says why. An error only when no session opens at all.
	 */
	export const resumeOrStart = async (
		connection: Connection,
		id: string,
		options: ResumeOptions,
	): Promise<Result<Reopened>> => {
		const resumed = await resumeSession(connection, id, options);
		if (resumed.ok) return ok({ session: resumed.value, resumed: true });
		const started = await newSession(connection, options);
		return started.ok
			? ok({
					session: started.value,
					resumed: false,
					// The harness's refusal, not the stderr `withStderr` puts above it.
					why: resumed.error.message.split("\n").at(-1) ?? "",
				})
			: started;
	};

	/** A resumed session's updates in arrival order, each read once. */
	type UpdateQueue = {
		push: (message: ActiveSessionMessage) => void;
		/** The next read rejects with `error`; the ones after it read on. */
		reject: (error: Error) => void;
		/** Every read from now on rejects with `error`. */
		close: (error: Error) => void;
		next: () => Promise<ActiveSessionMessage>;
	};

	type Settle = {
		resolve: (message: ActiveSessionMessage) => void;
		reject: (error: Error) => void;
	};

	const updateQueue = (): UpdateQueue => {
		const items: (ActiveSessionMessage | Error)[] = [];
		const readers: Settle[] = [];
		let closed: Error | undefined;
		const deliver = (item: ActiveSessionMessage | Error): void => {
			const reader = readers.shift();
			if (!reader) {
				items.push(item);
				return;
			}
			if (item instanceof Error) reader.reject(item);
			else reader.resolve(item);
		};
		return {
			push: deliver,
			reject: deliver,
			close: (error) => {
				closed = error;
				for (const reader of readers.splice(0)) reader.reject(error);
			},
			next: () =>
				new Promise((resolve, reject) => {
					const item = items.shift();
					if (item instanceof Error) reject(item);
					else if (item) resolve(item);
					else if (closed) reject(closed);
					else readers.push({ resolve, reject });
				}),
		};
	};

	// What `ActiveSession.prompt` does, over the session's own queue: the turn's end is queued as
	// its `stop` message, behind every update the harness sent during it.
	const resumedTurns = (
		connection: Connection,
		sessionId: string,
		queue: UpdateQueue,
	): Turns => ({
		prompt: (blocks) => {
			const sent = connection.agent.request(methods.agent.session.prompt, {
				sessionId,
				prompt: blocks,
			});
			sent.then(
				(response) =>
					queue.push({
						kind: "stop",
						response,
						stopReason: response.stopReason,
					}),
				(error: unknown) => queue.reject(toError(error)),
			);
			return sent;
		},
		nextUpdate: queue.next,
	});

	type ModePlan = { switchTo: string; from: string } | SessionMode;

	/**
	 * What to do with the modes a session opened in. Only the harness's own auto mode is ever
	 * selected, and only from its manual mode: any other starting mode is one the user's harness
	 * settings chose, and kabane does not override it. A harness with no auto mode stays put.
	 */
	export const planMode = (
		harness: Harnesses.Id,
		wanted: Harnesses.Mode,
		state: SessionModeState | null | undefined,
	): ModePlan => {
		if (!state) return { note: `no session mode: ${harness} advertises none` };
		const current = state.currentModeId;
		if (wanted === "default")
			return { current, note: `mode ${current}: auto mode is off` };
		const ids = Harnesses.modes(harness);
		if (!ids)
			return {
				current,
				note: `mode ${current}: kabane knows no auto mode for ${harness}`,
			};
		if (current === ids.auto)
			return { current, note: `mode ${current}: ${harness}'s auto mode` };
		if (current !== ids.manual)
			return {
				current,
				note: `mode ${current}: from your ${harness} settings, kept over auto`,
			};
		if (!state.availableModes.some((mode) => mode.id === ids.auto))
			return {
				current,
				note: `mode ${current}: ${harness} does not advertise its auto mode (${ids.auto})`,
			};
		return { switchTo: ids.auto, from: current };
	};

	// A refused switch leaves the session where it opened rather than failing it: the harness
	// still asks for whatever it would, and every request still reaches the human.
	const selectMode = async (
		connection: Connection,
		sessionId: string,
		plan: ModePlan,
	): Promise<SessionMode> => {
		if (!("switchTo" in plan)) return plan;
		const set = await tryCatch(() =>
			connection.agent.request(methods.agent.session.setMode, {
				sessionId,
				modeId: plan.switchTo,
			}),
		);
		return set.ok
			? {
					current: plan.switchTo,
					note: `mode ${plan.switchTo}: ${connection.harness}'s auto mode, switched from ${plan.from}`,
				}
			: {
					current: plan.from,
					note: `mode ${plan.from}: switching to ${plan.switchTo} failed: ${toError(set.error).message}`,
				};
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
				if (update?.type === "mode") {
					// The switch `newSession` made is echoed back; only a move of the harness's own is news.
					if (update.id === session.mode.current) continue;
					session.mode = {
						current: update.id,
						note: `mode ${update.id}: moved there by ${session.connection.harness}`,
					};
				}
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
			case "current_mode_update":
				return { type: "mode", id: update.currentModeId };
			case "usage_update":
				return {
					type: "usage",
					used: update.used,
					size: update.size,
					...(update.cost
						? {
								cost: {
									amount: update.cost.amount,
									currency: update.cost.currency,
								},
							}
						: {}),
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
	// renderer with room for one line must never be handed that first. What the harness
	// itself printed leads, kept in its own order so it still reads as one block, and the
	// generic message trails as the least informative part.
	const assembleFailure = (
		base: Error,
		stderr: string,
		explanation: string[],
	): Error => {
		const tail = meaningfulStderr(stderr);
		if (explanation.length === 0 && tail.length === 0) return base;
		return new Error([...explanation, ...tail, base.message].join("\n"));
	};

	const withStderr = (error: unknown, connection: Connection): Error =>
		assembleFailure(toError(error), connection.stderr(), []);

	// How long a failed start waits to learn whether the process is gone. Its exit also means
	// stderr has reached EOF, so waiting here is what makes the harness's own words complete.
	const EXIT_VERDICT_MS = 500;

	// A start that failed with the process already dead, launched through `npx`, means npm
	// never put the adapter on disk: the harness was never reached, so nothing it might have
	// said is missing. Cabane pinned that version and chose to run it through npx, so it owns
	// the sentence. npm's own diagnostics stay underneath as the evidence.
	const startFailure = async (
		error: unknown,
		connection: Connection,
		process: Process,
	): Promise<Error> => {
		const base = toError(error);
		const exited = await withTimeout(
			connection.closed,
			EXIT_VERDICT_MS,
			"still running",
		);
		const stderr = connection.stderr();
		const explanation = exited.ok
			? installExplanation(connection.harness, process.launch, stderr)
			: [];
		return assembleFailure(base, stderr, explanation);
	};

	// npm says a version is missing "with a date before <date>" only when a `min-release-age`
	// or `before` setting is filtering the registry. Without that in the output the version is
	// simply not published, so the hint is only offered where it is true.
	const RELEASE_AGE_EVIDENCE = "with a date before";

	const installExplanation = (
		harness: Harnesses.Id,
		launch: Harnesses.Launch | undefined,
		stderr: string,
	): string[] => {
		if (launch?.command !== "npx") return [];
		const version = pinnedVersion(launch.args);
		const named = version === undefined ? "" : ` ${version}`;
		const headline = `${harness} adapter${named} could not be installed by npx`;
		return stderr.includes(RELEASE_AGE_EVIDENCE)
			? [
					headline,
					"your npm config hides recent publishes, so npx cannot see that version yet",
				]
			: [headline];
	};

	// `@scope/name@1.2.3` keeps its leading `@`, so only a later one separates the version.
	const pinnedVersion = (args: string[]): string | undefined => {
		const spec = args.find((arg) => !arg.startsWith("-"));
		const at = spec === undefined ? -1 : spec.lastIndexOf("@");
		return spec !== undefined && at > 0 ? spec.slice(at + 1) : undefined;
	};

	const collectStderr = (stream: ReadableStream<Uint8Array>) => {
		let text = "";
		const decoder = new TextDecoder();
		// A reader loop rather than `for await`: the CLI compiles with the DOM lib,
		// whose ReadableStream has no async iterator, and it imports this package.
		const drained = (async () => {
			const reader = stream.getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				text = (text + decoder.decode(value, { stream: true })).slice(
					-STDERR_CAP,
				);
			}
		})().catch(() => {});
		return { text: () => text, drained };
	};
}
