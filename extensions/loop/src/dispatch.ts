// One claim, driven over ACP: spawn the harness in the run's repository with `kabane mcp` as its
// tool server, open it with its assembled brief, and run turns until it is over. An implementing
// claim is over when its subtask is closed or yielded, active work exhausts its nudges,
// or the run cancels it; a lens is over when its review turn ends. Every update goes out through
// `hooks.event` tagged with the claim's lane and core session.
//
// The core session itself is opened and closed by the runner, which owns the claim; this module
// only writes into it (an ephemeral progress row per tool call, so a card can show what the agent
// is doing now).
import { AcpClient, CopilotInstructions, Harnesses } from "@cabane/acp";
import {
	err,
	ok,
	Planner,
	type Result,
	type Task,
	tryCatch,
} from "@cabane/core";
import { Brief } from "./brief";
import type { Budget } from "./budget";
import type { Gates } from "./gates";
import { LoopPlan } from "./plan";
import type { RunStore } from "./store";

export namespace Dispatch {
	type Env = {
		basePath: string;
		/** KABANE_HOME, handed to the MCP server so it opens the same tracker. */
		home: string;
		kabaneBin: string;
		cwd: string;
		scopeUri?: string;
		runId: string;
		overrides?: Harnesses.Overrides;
	};

	/**
	 * What the session is for: implementing its subtask (with the gate that failed after the
	 * subtask's last session, for its brief), or reviewing the parent through a lens.
	 */
	export type Work =
		| { kind: "implement"; retry?: Gates.Result }
		| { kind: "lens"; name: string; prompt: string };

	type Claim = {
		parent: Task;
		/** The subtask it implements, or the parent a lens reviews. */
		task: Task;
		harness: Harnesses.Id;
		sessionId: string;
		lane: string;
		work: Work;
	};

	export type Hooks = {
		event: (event: RunStore.EventDraft) => void;
		usage: (usage: Budget.Usage) => void;
		/** A turn ended with active-owned work. True spends one continuation and nudges. */
		continueTurn: () => boolean;
		/**
		 * The harness asks to run a tool. Resolves with the option id the human chose, or an
		 * error once `signal` aborts (the claim was cancelled or closed), which the ACP client
		 * sends as `cancelled`: never an answer of the loop's own.
		 */
		permission: (
			request: AcpClient.PermissionRequest,
			signal: AbortSignal,
		) => Promise<Result<string>>;
	};

	export type Outcome = {
		outcome: "done" | "incomplete" | "error" | "cancelled";
		detail?: string;
		/** The agent's last message, for the core session's summary. */
		summary?: string;
	};

	export type Handle = {
		done: Promise<Outcome>;
		/** Ask the harness to stop the current turn; the claim then ends as cancelled. */
		cancel: () => Promise<void>;
		/** Kill the harness process outright, for one that ignores `cancel`. */
		close: () => void;
		/**
		 * Say something to the session: into the turn it is running, through ACP steering when the
		 * harness supports it, else as its next prompt once the turn ends. Never fails; where the
		 * text went is an `inject_delivered` or `inject_queued` event, or a warning once the
		 * session has ended, even while the claim still holds it for its gates.
		 */
		inject: (text: string) => Promise<void>;
	};

	const label = (task: Task): string => task.shortId ?? task.id;

	const firstLine = (text: string): string => text.split("\n")[0] ?? "";

	const mcpServer = (
		env: Env,
		harness: Harnesses.Id,
	): AcpClient.StdioServer => ({
		name: "kabane",
		command: env.kabaneBin,
		args: [
			"mcp",
			...(env.scopeUri ? ["--scope", env.scopeUri] : []),
			"--as",
			CopilotInstructions.actorUri(harness),
		],
		env: { KABANE_HOME: env.home },
	});

	/**
	 * The loop's launch profile, not the copilot's: the user's own default model (a run that
	 * names one forwards it as an override), the installed CLI rather than the adapter's
	 * bundled copy, and a marker of its own so the user's hooks can tell a loop session from a
	 * board copilot. Its instructions ride the opening prompt, not a system prompt append.
	 * It sets no permission mode, allow list or settings file: the user's own harness settings
	 * decide what gets asked, and every request reaches the human (`permission.ts`).
	 */
	const loopProfile = (
		runId: string,
		cli: Record<string, string>,
	): Harnesses.Profile => ({
		pinModel: false,
		env: { KABANE_LOOP: "1", KABANE_LOOP_RUN: runId, ...cli },
	});

