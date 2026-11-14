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
	CreateElicitationRequest,
	type CreateElicitationResponse,
	client as clientApp,
	ElicitationPropertySchema,
	type McpServer,
	MultiSelectItems,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	type RequestPermissionRequest,
	type SessionConfigOption,
	type SessionModeState,
	type SessionUpdate,
	type Stream,
	type ToolCallContent,
} from "@agentclientprotocol/sdk";
import type {
	CopilotElicitationAnswer,
	CopilotFormField,
	CopilotFormOption,
	CopilotFormValue,
} from "@cabane/board/ports";
import { err, ok, type Result, toError, tryCatch } from "@cabane/core";
import { Harnesses } from "./harnesses";
import { Stdio } from "./stdio";

export namespace AcpClient {
	export type Update =
		| { type: "text"; text: string }
		| { type: "thought"; text: string }
		// A tool call opening, then what changed about it. ACP sends only the fields that moved, and
		// one it does send replaces the old value whole (`content` included): `ToolCalls.apply`
		// folds them back into the call. `input` and `output` are the harness's raw arguments and
		// result, in whatever shape it chose.
		| ({ type: "tool_call"; id: string; title: string } & ToolFields)
		| ({ type: "tool_call_update"; id: string; title?: string } & ToolFields)
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
		// The harness moved the session to another of its modes: `current_mode_update`, or a
		// `config_option_update` whose mode option says so.
		| { type: "mode"; id: string }
		// A `notice`: something the harness wants the human to know that is not the agent's reply
		// (a mode it fell back from, a model it swapped). `text` is its title and detail as one line.
		| { type: "notice"; severity: NoticeSeverity; text: string }
		// The harness's own slash commands, the whole list every time it changes
		// (`available_commands_update`). `hint` is what a command's input expects, when it takes one.
		| { type: "commands"; commands: Command[] }
		| { type: "stop"; reason: string }
		| { type: "error"; message: string };

	// What a tool call shows of itself: the text it returned, or a file it changed (`oldText` absent
	// for a file it created). A terminal or an image has no text to show and is left out.
	export type ToolContent =
		| { type: "text"; text: string }
		| { type: "diff"; path: string; oldText?: string; newText: string };

	export type ToolFields = {
		kind?: string;
		status?: string;
		content?: ToolContent[];
		input?: unknown;
		output?: unknown;
	};

	export type Command = { name: string; description: string; hint?: string };

	// ACP leaves a notice's severity open-ended; anything but a warning or an error is information.
	export type NoticeSeverity = "info" | "warning" | "error";

	const noticeSeverity = (severity: string): NoticeSeverity =>
		severity === "warning" || severity === "error" ? severity : "info";

	export type PromptBlock = { type: "text"; text: string };

	export type PermissionRequest = {
		toolCallId: string;
		title: string;
		options: { id: string; name: string; kind: string }[];
	};

	// Resolves with the chosen option id. An error answers "cancelled": the client never
	// picks an option on the human's behalf. `withdrawn` aborts when the harness takes the
	// request back (`$/cancel_request`) or the connection closes; the request is then answered
	// "cancelled" whatever the handler does after.
	export type OnPermission = (
		request: PermissionRequest,
		withdrawn: AbortSignal,
	) => Promise<Result<string>>;

	// A form's parts are the board's: the board and the loop put the same form to a human, and read
	// its answers the same way (`@cabane/board/form-field`).
	export type ElicitationOption = CopilotFormOption;

	/**
	 * One field of a form, as the harness described it: `title` and `description` verbatim
	 * (`title` falls back to the field's key). `choice` picks one option, `choices` any number.
	 */
	export type ElicitationField = CopilotFormField;

	/** A form the harness asks the human to fill (ACP `elicitation/create`, form mode). */
	export type ElicitationRequest = {
		message: string;
		fields: ElicitationField[];
		toolCallId?: string;
	};

