// One claim, driven over ACP: spawn the harness in the run's repository with `kabane mcp` as its
// tool server, open the subtask with its assembled brief, and run turns until the subtask is
// closed, the turn ends with it open and no continuation is left, or the run cancels it. Every
// update goes out through `hooks.event` tagged with the claim's lane and core session.
//
// The core session itself is opened and closed by the runner, which owns the claim; this module
// only writes into it (an ephemeral progress row per tool call, so a card can show what the agent
// is doing now).
import { AcpClient, CopilotInstructions, Harnesses } from "@cabane/acp";
import { ok, Planner, type Result, type Task, tryCatch } from "@cabane/core";
import { Brief } from "./brief";
import type { Budget } from "./budget";
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

	type Claim = {
		parent: Task;
		task: Task;
		harness: Harnesses.Id;
		sessionId: string;
		lane: string;
	};

	export type Hooks = {
		event: (event: RunStore.EventDraft) => void;
		usage: (usage: Budget.Usage) => void;
		/** A turn ended with the subtask open. True spends one continuation and nudges. */
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
	};

	const label = (task: Task): string => task.shortId ?? task.id;

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
		emit: (type: string, summary: string) => void;
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
		sink.emit("prompt", text.split("\n")[0] ?? "");
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

	export const begin = (claim: Claim, env: Env, hooks: Hooks): Handle => {
		const tag = {
			lane: claim.lane,
			session: claim.sessionId,
			task: label(claim.task),
		};
		const subject = {
			runId: env.runId,
			parent: claim.parent,
			task: claim.task,
		};
		let connection: AcpClient.Connection | null = null;
		let session: AcpClient.Session | null = null;
		let cancelled = false;
		let lastMessage: string | undefined;
		// Aborting it lets go of every permission request still waiting on a human. A claim that
		// is cancelled, closed or over has nobody left to answer for, and the harness would
		// otherwise sit on a request that never settles.
		const waiting = new AbortController();

		const sink: Sink = {
			emit: (type, summary) => hooks.event({ ...tag, type, summary }),
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

		const open = async (): Promise<Result<AcpClient.Session>> => {
			const cli = Harnesses.installedCli(claim.harness);
			if (!cli.ok) return cli;
			const profile = loopProfile(env.runId, cli.value);
			const launched = Harnesses.resolve(claim.harness, env.overrides, profile);
			sink.emit("launch", describeLaunch(launched, cli.value));
			const spawned = await AcpClient.spawn(claim.harness, env.cwd, {
				onPermission: (request) => hooks.permission(request, waiting.signal),
				...(env.overrides ? { overrides: env.overrides } : {}),
				profile,
			});
			if (!spawned.ok) return spawned;
			connection = spawned.value;
			const started = await AcpClient.newSession(spawned.value, {
				cwd: env.cwd,
				mcpServers: [mcpServer(env, claim.harness)],
			});
			if (!started.ok) return started;
			session = started.value;
			// What the harness says it runs, which is the evidence the user's default was used.
			const model = started.value.active.newSessionResponse.configOptions?.find(
				(option) => option.category === "model" && option.type === "select",
			);
			if (model && model.type === "select")
				sink.emit("model", String(model.currentValue));
			return ok(started.value);
		};

		const ended = (outcome: Outcome["outcome"], detail?: string): Outcome => ({
			outcome,
			...(detail ? { detail } : {}),
			...(lastMessage ? { summary: lastMessage } : {}),
		});

		const drive = async (): Promise<Outcome> => {
			const assembled = await Planner.assembleContext(
				env.basePath,
				claim.task.id,
			);
			if (!assembled.ok)
				return ended("error", `brief: ${assembled.error.message}`);
			const opened = await open();
			if (!opened.ok) return ended("error", opened.error.message);
			sink.emit("session_start", `${claim.harness} on ${label(claim.task)}`);
			let text = Brief.opening(subject, assembled.value);
			for (;;) {
				if (cancelled) return ended("cancelled");
				const result = await runTurn(opened.value, text, sink);
				if (result.kind === "error") return ended("error", result.message);
				if (cancelled || result.reason === "cancelled")
					return ended("cancelled");
				const now = await Planner.getTask(env.basePath, claim.task.id);
				if (!now.ok) return ended("error", now.error.message);
				const task = now.value;
				if (!task)
					return ended("incomplete", `${label(claim.task)} was deleted`);
				if (task.state === "done" || task.state === "cancelled")
					return ended("done", `${label(task)} is ${task.state}`);
				if (result.reason !== "end_turn" || !hooks.continueTurn())
					return ended(
						"incomplete",
						`turn ended (${result.reason}) with ${label(task)} still ${task.state}`,
					);
				text = Brief.continuation(task);
				sink.emit("continuation", `${label(task)} still ${task.state}: nudged`);
			}
		};

		const done = tryCatch(drive)
			.then((result) =>
				result.ok ? result.value : ended("error", result.error.message),
			)
			.finally(() => {
				waiting.abort();
				if (connection) AcpClient.close(connection);
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
		};
	};
}
