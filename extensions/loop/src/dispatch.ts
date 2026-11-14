// One claim, driven over ACP: spawn the harness in the run's repository with `kabane mcp` as its
// tool server, open it with its assembled brief, and run turns until it is over. An implementing
// claim is over when its subtask is closed or yielded, active work exhausts its nudges,
// or the run cancels it; a lens, and a lens's recheck, is over when its review turn ends; the fixer
// is over when none of its findings is still waiting on it, or its nudges run out. Every update goes out through
// `hooks.event` tagged with the claim's lane and core session.
//
// The core session itself is opened and closed by the runner, which owns the claim; this module
// only writes into it (an ephemeral progress row per tool call, so a card can show what the agent
// is doing now). The one tracker write of its own: an implementing session that closed an issue
// whose checklist still has items open has it reopened, and is nudged to go on from the first.
import {
	AcpClient,
	CopilotInstructions,
	Harnesses,
	ToolCalls,
} from "@cabane/acp";
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
import { Checklists } from "./checklists";
import type { LoopConfig } from "./config";
import type { Gates } from "./gates";
import { LoopPlan } from "./plan";
import type { Retry } from "./retry";
import { Route } from "./route";
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
		/** The mode the session starts in; the harness's own auto mode when absent. */
		mode?: Harnesses.Mode;
		/**
		 * The run's model and tiers, resolved for the claim's harness and tier (`Route.model`); absent,
		 * the harness's default.
		 */
		models?: Pick<LoopConfig.Config, "model" | "tiers">;
	};

	/**
	 * What the session is for: implementing its subtask (with the gate that failed after the
	 * subtask's last session, for its brief), reviewing the parent through a lens, fixing the
	 * findings the lenses filed, in the order given, or rechecking through a lens the fixer's diff
	 * against the findings of the lens's that it closed.
	 */
	export type Work =
		// `gates`: the run's gate names, so the brief says what has checked the work and what has not;
		// `concurrent`: whether sibling sessions may work in the same tree meanwhile.
		| {
				kind: "implement";
				gates: readonly string[];
				concurrent: boolean;
				retry?: Gates.Result;
		  }
		| { kind: "lens"; name: string; prompt: string; gates: readonly string[] }
		| { kind: "fix"; findings: readonly Task[]; gates: readonly string[] }
		| {
				kind: "recheck";
				name: string;
				prompt: string;
				findings: readonly Task[];
				base: string;
				diff: string;
				gates: readonly string[];
		  };

	type Claim = {
		parent: Task;
		/** The subtask it implements, or the parent a lens or the fixer works on. */
		task: Task;
		harness: Harnesses.Id;
		sessionId: string;
		lane: string;
		work: Work;
		/** The attempt a dead runner cut short, which this claim continues. */
		interrupted?: Brief.Interrupted;
		/** The attempt whose session this gate retry continues, its harness willing. */
		resumes?: Retry.Resume;
		/** The tier its subtask's `tier:` tag names (`Route`), which wins over the run's model. */
		tier?: string;
		/** The harness's named agent its subtask's `agent:` tag names, which its session runs as. */
		agent?: string;
		/**
		 * What the attempt whose session it resumes ran as, kept in place of its tags: that
		 * session's agent and model.
		 */
		kept?: Kept;
	};

	/** A resumed attempt's agent, and its model and where that came from, as its claim recorded them. */
	export type Kept = {
		agent?: string;
		model?: string;
		source?: Route.Source;
		tier?: string;
	};

	// The agent a claim's session runs as: the one its resumed attempt ran as, else its tag's.
	const agentOf = (claim: Claim): string | undefined =>
		claim.kept ? claim.kept.agent : claim.agent;

	// A kept model is asked for again only where the run chose it (a tier or the run's model): an
	// agent's pin runs unasked, and the harness's default is the session's own.
	const keptModel = (kept: Kept): Route.Model =>
		(kept.source === "tier" ||
			kept.source === "run" ||
			kept.source === "agent") &&
		kept.model !== undefined
			? {
					model: kept.model,
					source: kept.source,
					...(kept.tier ? { tier: kept.tier } : {}),
					notes: [],
				}
			: { source: "default", notes: [] };

	/** What a claim's session ran as, once it opened: its agent, and its model and where that came from. */
	type Ran = {
		agent?: string;
		model?: string;
		source: Route.Source;
		tier?: string;
	};

	export type Hooks = {
		event: (event: RunStore.EventDraft) => void;
		/**
		 * The harness session is open: its id, kept so a runner that dies can resume it, and what it
		 * runs as.
		 */
		opened: (acpSessionId: string, ran: Ran) => void;
		usage: (usage: Budget.Usage) => void;
		/** A turn ended with active-owned work. True spends one continuation and nudges. */
		continueTurn: () => boolean;
		/**
		 * The harness asks to run a tool. Resolves with the option id the human chose, or an
		 * error once `withdrawn` aborts (the harness took the request back) or `stopped` does (the
		 * claim was cancelled or closed), which the ACP client sends as `cancelled`: never an
		 * answer of the loop's own.
		 */
		permission: (
			request: AcpClient.PermissionRequest,
			withdrawn: AbortSignal,
			stopped: AbortSignal,
		) => Promise<Result<string>>;
		/**
		 * The harness asks the human to fill a form (AskUserQuestion, an MCP server's form). The
		 * answer, or an error on the same terms as `permission`, which the ACP client sends as
		 * `cancel`: never a form the loop filled itself.
		 */
		elicitation: (
			request: AcpClient.ElicitationRequest,
			withdrawn: AbortSignal,
			stopped: AbortSignal,
		) => Promise<Result<AcpClient.ElicitationAnswer>>;
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
		name: CopilotInstructions.SERVER_NAME,
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
	 * The loop's launch profile, not the copilot's: no model pinned in the env (a run that names
	 * one selects it as the session opens, before its mode), the installed CLI rather than the adapter's
	 * bundled copy, and a marker of its own so the user's hooks can tell a loop session from a
	 * board copilot. Its instructions ride the opening prompt, not a system prompt append.
	 * It sets no allow list or settings file. The session opens in the harness's own auto mode
	 * (`AcpClient.newSession`), the harness decides what still gets asked, and every request
	 * reaches the human (`permission.ts`), as does every form it asks them to fill
	 * (`elicitation.ts`).
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
		/** One event of a tool call: its id and what it was given and gave back so far. */
		tool: (type: string, id: string, call: ToolCalls.Call) => void;
		progress: (body: string) => Promise<void>;
		usage: Hooks["usage"];
		/** The agent's latest complete message. */
		message: (text: string) => void;
	};

	// One non-prose update: the turn's end when it is one, else undefined after recording it.
	const forward = async (
		update: Exclude<AcpClient.Update, Prose>,
		calls: Map<string, ToolCalls.Call>,
		sink: Sink,
	): Promise<Turn | undefined> => {
		switch (update.type) {
			case "tool_call": {
				const call = ToolCalls.apply(calls, update);
				sink.tool("tool_call", update.id, call);
				await sink.progress(call.title);
				return undefined;
			}
			// The updates in between (a refined title, the input once complete) are folded into the
			// call and land with its end, which carries the call whole.
			case "tool_call_update": {
				const call = ToolCalls.apply(calls, update);
				if (update.status === "completed" || update.status === "failed")
					sink.tool(`tool_${update.status}`, update.id, call);
				return undefined;
			}
			case "plan":
				sink.emit(
					"plan",
					update.entries.map((e) => `[${e.status}] ${e.content}`).join("; "),
				);
				return undefined;
			case "mode":
				sink.emit("mode", `mode ${update.id}: moved there by the harness`, {
					mode: update.id,
				});
				return undefined;
			// What the harness wanted the human to know, such as why it is not in the mode asked for.
			case "notice":
				sink.emit("notice", `${update.severity}: ${update.text}`, {
					severity: update.severity,
				});
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
		const calls = new Map<string, ToolCalls.Call>();
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
			const end = await forward(update, calls, sink);
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
	 * Launch the claim's harness on the loop's profile and open its session, resuming the one it
	 * continues where it can. `connected` hears of the process as soon as it is up, so a
	 * session that fails to open still has it closed.
	 */
	const open = async (
		claim: Claim,
		env: Env,
		sink: Sink,
		on: {
			permission: AcpClient.OnPermission;
			elicitation: AcpClient.OnElicitation;
			connected: (connection: AcpClient.Connection) => void;
		},
	): Promise<Result<Opened & { ran: Ran }>> => {
		const cli = Harnesses.installedCli(claim.harness);
		if (!cli.ok) return cli;
		const profile = loopProfile(env.runId, cli.value);
		const launched = Harnesses.resolve(claim.harness, env.overrides, profile);
		sink.emit("launch", describeLaunch(launched, cli.value));
		const spawned = await AcpClient.spawn(claim.harness, env.cwd, {
			onPermission: on.permission,
			onElicitation: on.elicitation,
			// Recorded as the harness's own notices are, so the event log says why it saw `cancel`.
			onElicitationRefused: (reason) =>
				sink.emit("notice", `error: ${reason}`, { severity: "error" }),
			...(env.overrides ? { overrides: env.overrides } : {}),
			profile,
		});
		if (!spawned.ok) return spawned;
		on.connected(spawned.value);
		// An agent that pins its own model keeps it, so none is selected over it: read from its
		// definition, since the session's model option goes on naming the session's own.
		const agent = agentOf(claim);
		const pin =
			claim.kept || agent === undefined
				? undefined
				: Harnesses.agentDefinition(claim.harness, agent, env.cwd)?.model;
		const asked = claim.kept
			? keptModel(claim.kept)
			: Route.model(
					env.models ?? { tiers: {} },
					claim.harness,
					{
						...(claim.tier ? { tier: claim.tier } : {}),
						...(agent ? { agent } : {}),
					},
					pin,
				);
		for (const note of asked.notes) sink.emit("warning", note);
		const started = await reopen(
			claim,
			env,
			spawned.value,
			sink,
			asked.source === "agent" ? undefined : asked.model,
		);
		if (!started.ok) return started;
		const { session } = started.value;
		const ranAs = emitAgent(session, sink);
		// A pin only holds for an agent the session runs as; without it, the harness's own model.
		const model = emitModel(
			session,
			asked.source === "agent" && ranAs === undefined
				? { source: "default", notes: [] }
				: asked,
			sink,
		);
		// Which mode decides what gets asked: the harness's auto mode, or why not.
		const { mode } = session;
		sink.emit(
			"mode",
			mode.note,
			mode.current
				? { mode: mode.current, ...(mode.via ? { via: mode.via } : {}) }
				: undefined,
		);
		return ok({
			...started.value,
			ran: { ...(ranAs ? { agent: ranAs } : {}), ...model },
		});
	};

	/**
	 * The named agent the session runs as, when one was asked for and the harness says it runs it;
	 * a warning says why not otherwise, and the session goes on as the harness's default agent.
	 */
	const emitAgent = (
		session: AcpClient.Session,
		sink: Sink,
	): string | undefined => {
		const chosen = session.agent;
		if (!chosen) return undefined;
		if (!chosen.applied || chosen.current === undefined) {
			sink.emit("warning", chosen.note);
			return undefined;
		}
		sink.emit("agent", chosen.current);
		return chosen.current;
	};

	/**
	 * The model the session opened on, new or resumed, which `AcpClient` selected before the mode
	 * was negotiated. The `model` event names only what the harness says it runs: a model it could
	 * not take, or did not confirm, is a warning, and the session goes on. An agent's pinned model
	 * is the exception: nothing was selected over it, and the harness's model option goes on naming
	 * the session's own, so the pin is what it runs.
	 */
	const emitModel = (
		session: AcpClient.Session,
		asked: Route.Model,
		sink: Sink,
	): Pick<Ran, "model" | "source" | "tier"> => {
		if (asked.source === "agent" && asked.model !== undefined) {
			sink.emit("model", asked.model, { source: "agent" });
			return { model: asked.model, source: "agent" };
		}
		const chosen = session.model;
		if (chosen && !chosen.applied) sink.emit("warning", chosen.note);
		const option = session.configOptions.find(
			(o) => o.category === "model" && o.type === "select",
		);
		const current = chosen
			? chosen.current
			: option?.type === "select"
				? option.currentValue
				: undefined;
		const source = chosen?.applied ? asked.source : "default";
		const tier = source !== "default" ? asked.tier : undefined;
		if (current === undefined) return { source };
		sink.emit("model", current, { source, ...(tier ? { tier } : {}) });
		return { model: current, source, ...(tier ? { tier } : {}) };
	};

	type Opened = { session: AcpClient.Session; resumed: boolean };

	type Reopen = {
		/** The attempt whose session is resumed, and that session. */
		lane: string;
		acpSessionId: string;
		/** Why it is resumed, for the trace: empty for an interrupted attempt. */
		purpose: string;
		/** What happens instead when it is not. */
		instead: string;
	};

	// Session `acpSessionId` resumed, else a new session; the trace says which, and why.
	const resume = async (
		claim: Claim,
		connection: AcpClient.Connection,
		options: AcpClient.ResumeOptions,
		sink: Sink,
		{ lane, acpSessionId: id, purpose, instead }: Reopen,
	): Promise<Result<Opened>> => {
		const reopened = await AcpClient.resumeOrStart(connection, id, options);
		if (!reopened.ok) return reopened;
		sink.emit(
			reopened.value.resumed ? "session_resumed" : "warning",
			reopened.value.resumed
				? `${claim.harness} session ${id} of ${lane}, resumed${purpose}`
				: `${claim.harness} session ${id} of ${lane} not resumed${purpose} (${reopened.value.why}): ${instead}`,
		);
		return ok(reopened.value);
	};

	/**
	 * The harness session of the attempt this claim continues, resumed where the harness can: an
	 * interrupted attempt's, or the one a gate retry continues. Else a new session.
	 */
	const reopen = async (
		claim: Claim,
		env: Env,
		connection: AcpClient.Connection,
		sink: Sink,
		model: string | undefined,
	): Promise<Result<Opened>> => {
		const agent = agentOf(claim);
		const options = {
			cwd: env.cwd,
			mcpServers: [mcpServer(env, claim.harness)],
			...(env.mode ? { mode: env.mode } : {}),
			...(model === undefined ? {} : { model }),
			...(agent === undefined ? {} : { agent }),
		};
		const previous = claim.interrupted;
		if (previous?.acpSessionId !== undefined)
			return resume(claim, connection, options, sink, {
				lane: previous.lane,
				acpSessionId: previous.acpSessionId,
				purpose: "",
				instead: "a new session takes over",
			});
		if (previous)
			sink.emit(
				"warning",
				`${previous.lane} recorded no ${claim.harness} session to resume: a new session takes over`,
			);
		else if (claim.resumes)
			return resume(claim, connection, options, sink, {
				...claim.resumes,
				purpose: " for a gate retry",
				instead: "a new session gets the full brief",
			});
		const started = await AcpClient.newSession(connection, options);
		return started.ok
			? ok({ session: started.value, resumed: false })
			: started;
	};

	// The checklist of the task an implementing claim works; none for a review or the fixer.
	const checklistOf = async (
		claim: Claim,
		env: Env,
	): Promise<Result<Checklists.Item[]>> =>
		claim.work.kind === "implement"
			? Checklists.of(env.basePath, claim.task.id)
			: ok([]);

	// What a resumed session hears first: it has its brief already, so only why it is prompted again.
	const resumedPrompt = async (
		claim: Claim,
		env: Env,
	): Promise<Result<string | undefined>> => {
		if (claim.interrupted) {
			const checklist = await checklistOf(claim, env);
			return checklist.ok
				? ok(Brief.resumed(claim.interrupted, checklist.value))
				: checklist;
		}
		const { work } = claim;
		return ok(
			work.kind === "implement" && work.retry
				? Brief.retriedInSession(claim.task, work.retry)
				: undefined,
		);
	};

	type Next =
		| { kind: "end"; outcome: Outcome["outcome"]; detail: string }
		| { kind: "prompt"; prompt: string };

	// A lens has one turn: its review, or its recheck. What it found is in the tracker, not in what
	// it said.
	const reviewed = (
		name: string,
		reason: string,
		review: "review" | "recheck",
	): Next =>
		reason === "end_turn"
			? {
					kind: "end",
					outcome: "done",
					detail: `the ${name} lens finished its ${review}`,
				}
			: {
					kind: "end",
					outcome: "incomplete",
					detail: `the ${name} lens's ${review} turn ended (${reason})`,
				};

	// A session that closed its issue with checklist items open: the run has reopened it, and nudges
	// the session on from the first open item, as it nudges any turn that left owned work open.
	const refused = (
		task: Task,
		open: readonly [Checklists.Item, ...Checklists.Item[]],
		hooks: Hooks,
		sink: Sink,
		reason: string,
	): Next => {
		const left = `${open.length} checklist item${open.length === 1 ? "" : "s"} open`;
		sink.emit("reopened", `${label(task)} reopened: closed with ${left}`);
		if (reason !== "end_turn" || !hooks.continueTurn())
			return {
				kind: "end",
				outcome: "incomplete",
				detail: `turn ended (${reason}) with ${label(task)} closed with ${left}: reopened`,
			};
		sink.emit("continuation", `${label(task)} has ${left}: nudged`);
		return { kind: "prompt", prompt: Brief.reopened(task, open) };
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
		const reopened = await Checklists.refuseDone(
			env.basePath,
			task,
			claim.harness,
		);
		if (!reopened.ok)
			return { kind: "end", outcome: "error", detail: reopened.error.message };
		const [first, ...rest] = reopened.value;
		if (first) return refused(task, [first, ...rest], hooks, sink, reason);
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
		const checklist = await Checklists.of(env.basePath, task.id);
		if (!checklist.ok)
			return { kind: "end", outcome: "error", detail: checklist.error.message };
		sink.emit("continuation", `${label(task)} still ${task.state}: nudged`);
		return {
			kind: "prompt",
			prompt: Brief.continuation(task, Checklists.open(checklist.value)),
		};
	};

	// The fixer's findings it has yet to settle: still claimable, or taken by its own harness. One
	// it closed, or parked for a human with a comment, is settled; so is one a human took.
	const unsettled = async (
		findings: readonly Task[],
		env: Env,
		harness: string,
	): Promise<Result<Task[]>> => {
		const left: Task[] = [];
		for (const finding of findings) {
			const now = await Planner.getTask(env.basePath, finding.id);
			if (!now.ok) return now;
			const task = now.value;
			if (
				task &&
				(LoopPlan.canClaim(task, new Date()) ||
					LoopPlan.isActive(task, harness))
			)
				left.push(task);
		}
		return ok(left);
	};

	const fixed = async (
		{ harness, findings }: { harness: Harnesses.Id; findings: readonly Task[] },
		env: Env,
		hooks: Hooks,
		sink: Sink,
		reason: string,
	): Promise<Next> => {
		const left = await unsettled(findings, env, harness);
		if (!left.ok)
			return { kind: "end", outcome: "error", detail: left.error.message };
		if (left.value.length === 0)
			return {
				kind: "end",
				outcome: "done",
				detail: `settled all ${findings.length} finding${findings.length === 1 ? "" : "s"}`,
			};
		const open = left.value.map(label).join(", ");
		if (reason !== "end_turn" || !hooks.continueTurn())
			return {
				kind: "end",
				outcome: "incomplete",
				detail: `turn ended (${reason}) with ${open} still open`,
			};
		sink.emit("continuation", `${open} still open: nudged`);
		return { kind: "prompt", prompt: Brief.fixerContinuation(left.value) };
	};

	const afterTurn = async (
		claim: Claim,
		env: Env,
		hooks: Hooks,
		sink: Sink,
		reason: string,
	): Promise<Next> => {
		const { work } = claim;
		switch (work.kind) {
			case "lens":
				return reviewed(work.name, reason, "review");
			case "recheck":
				return reviewed(work.name, reason, "recheck");
			case "fix":
				return fixed(
					{ harness: claim.harness, findings: work.findings },
					env,
					hooks,
					sink,
					reason,
				);
			case "implement":
				return implemented(claim, env, hooks, sink, reason);
		}
	};

	/**
	 * The claim's first prompt in a new session: its task's assembled brief, under the lens's or the
	 * run's words and what an interrupted attempt before it left.
	 */
	const opening = async (claim: Claim, env: Env): Promise<Result<string>> => {
		const assembled = await Planner.assembleContext(
			env.basePath,
			claim.task.id,
		);
		if (!assembled.ok)
			return err(new Error(`brief: ${assembled.error.message}`));
		const checklist = await checklistOf(claim, env);
		if (!checklist.ok)
			return err(new Error(`checklist: ${checklist.error.message}`));
		const subject = {
			runId: env.runId,
			parent: claim.parent,
			task: claim.task,
			...(claim.interrupted ? { interrupted: claim.interrupted } : {}),
		};
		const { work } = claim;
		switch (work.kind) {
			case "lens":
				return ok(
					Brief.lens(
						{
							...subject,
							lens: work.name,
							prompt: work.prompt,
							gates: work.gates,
						},
						assembled.value,
					),
				);
			case "fix":
				return ok(
					Brief.fixer(
						{ ...subject, findings: work.findings, gates: work.gates },
						assembled.value,
					),
				);
			case "recheck":
				return ok(
					Brief.recheck(
						{
							...subject,
							lens: work.name,
							prompt: work.prompt,
							findings: work.findings,
							base: work.base,
							diff: work.diff,
							gates: work.gates,
						},
						assembled.value,
					),
				);
			case "implement":
				return ok(
					Brief.opening(
						{
							...subject,
							gates: work.gates,
							concurrent: work.concurrent,
							checklist: checklist.value,
							...(work.retry ? { retry: work.retry } : {}),
						},
						assembled.value,
					),
				);
		}
	};

	const started = ({ harness, task, work }: Claim): string => {
		switch (work.kind) {
			case "lens":
				return `${harness} reviews ${label(task)} through the ${work.name} lens`;
			case "fix":
				return `${harness} fixes ${work.findings.length} finding${work.findings.length === 1 ? "" : "s"} of ${label(task)}`;
			case "recheck":
				return `${harness} rechecks the fixer's diff on ${label(task)} through the ${work.name} lens`;
			case "implement":
				return `${harness} on ${label(task)}`;
		}
	};

	const toolEvent = (
		type: string,
		id: string,
		call: ToolCalls.Call,
	): RunStore.EventDraft => {
		const detail = ToolCalls.detail(call);
		return {
			type,
			summary: call.title,
			callId: id,
			...(Object.keys(detail).length > 0 ? { detail } : {}),
		};
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
		// Aborting it lets go of every permission request and form still waiting on a human. A claim that
		// is cancelled, closed or over has nobody left to answer for, and the harness would
		// otherwise sit on a request that never settles.
		const waiting = new AbortController();

		const sink: Sink = {
			emit: (type, summary, data) =>
				hooks.event({ ...tag, type, summary, ...(data ? { data } : {}) }),
			tool: (type, id, call) =>
				hooks.event({ ...tag, ...toolEvent(type, id, call) }),
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
				permission: (request, withdrawn) =>
					hooks.permission(request, withdrawn, waiting.signal),
				elicitation: (request, withdrawn) =>
					hooks.elicitation(request, withdrawn, waiting.signal),
				connected: (c) => {
					connection = c;
				},
			});
			if (!opened.ok) return ended("error", opened.error.message);
			const current = opened.value.session;
			session = current;
			hooks.opened(current.id, opened.value.ran);
			sink.emit("session_start", started(claim));
			const again = opened.value.resumed
				? await resumedPrompt(claim, env)
				: ok(undefined);
			if (!again.ok) return ended("error", again.error.message);
			let text = again.value ?? first.value;
			for (;;) {
				if (cancelled) return ended("cancelled");
				const result = await steering.turn(current, text);
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
				const next = await afterTurn(claim, env, hooks, sink, result.reason);
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