	const describeLaunch = (
		launch: Harnesses.Launch,
		cli: Record<string, string>,
	): string =>
		[
			[launch.command, ...launch.args].join(" "),
			...Object.entries(cli).map(([name, value]) => `${name}=${value}`),
			...Object.entries(launch.env)
				.filter(([name]) => name.endsWith("_MODEL"))
				.map(([name, value]) => `${name}=${value}`),
		].join(" · ");

	type Turn =
		| { kind: "stop"; reason: string }
		| { kind: "error"; message: string };

	// Prose arrives as deltas; a run of them is one message, emitted when something else happens.
	type Prose = Extract<AcpClient.Update, { type: "text" | "thought" }>;

	/** Where one turn's updates go. */
	type Sink = {
		emit: (
			type: string,
			summary: string,
			data?: RunStore.EventDraft["data"],
		) => void;
		progress: (body: string) => Promise<void>;
		usage: Hooks["usage"];
		/** The agent's latest complete message. */
		message: (text: string) => void;
	};

	// One non-prose update: the turn's end when it is one, else undefined after recording it.
	const forward = async (
		update: Exclude<AcpClient.Update, Prose>,
		titles: Map<string, string>,
		sink: Sink,
	): Promise<Turn | undefined> => {
		switch (update.type) {
			case "tool_call":
				titles.set(update.id, update.title);
				sink.emit("tool_call", update.title);
				await sink.progress(update.title);
				return undefined;
			case "tool_call_update":
				if (update.title) titles.set(update.id, update.title);
				if (update.status === "completed" || update.status === "failed")
					sink.emit(
						`tool_${update.status}`,
						titles.get(update.id) ?? update.id,
					);
				return undefined;
			case "plan":
				sink.emit(
					"plan",
					update.entries.map((e) => `[${e.status}] ${e.content}`).join("; "),
				);
				return undefined;
			case "usage":
				sink.usage({
					used: update.used,
					size: update.size,
					...(update.cost ? { cost: update.cost } : {}),
				});
				return undefined;
			case "stop":
				return { kind: "stop", reason: update.reason };
			case "error":
				return { kind: "error", message: update.message };
		}
	};

	const runTurn = async (
		session: AcpClient.Session,
		text: string,
		sink: Sink,
	): Promise<Turn> => {
		sink.emit("prompt", firstLine(text));
		const titles = new Map<string, string>();
		let prose: Prose | null = null;
		const flush = () => {
			if (!prose) return;
			sink.emit(prose.type, prose.text);
			if (prose.type === "text") sink.message(prose.text);
			prose = null;
		};
		for await (const update of AcpClient.prompt(session, [
			{ type: "text", text },
		])) {
			if (update.type === "text" || update.type === "thought") {
				if (prose && prose.type !== update.type) flush();
				prose = prose
					? { type: prose.type, text: prose.text + update.text }
					: update;
				continue;
			}
			flush();
			const end = await forward(update, titles, sink);
			if (end) return end;
		}
		flush();
		return {
			kind: "error",
			message: "the harness ended the turn without a stop reason",
		};
	};

	/** What a human says to a claim's session, and where it went. */
	type Injector = {
		inject: (session: AcpClient.Session | null, text: string) => Promise<void>;
		/** One turn, marked as running so `inject` can steer into it. */
		turn: (session: AcpClient.Session, text: string) => Promise<Turn>;
		/** Everything injected and not delivered yet, as the next prompt. */
		take: () => string | undefined;
		pending: () => number;
	};

	/**
	 * Into the running turn through ACP steering when the harness advertises it; otherwise, or
	 * when no turn is running, queued as the session's next prompt.
	 */
	const injector = (harness: Harnesses.Id, sink: Sink): Injector => {
		const queued: string[] = [];
		let running = false;

		const queue = (text: string, why: string): void => {
			queued.push(text);
			sink.emit("inject_queued", `${why}: ${firstLine(text)}`, { why });
		};

		return {
			inject: async (session, text) => {
				if (!session || !running)
					return queue(text, "no turn running, so it is the next prompt");
				if (!session.connection.steering)
					return queue(
						text,
						`${harness} does not support ACP steering, so it is the prompt after this turn`,
					);
				const steered = await AcpClient.steer(session, [
					{ type: "text", text },
				]);
				if (!steered.ok)
					return queue(
						text,
						`steering failed (${steered.error.message}), so it is the prompt after this turn`,
					);
				if (steered.value === "prompt_required")
					return queue(
						text,
						"the turn had just ended, so it is the next prompt",
					);
				const injected = steered.value === "injected";
				sink.emit(
					"inject_delivered",
					`${injected ? "into the running turn" : "as a turn the harness started for it"}: ${firstLine(text)}`,
					{ via: injected ? "steering" : "new_turn" },
				);
			},
			turn: async (session, text) => {
				running = true;
				try {
					return await runTurn(session, text, sink);
				} finally {
					running = false;
				}
			},
			take: () => {
				if (queued.length === 0) return undefined;
				const text = queued.splice(0).join("\n\n");
				sink.emit(
					"inject_delivered",
					`as the next prompt: ${firstLine(text)}`,
					{
						via: "prompt",
					},
				);
				return text;
			},
			pending: () => queued.length,
		};
	};