	export type ElicitationValue = CopilotFormValue;

	/**
	 * The human's answer. `content` holds only the fields they answered: an optional field left
	 * empty is absent, never filled in for them.
	 */
	export type ElicitationAnswer =
		| CopilotElicitationAnswer
		| { action: "cancel" };

	// An error answers "cancel", and so does a request the harness withdrew (`withdrawn`, as for
	// `OnPermission`): the client never accepts a form on the human's behalf.
	export type OnElicitation = (
		request: ElicitationRequest,
		withdrawn: AbortSignal,
	) => Promise<Result<ElicitationAnswer>>;

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
		/**
		 * The session's config options as the harness sent them on opening, or as it answered the
		 * model switch when one was asked for (`model`), before the mode is negotiated.
		 */
		configOptions: SessionConfigOption[];
		/** What selecting the model the session was opened with did; absent when none was asked for. */
		model?: ModelChoice;
		/** Whether the session runs as the named agent it was opened with; absent when none was asked for. */
		agent?: AgentChoice;
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
		/** What the mode was read and set through; absent when the harness advertises none. */
		via?: ModeControl["via"];
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
		// Passed only by a launcher with a human to put forms to: the client then advertises
		// form elicitation, without which claude-agent-acp turns AskUserQuestion off and codex-acp
		// its `request_user_input` forms. URL elicitation is never advertised.
		onElicitation?: OnElicitation;
		// Told why a form never reached `onElicitation` (a URL form, a required field kabane cannot
		// ask), as one line naming the form and the field, after the harness was answered `cancel`.
		onElicitationRefused?: (reason: string) => void;
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
		// A value the session's model option lists, selected before the mode is negotiated, since
		// the model decides which modes are on offer; the harness's own when absent.
		model?: string;
		// The harness's named agent the session's main thread runs as, where the harness can select
		// one (`Harnesses.agentMeta`); its own default agent when absent.
		agent?: string;
	};

	export type NewSessionOptions = {
		cwd: string;
		mcpServers: StdioServer[];
		// Applied only where the harness reads it (Claude); callers send the portable copy
		// as the first prompt themselves.
		systemPromptAppend?: string;
		// The harness's own auto mode when absent.
		mode?: Harnesses.Mode;
		// As in `ResumeOptions`.
		model?: string;
		agent?: string;
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
		const { onElicitation } = options;
		const base = clientApp({ name: "kabane" })
			.onRequest(methods.client.session.requestPermission, async (c) =>
				answerPermission(options.onPermission, c.params, c.signal),
			)
			.onNotification(methods.client.session.update, (c) => {
				resumed.get(c.params.sessionId)?.push({
					kind: "session_update",
					notification: c.params,
					update: c.params.update,
				});
			});
		const app = onElicitation
			? base.onRequest(methods.client.elicitation.create, async (c) =>
					answerElicitation(
						onElicitation,
						options.onElicitationRefused,
						c.params,
						c.signal,
					),
				)
			: base;
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
				clientCapabilities: onElicitation
					? { session: { notices: {} }, elicitation: { form: {} } }
					: { session: { notices: {} } },
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
	// adapters send it (claude-agent-acp 0.100.0, codex-acp 2.5.0); Gemini's does not.
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
	 * start a turn that no `prompt` is reading; both pinned adapters honour it, and one that
	 * ignores the hint and starts a turn says so as `new_turn`. An error for a harness that does
	 * not advertise steering.
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
		const meta = sessionMeta(
			connection.harness,
			options.systemPromptAppend !== undefined &&
				Harnesses.acceptsSystemPrompt(connection.harness)
				? { systemPrompt: { append: options.systemPromptAppend } }
				: {},
			options,
		);
		const started = await tryCatch(() =>
			connection.agent
				.buildSession({
					cwd: options.cwd,
					mcpServers: options.mcpServers.map(toMcpServer),
					...withMeta(meta),
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
			modes: active.modes,
			...(await configure(
				connection,
				active.sessionId,
				{
					configOptions: active.newSessionResponse.configOptions,
					modes: active.modes,
				},
				options,
			)),
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
				...withMeta(sessionMeta(connection.harness, {}, options)),
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
			modes: resumed.value.modes,
			...(await configure(connection, id, resumed.value, options)),
		});
	};

	// What `session/new` or `session/resume` carries in `_meta`: `base`, plus the named agent where
	// the harness takes one that way. Undefined when there is nothing to carry.
	const sessionMeta = (
		harness: Harnesses.Id,
		base: Record<string, unknown>,
		options: ResumeOptions,
	): Record<string, unknown> | undefined => {
		const agent =
			options.agent === undefined
				? undefined
				: Harnesses.agentMeta(harness, options.agent);
		const meta = { ...base, ...agent };
		return Object.keys(meta).length > 0 ? meta : undefined;
	};

	const withMeta = (
		meta: Record<string, unknown> | undefined,
	): { _meta?: Record<string, unknown> } => (meta ? { _meta: meta } : {});

	/**
	 * Set up a session that just opened: the model first, then the mode from the options the model
	 * switch answered with, because the model decides which modes the harness offers (Claude has no
	 * auto mode on some models).
	 */
	const configure = async (
		connection: Connection,
		sessionId: string,
		opened: {
			configOptions?: SessionConfigOption[] | null;
			modes?: SessionModeState | null;
		},
		options: ResumeOptions,
	): Promise<Pick<Session, "configOptions" | "mode" | "model">> => {
		const selected =
			options.model === undefined
				? undefined
				: await selectModel(
						connection,
						sessionId,
						opened.configOptions ?? [],
						options.model,
					);
		const configOptions = selected?.configOptions ?? opened.configOptions ?? [];
		const mode = await selectMode(
			connection,
			sessionId,
			planMode(
				connection.harness,
				options.mode ?? "auto",
				modeControl(configOptions, opened.modes),
			),
		);
		return {
			configOptions,
			mode,
			...(selected ? { model: selected.choice } : {}),
			...(options.agent === undefined
				? {}
				: {
						agent: agentChoice(
							connection.harness,
							configOptions,
							options.agent,
						),
					}),
		};
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

	/**
	 * How a session's mode is read and changed. The spec has config options supersede session
	 * modes, so a `category: "mode"` select option is used where the harness sends one
	 * (`session/set_config_option`); `session/set_mode` only for a harness with modes alone.
	 */
	export type ModeControl =
		| {
				via: "config_option";
				configId: string;
				current: string;
				available: string[];
		  }
		| { via: "set_mode"; current: string; available: string[] };

	type SelectOption = Extract<SessionConfigOption, { type: "select" }>;

	const selectOption = (
		options: SessionConfigOption[] | null | undefined,
		category: string,
	): SelectOption | undefined => {
		const option = options?.find(
			(o) => o.category === category && o.type === "select",
		);
		return option?.type === "select" ? option : undefined;
	};

	// A select's values, flattened out of any groups.
	const selectValues = (option: SelectOption): string[] =>
		option.options.flatMap((o) =>
			"options" in o ? o.options.map((v) => v.value) : [o.value],
		);

	const modeOption = (
		options: SessionConfigOption[] | null | undefined,
	): Extract<ModeControl, { via: "config_option" }> | undefined => {
		const option = selectOption(options, "mode");
		if (!option) return undefined;
		return {
			via: "config_option",
			configId: option.id,
			current: option.currentValue,
			available: selectValues(option),
		};
	};

	export const modeControl = (
		options: SessionConfigOption[] | null | undefined,
		modes: SessionModeState | null | undefined,
	): ModeControl | undefined =>
		modeOption(options) ??
		(modes
			? {
					via: "set_mode",
					current: modes.currentModeId,
					available: modes.availableModes.map((mode) => mode.id),
				}
			: undefined);

	type ModePlan = { switchTo: string; control: ModeControl } | SessionMode;

	/**
	 * What to do with the mode a session opened in, whichever way the harness exposes it. Only the
	 * harness's own auto mode is ever selected, and only from its manual mode: any other starting
	 * mode is one the user's settings or the harness itself chose, and kabane does not override
	 * it. The note does not say which of the two did: a harness that fell back from auto says so in
	 * a notice of its own, and the note must not contradict it. A harness with no auto mode stays put.
	 */
	export const planMode = (
		harness: Harnesses.Id,
		wanted: Harnesses.Mode,
		control: ModeControl | undefined,
	): ModePlan => {
		if (!control)
			return { note: `no session mode: ${harness} advertises none` };
		const { current, via } = control;
		if (wanted === "default")
			return { current, via, note: `mode ${current}: auto mode is off` };
		const ids = Harnesses.modes(harness);
		if (!ids)
			return {
				current,
				via,
				note: `mode ${current}: kabane knows no auto mode for ${harness}`,
			};
		if (current === ids.auto)
			return { current, via, note: `mode ${current}: ${harness}'s auto mode` };
		if (current !== ids.manual)
			return {
				current,
				via,
				note: `mode ${current}: ${harness} opened in it, not in its manual mode (${ids.manual}), so kabane keeps it over auto`,
			};
		if (!control.available.includes(ids.auto))
			return {
				current,
				via,
				note: `mode ${current}: ${harness} does not advertise its auto mode (${ids.auto})`,
			};
		return { switchTo: ids.auto, control };
	};

	// A refused switch leaves the session where it opened rather than failing it: the harness
	// still asks for whatever it would, and every request still reaches the human.
	const selectMode = async (
		connection: Connection,
		sessionId: string,
		plan: ModePlan,
	): Promise<SessionMode> => {
		if (!("switchTo" in plan)) return plan;
		const { switchTo, control } = plan;
		const { via, current: from } = control;
		const set = await tryCatch(async () => {
			if (control.via === "set_mode") {
				await connection.agent.request(methods.agent.session.setMode, {
					sessionId,
					modeId: switchTo,
				});
				return switchTo;
			}
			const response = await connection.agent.request(
				methods.agent.session.setConfigOption,
				{ sessionId, configId: control.configId, value: switchTo },
			);
			return modeOption(response.configOptions)?.current;
		});
		if (!set.ok)
			return {
				current: from,
				via,
				note: `mode ${from}: switching to ${switchTo} failed: ${toError(set.error).message}`,
			};
		// The harness answers a config option with where the session landed, which is not always
		// where it was asked to go (Claude falls back to acceptEdits for a model without auto, and
		// sends a notice saying why).
		const landed = set.value ?? switchTo;
		return {
			current: landed,
			via,
			note:
				landed === switchTo
					? `mode ${switchTo}: ${connection.harness}'s auto mode, switched from ${from}`
					: `mode ${landed}: asked for ${connection.harness}'s auto mode (${switchTo}) from ${from}, and it chose ${landed}`,
		};
	};

	/** Whether a session runs as the named agent it was opened with, and why not. */
	export type AgentChoice = {
		/** The agent the harness says the session runs as; absent when it says none. */
		current?: string;
		applied: boolean;
		/** As one line for the session's log. */
		note: string;
	};

	/**
	 * Whether the session runs as agent `name`, by the option the harness reports its agent on
	 * (`Harnesses.agentOption`). A harness with no way to select one runs without it, and so does
	 * one that has no such agent: Claude's adapter lists only the user's own agents, and falls back
	 * to its default for a name it does not know.
	 */
	const agentChoice = (
		harness: Harnesses.Id,
		options: SessionConfigOption[],
		name: string,
	): AgentChoice => {
		const id = Harnesses.agentOption(harness);
		if (id === undefined)
			return {
				applied: false,
				note: `${harness} has no way to select a named agent, so it runs without ${name}`,
			};
		const found = options.find((o) => o.id === id);
		const option = found?.type === "select" ? found : undefined;
		const current = option?.currentValue;
		if (current === name)
			return { current, applied: true, note: `agent ${name}` };
		const offered = option ? selectValues(option) : [];
		return {
			...(current === undefined ? {} : { current }),
			applied: false,
			note: `${harness} has no agent ${name}${offered.length > 0 ? ` (it offers ${offered.join(", ")})` : ""}, so it runs ${current ?? "its default agent"}`,
		};
	};

	/** What selecting a session's model left it on, and why. */
	export type ModelChoice = {
		/** The model the session runs, by the harness's value; absent when it is not known. */
		current?: string;
		/** Whether the session runs the model asked for. */
		applied: boolean;
		/** What was selected, or why nothing was, as one line for the session's log. */
		note: string;
	};

	/**
	 * Select `value` on the model option (`category: "model"`) through `session/set_config_option`,
	 * with the config options the harness answered. A harness with no model option, one that does
	 * not list `value`, or one that refuses the switch leaves the session on the model it opened
	 * with; one whose answer has no model option leaves it unconfirmed. The choice says which, and
	 * never fails the session.
	 */
	const selectModel = async (
		connection: Connection,
		sessionId: string,
		options: SessionConfigOption[],
		value: string,
	): Promise<{ choice: ModelChoice; configOptions: SessionConfigOption[] }> => {
		const { harness } = connection;
		const kept = (choice: ModelChoice) => ({ choice, configOptions: options });
		const option = selectOption(options, "model");
		if (!option)
			return kept({
				applied: false,
				note: `${harness} advertises no model option, so it runs its own default instead of ${value}`,
			});
		const from = option.currentValue;
		if (from === value)
			return kept({ current: from, applied: true, note: `model ${from}` });
		const available = selectValues(option);
		if (!available.includes(value))
			return kept({
				current: from,
				applied: false,
				note: `${harness} does not list ${value} (it lists ${available.join(", ")}), so it keeps ${from}`,
			});
		const set = await tryCatch(() =>
			connection.agent.request(methods.agent.session.setConfigOption, {
				sessionId,
				configId: option.id,
				value,
			}),
		);
		if (!set.ok)
			return kept({
				current: from,
				applied: false,
				note: `selecting ${value} failed, so ${harness} keeps ${from}: ${toError(set.error).message}`,
			});
		const { configOptions } = set.value;
		const landed = selectOption(configOptions, "model")?.currentValue;
		// No model in the answer is no evidence of one: what the session runs is unknown.
		if (landed === undefined)
			return {
				choice: {
					applied: false,
					note: `asked ${harness} for ${value}, and its answer names no model, so which one it runs is unconfirmed`,
				},
				configOptions,
			};
		return {
			choice:
				landed === value
					? {
							current: value,
							applied: true,
							note: `model ${value}, from ${from}`,
						}
					: {
							current: landed,
							applied: false,
							note: `asked ${harness} for ${value} and it chose ${landed}`,
						},
			configOptions,
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
					// The switch `newSession` made is echoed back, and every config option update repeats
					// the mode; only a move of the harness's own is news.
					if (update.id === session.mode.current) continue;
					session.mode = {
						...session.mode,
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

	const WITHDRAWN = new Error("withdrawn by the harness");

	// The handler's answer, or an error as soon as `signal` aborts: a withdrawn request is
	// answered at once, even by a handler that never looks at its signal.
	const unlessWithdrawn = <T>(
		answer: Promise<Result<T>>,
		signal: AbortSignal,
	): Promise<Result<T>> => {
		if (signal.aborted) return Promise.resolve(err(WITHDRAWN));
		let stop = () => {};
		const withdrawn = new Promise<Result<T>>((resolve) => {
			stop = () => resolve(err(WITHDRAWN));
			signal.addEventListener("abort", stop, { once: true });
		});
		const settled = tryCatch(() => answer).then((r) => (r.ok ? r.value : r));
		return Promise.race([settled, withdrawn]).finally(() =>
			signal.removeEventListener("abort", stop),
		);
	};

	const answerPermission = async (
		onPermission: OnPermission,
		params: RequestPermissionRequest,
		signal: AbortSignal,
	) => {
		const answer = await unlessWithdrawn(
			onPermission(
				{
					toolCallId: params.toolCall.toolCallId,
					title: params.toolCall.title ?? params.toolCall.toolCallId,
					options: params.options.map((o) => ({
						id: o.optionId,
						name: o.name,
						kind: o.kind,
					})),
				},
				signal,
			),
			signal,
		);
		return answer.ok && !signal.aborted
			? { outcome: { outcome: "selected" as const, optionId: answer.value } }
			: { outcome: { outcome: "cancelled" as const } };
	};

	const answerElicitation = async (
		onElicitation: OnElicitation,
		onRefused: ((reason: string) => void) | undefined,
		params: CreateElicitationRequest,
		signal: AbortSignal,
	): Promise<CreateElicitationResponse> => {
		const request = toElicitationRequest(params);
		if (!request.ok) {
			onRefused?.(
				`form "${params.message}" answered cancel, never shown: ${request.error.message}`,
			);
			return { action: "cancel" };
		}
		const answer = await unlessWithdrawn(
			onElicitation(request.value, signal),
			signal,
		);
		return answer.ok && !signal.aborted
			? toResponse(answer.value)
			: { action: "cancel" };
	};

	// ACP's content takes a mutable list for a multi-select.
	const toResponse = (answer: ElicitationAnswer): CreateElicitationResponse =>
		answer.action === "accept"
			? {
					action: "accept",
					content: Object.fromEntries(
						Object.entries(answer.content).map(([key, value]) => [
							key,
							typeof value === "object" ? [...value] : value,
						]),
					),
				}
			: answer;

	const text = (value: string | null | undefined): string | undefined =>
		value === null || value === undefined || value === "" ? undefined : value;

	// Absent and null mean the same in ACP: no bound.
	const bound = (value: number | null | undefined): number | undefined =>
		value ?? undefined;

	const optionsOf = (
		options: { const: string; title: string; description?: string | null }[],
	): ElicitationOption[] =>
		options.map((o) => {
			const description = text(o.description);
			return {
				value: o.const,
				label: o.title,
				...(description ? { description } : {}),
			};
		});

	const untitled = (values: string[]): ElicitationOption[] =>
		values.map((value) => ({ value, label: value }));

	type Shape = ElicitationField extends infer F
		? F extends ElicitationField
			? Omit<F, "key" | "title" | "description" | "required">
			: never
		: never;

	// What kabane can put to a human, or undefined for a property type it cannot.
	const shapeOf = (property: ElicitationPropertySchema): Shape | undefined => {
		if (ElicitationPropertySchema.isString(property)) {
			if (property.oneOf && property.oneOf.length > 0)
				return { type: "choice", options: optionsOf(property.oneOf) };
			if (property.enum && property.enum.length > 0)
				return { type: "choice", options: untitled(property.enum) };
			return {
				type: "text",
				minLength: bound(property.minLength),
				maxLength: bound(property.maxLength),
				pattern: text(property.pattern),
			};
		}
		const integer = ElicitationPropertySchema.isInteger(property);
		if (integer || ElicitationPropertySchema.isNumber(property))
			return {
				type: "number",
				integer,
				minimum: bound(property.minimum),
				maximum: bound(property.maximum),
			};
		if (ElicitationPropertySchema.isBoolean(property))
			return { type: "boolean" };
		if (ElicitationPropertySchema.isArray(property)) {
			const { items } = property;
			const options = MultiSelectItems.isTitled(items)
				? optionsOf(items.anyOf)
				: MultiSelectItems.isString(items)
					? untitled(items.enum)
					: [];
			if (options.length === 0) return undefined;
			return {
				type: "choices",
				options,
				minItems: bound(property.minItems),
				maxItems: bound(property.maxItems),
			};
		}
		return undefined;
	};

	// Every known property type carries an optional title and description; a custom one may not.
	const described = (property: ElicitationPropertySchema, key: string) => {
		const title = field(property, "title");
		const description = field(property, "description");
		return {
			title: typeof title === "string" && title !== "" ? title : key,
			...(typeof description === "string" && description !== ""
				? { description }
				: {}),
		};
	};

	/**
	 * A form request as kabane's own `ElicitationRequest`: every field, in the harness's order,
	 * with its title and description verbatim. An error for a URL or unknown mode, and for a form
	 * with a required field of a type kabane cannot put to a human; an optional one is left out,
	 * as a human who left it empty would.
	 */
	export const toElicitationRequest = (
		params: CreateElicitationRequest,
	): Result<ElicitationRequest> => {
		if (!CreateElicitationRequest.isForm(params))
			return err(new Error(`unsupported elicitation mode: ${params.mode}`));
		const schema = params.requestedSchema;
		const required = new Set(schema.required ?? []);
		const fields: ElicitationField[] = [];
		for (const [key, property] of Object.entries(schema.properties ?? {})) {
			const shape = shapeOf(property);
			if (!shape) {
				if (required.has(key))
					return err(
						new Error(
							`required field ${key} has a type kabane cannot ask: ${property.type}`,
						),
					);
				continue;
			}
			fields.push({
				key,
				...described(property, key),
				required: required.has(key),
				...shape,
			});
		}
		const toolCallId =
			"toolCallId" in params ? text(params.toolCallId) : undefined;
		return ok({
			message: params.message,
			fields,
			...(toolCallId ? { toolCallId } : {}),
		});
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

	// An empty `content` is kept: it is the harness clearing what the call showed, not saying nothing.
	const toolContent = (content: ToolCallContent[]): ToolContent[] =>
		content.flatMap((item): ToolContent[] => {
			if (item.type === "diff")
				return [
					{
						type: "diff",
						path: item.path,
						...(typeof item.oldText === "string"
							? { oldText: item.oldText }
							: {}),
						newText: item.newText,
					},
				];
			if (item.type === "content" && item.content.type === "text")
				return [{ type: "text", text: item.content.text }];
			return [];
		});

	const toolFields = (
		update: Extract<
			SessionUpdate,
			{ sessionUpdate: "tool_call" | "tool_call_update" }
		>,
	): ToolFields => ({
		...(update.kind ? { kind: update.kind } : {}),
		...(update.status ? { status: update.status } : {}),
		...(update.content ? { content: toolContent(update.content) } : {}),
		...(update.rawInput !== undefined ? { input: update.rawInput } : {}),
		...(update.rawOutput !== undefined ? { output: update.rawOutput } : {}),
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
					...toolFields(update),
				};
			case "tool_call_update":
				return {
					type: "tool_call_update",
					id: update.toolCallId,
					...(update.title ? { title: update.title } : {}),
					...toolFields(update),
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
			// Every option comes back on any change; `prompt` drops a mode that did not move.
			case "config_option_update": {
				const mode = modeOption(update.configOptions);
				return mode ? { type: "mode", id: mode.current } : null;
			}
			case "notice":
				return {
					type: "notice",
					severity: noticeSeverity(update.severity),
					text: update.description
						? `${update.title}: ${update.description}`
						: update.title,
				};
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
			case "available_commands_update":
				return {
					type: "commands",
					commands: update.availableCommands.map((command) => ({
						name: command.name,
						description: command.description,
						...(command.input?.hint ? { hint: command.input.hint } : {}),
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