	/**
	 * Launch the claim's harness on the loop's profile and open its session. `connected` hears of
	 * the process as soon as it is up, so a session that fails to open still has it closed.
	 */
	const open = async (
		claim: Claim,
		env: Env,
		sink: Sink,
		on: {
			permission: AcpClient.OnPermission;
			connected: (connection: AcpClient.Connection) => void;
		},
	): Promise<Result<AcpClient.Session>> => {
		const cli = Harnesses.installedCli(claim.harness);
		if (!cli.ok) return cli;
		const profile = loopProfile(env.runId, cli.value);
		const launched = Harnesses.resolve(claim.harness, env.overrides, profile);
		sink.emit("launch", describeLaunch(launched, cli.value));
		const spawned = await AcpClient.spawn(claim.harness, env.cwd, {
			onPermission: on.permission,
			...(env.overrides ? { overrides: env.overrides } : {}),
			profile,
		});
		if (!spawned.ok) return spawned;
		on.connected(spawned.value);
		const started = await AcpClient.newSession(spawned.value, {
			cwd: env.cwd,
			mcpServers: [mcpServer(env, claim.harness)],
		});
		if (!started.ok) return started;
		// What the harness says it runs, which is the evidence the user's default was used.
		const model = started.value.active.newSessionResponse.configOptions?.find(
			(option) => option.category === "model" && option.type === "select",
		);
		if (model && model.type === "select")
			sink.emit("model", String(model.currentValue));
		return ok(started.value);
	};

	type Next =
		| { kind: "end"; outcome: Outcome["outcome"]; detail: string }
		| { kind: "prompt"; prompt: string };

	// A lens has one turn: its review. Its findings are in the tracker, not in what it said.
	const reviewed = (name: string, reason: string): Next =>
		reason === "end_turn"
			? {
					kind: "end",
					outcome: "done",
					detail: `the ${name} lens finished its review`,
				}
			: {
					kind: "end",
					outcome: "incomplete",
					detail: `the ${name} lens's turn ended (${reason})`,
				};

	// Only still-active, owned work can receive an automatic nudge. Tracker parking and
	// handoff end this claim without spending the run's continuation budget.
	const implemented = async (
		claim: Claim,
		env: Env,
		hooks: Hooks,
		sink: Sink,
		reason: string,
	): Promise<Next> => {
		const now = await Planner.getTask(env.basePath, claim.task.id);
		if (!now.ok)
			return { kind: "end", outcome: "error", detail: now.error.message };
		const task = now.value;
		if (!task)
			return {
				kind: "end",
				outcome: "incomplete",
				detail: `${label(claim.task)} was deleted`,
			};
		if (task.state === "done" || task.state === "cancelled")
			return {
				kind: "end",
				outcome: "done",
				detail: `${label(task)} is ${task.state}`,
			};
		if (!LoopPlan.isActive(task, claim.harness))
			return {
				kind: "end",
				outcome: "incomplete",
				detail: `${label(task)} yielded: ${task.kind}, ${task.state}, assignee ${task.assignee ?? "none"}`,
			};
		if (reason !== "end_turn" || !hooks.continueTurn())
			return {
				kind: "end",
				outcome: "incomplete",
				detail: `turn ended (${reason}) with ${label(task)} still ${task.state}`,
			};
		sink.emit("continuation", `${label(task)} still ${task.state}: nudged`);
		return { kind: "prompt", prompt: Brief.continuation(task) };
	};

	/** The claim's first prompt: its task's assembled brief, under the lens's or the run's words. */
	const opening = async (claim: Claim, env: Env): Promise<Result<string>> => {
		const assembled = await Planner.assembleContext(
			env.basePath,
			claim.task.id,
		);
		if (!assembled.ok)
			return err(new Error(`brief: ${assembled.error.message}`));
		const subject = {
			runId: env.runId,
			parent: claim.parent,
			task: claim.task,
		};
		const { work } = claim;
		return ok(
			work.kind === "lens"
				? Brief.lens(
						{ ...subject, lens: work.name, prompt: work.prompt },
						assembled.value,
					)
				: Brief.opening(
						{ ...subject, ...(work.retry ? { retry: work.retry } : {}) },
						assembled.value,
					),
		);
	};

	export const begin = (claim: Claim, env: Env, hooks: Hooks): Handle => {
		const tag = {
			lane: claim.lane,
			session: claim.sessionId,
			task: label(claim.task),
		};
		let connection: AcpClient.Connection | null = null;
		let session: AcpClient.Session | null = null;
		let cancelled = false;
		// Set once the session is over: nothing is sent after that, so nothing more is queued.
		let finished = false;
		let lastMessage: string | undefined;
		// Aborting it lets go of every permission request still waiting on a human. A claim that
		// is cancelled, closed or over has nobody left to answer for, and the harness would
		// otherwise sit on a request that never settles.
		const waiting = new AbortController();

		const sink: Sink = {
			emit: (type, summary, data) =>
				hooks.event({ ...tag, type, summary, ...(data ? { data } : {}) }),
			progress: async (body) => {
				const written = await Planner.addActivity(env.basePath, {
					sessionId: claim.sessionId,
					type: "progress",
					ephemeral: true,
					body,
				});
				if (!written.ok)
					sink.emit("warning", `session activity: ${written.error.message}`);
			},
			usage: hooks.usage,
			message: (text) => {
				lastMessage = text;
			},
		};

		const ended = (outcome: Outcome["outcome"], detail?: string): Outcome => ({
			outcome,
			...(detail ? { detail } : {}),
			...(lastMessage ? { summary: lastMessage } : {}),
		});

		const steering = injector(claim.harness, sink);

		const drive = async (): Promise<Outcome> => {
			const first = await opening(claim, env);
			if (!first.ok) return ended("error", first.error.message);
			const opened = await open(claim, env, sink, {
				permission: (request) => hooks.permission(request, waiting.signal),
				connected: (c) => {
					connection = c;
				},
			});
			if (!opened.ok) return ended("error", opened.error.message);
			session = opened.value;
			sink.emit(
				"session_start",
				claim.work.kind === "lens"
					? `${claim.harness} reviews ${label(claim.task)} through the ${claim.work.name} lens`
					: `${claim.harness} on ${label(claim.task)}`,
			);
			let text = first.value;
			for (;;) {
				if (cancelled) return ended("cancelled");
				const result = await steering.turn(opened.value, text);
				if (result.kind === "error") return ended("error", result.message);
				if (cancelled || result.reason === "cancelled")
					return ended("cancelled");
				// What the human said comes before anything the run would say next, and spends no
				// continuation: it is their turn, not a nudge.
				const injected = steering.take();
				if (injected !== undefined) {
					text = injected;
					continue;
				}
				const next =
					claim.work.kind === "lens"
						? reviewed(claim.work.name, result.reason)
						: await implemented(claim, env, hooks, sink, result.reason);
				if (next.kind === "end") return ended(next.outcome, next.detail);
				text = next.prompt;
			}
		};

		const done = tryCatch(drive)
			.then((result) =>
				result.ok ? result.value : ended("error", result.error.message),
			)
			.finally(() => {
				finished = true;
				waiting.abort();
				if (connection) AcpClient.close(connection);
				const lost = steering.pending();
				if (lost > 0)
					sink.emit(
						"warning",
						`${lost} injected prompt(s) not delivered: the session ended first`,
					);
			});

		return {
			done,
			// The waiting requests go first, as `cancelled`: the harness cannot finish a turn it
			// is blocked inside.
			cancel: async () => {
				cancelled = true;
				waiting.abort();
				if (session) await AcpClient.cancel(session);
			},
			close: () => {
				waiting.abort();
				if (connection) AcpClient.close(connection);
			},
			inject: async (text) => {
				if (finished)
					return sink.emit(
						"warning",
						`inject for ${claim.lane} dropped: its session has ended`,
					);
				return steering.inject(session, text);
			},
		};
	};
}
