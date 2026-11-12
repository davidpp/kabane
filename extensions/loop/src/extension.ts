// The loop as an official extension: one `kabane loop` command whose first positional picks the
// entry point. The CLI has already wired the runtime (`openContext`) by the time `run` is called.
import { Harnesses } from "@cabane/acp";
import { err, ok, type Result } from "@cabane/core";
import { Self } from "@cabane/core/self";
import {
	type Extension,
	failure,
	flagBool,
	flagList,
	flagString,
	type Outcome,
	type ParsedArgs,
	type Settings,
	success,
	usage,
} from "@cabane/extension";
import { LoopActivity } from "./activity";
import { Loop } from "./commands";
import { LoopConfig } from "./config";
import { LoopDispatcher } from "./dispatcher";
import { Lenses } from "./lenses";
import { Parent } from "./parent";
import { RunStore } from "./store";

const USAGE = `kabane loop start <issue> [--dir <path>] [--implementer claude|codex|gemini] [--model <tier|model>] [--concurrency <n>] [--continuations <n>] [--spend <amount>] [--gate <name>=<command>]... [--worktree|--no-worktree] [--isolation worktree|shared] [--lens <name>]... [--verifier claude|codex|gemini] [--recheck|--no-recheck] [--land none|pr]
       kabane loop advise <issue> [start's flags]   (the settings advised for the plan and why, and what each subtask's tags run it on; starts nothing)
       kabane loop run <runId>
       kabane loop status [<runId>]
       kabane loop stop <runId>
       kabane loop pause|resume <runId>      (resume also restarts a run whose runner died)
       kabane loop skip|next <subtask|issue>
       kabane loop rollback <runId> <sha>
       kabane loop answer <questionId> <option>
       kabane loop land <runId>              (pushes a completed run's branch and opens its pull request)
       kabane loop prune                     (removes run worktrees, and their branches, whose work is merged)

A subtask's tags route its claim: tier:<name> asks for a tier's model (loop.tiers) over --model,
tier:<harness>/<name> also runs it on that harness, and agent:<name> runs it as the harness's named
agent (Claude's .claude/agents; an agent that pins a model keeps it). A tag the run cannot honour is
noted on the trace and the claim runs on the run's settings.`;

// The executable the runner and each session's MCP server run as: this process's own.
const kabaneBin = Self.executable;

const number = (args: ParsedArgs, flag: string): number | undefined => {
	const value = flagString(args, flag);
	return value === undefined ? undefined : Number(value);
};

// `--gate test="bun test"`, repeated: the name before the first `=`, the command after it.
const gatesFrom = (args: ParsedArgs): Result<Record<string, string>> => {
	const gates: Record<string, string> = {};
	for (const given of flagList(args, "gate")) {
		const at = given.indexOf("=");
		if (at <= 0)
			return err(
				new Error(
					`--gate takes <name>=<command>, not ${JSON.stringify(given)}`,
				),
			);
		gates[given.slice(0, at).trim()] = given.slice(at + 1).trim();
	}
	return ok(gates);
};

// The settings on by default that a flag pair switches: a run has a worktree, and rechecks its
// fixes, unless a settings layer or `--no-<name>` turns it off; `--<name>` turns it back on over a
// layer that turns it off.
const SWITCHES = ["worktree", "recheck"] as const;

const switchesFrom = (
	args: ParsedArgs,
): Partial<Record<(typeof SWITCHES)[number], boolean>> =>
	Object.fromEntries(
		SWITCHES.flatMap((name): [string, boolean][] => {
			if (flagBool(args, `no-${name}`)) return [[name, false]];
			return flagBool(args, name) ? [[name, true]] : [];
		}),
	);

const isLand = (value: string): value is LoopConfig.Config["land"] =>
	(LoopConfig.LAND as readonly string[]).includes(value);

const isIsolation = (value: string): value is LoopConfig.Config["isolation"] =>
	(LoopConfig.ISOLATION as readonly string[]).includes(value);

// Flags become the caller's layer, validated with the layers below it.
const configFrom = (args: ParsedArgs): Result<LoopConfig.Input> => {
	const implementer = flagString(args, "implementer");
	const verifier = flagString(args, "verifier");
	const model = flagString(args, "model");
	const lenses = flagList(args, "lens");
	const land = flagString(args, "land");
	const isolation = flagString(args, "isolation");
	const gates = gatesFrom(args);
	if (!gates.ok) return gates;
	const budget = Object.fromEntries(
		[
			["concurrency", number(args, "concurrency")],
			["continuations", number(args, "continuations")],
			["spend", number(args, "spend")],
		].filter(([, value]) => value !== undefined),
	);
	return ok({
		...(implementer && Harnesses.isId(implementer) ? { implementer } : {}),
		...(model ? { model } : {}),
		budget,
		gates: gates.value,
		...switchesFrom(args),
		...(isolation && isIsolation(isolation) ? { isolation } : {}),
		...(lenses.length > 0 ? { lenses } : {}),
		...(verifier && Harnesses.isId(verifier) ? { verifier } : {}),
		...(land && isLand(land) ? { land } : {}),
	});
};

const line = (run: RunStore.Run): string =>
	[
		run.id,
		run.status,
		run.parentShortId,
		`${run.claims.length} claims`,
		run.exit
			? `${run.exit.reason}${run.exit.detail ? ` (${run.exit.detail})` : ""}`
			: "",
	]
		.filter((part) => part !== "")
		.join("  ");

// A question's text under its first line: a form's question runs over several lines (the
// harness's message, the field, how to answer), and the later ones line up with its choices.
const indented = (text: string): string => text.split("\n").join("\n    ");

// A question waiting on a human, with what `kabane loop answer` takes for it.
const question = (q: Loop.Waiting): string =>
	[
		`  waiting on you: ${q.task} ${indented(q.question)}`,
		...q.choices.map((choice, i) => `    ${i + 1}. ${choice}`),
		`    kabane loop answer ${q.questionId} <option>`,
	].join("\n");

// Where a run with a worktree works, and the checkpoints `rollback` takes.
const worktree = (run: RunStore.Run): string[] =>
	run.worktree
		? [
				`  worktree: ${run.worktree}${run.worktreeReused ? ` (run ${run.worktreeReused.runId}'s, branch ${run.worktreeReused.branch})` : ""}`,
				...RunStore.checkpoints(run).map((sha) => `    checkpoint ${sha}`),
			]
		: [];

// How the run's branch landed, and the command that tries again when it did not.
const landing = (run: RunStore.Run): string[] => [
	...interrupted(run),
	...landed(run),
];

// A landing a runner died in that is not undone yet keeps everything off the worktree.
const interrupted = (run: RunStore.Run): string[] =>
	run.landingFrom && run.worktree
		? [
				`  interrupted landing not undone: put branch ${RunStore.branchOf(run)} in ${run.worktree} back at ${run.landingFrom.slice(0, 12)} (remove a lock file git left there if it says so), then ${Loop.died(run) ? Loop.restartCommand(run.id) : Parent.landCommand(run.id)}`,
			]
		: [];

const landed = (run: RunStore.Run): string[] => {
	if (!run.landing) return [];
	return run.landing.ok
		? [`  landed: ${run.landing.summary}`]
		: [
				`  ${run.landing.summary}`,
				`  land again: ${Parent.landCommand(run.id)}`,
			];
};

// A question the run's dead runner left: shown, with no answer to give.
const withdrawn = (q: Loop.Waiting): string =>
	`  withdrawn, its runner died: ${q.task} ${indented(q.question)} (the restarted run asks again)`;

// Where a claim's model came from, as `loop status` and `loop advise` read it.
const modelSource = (
	claim: Pick<RunStore.Claim, "modelSource" | "tier" | "agent">,
): string => {
	switch (claim.modelSource) {
		case "tier":
			return `tier ${claim.tier}`;
		case "run":
			return claim.tier ? `the run's tier ${claim.tier}` : "the run's model";
		case "agent":
			return `${claim.agent}'s pin`;
		default:
			return "the harness's default";
	}
};

// Each claim of the run: what it ran on (harness, agent, model and why) and how it ended.
const claimLine = (claim: RunStore.Claim): string =>
	[
		`  ${claim.lane}`,
		claim.harness,
		...(claim.agent ? [`agent ${claim.agent}`] : []),
		...(claim.model
			? [`model ${claim.model} (${modelSource(claim)})`]
			: claim.modelSource
				? [`model unknown (${modelSource(claim)})`]
				: []),
		claim.outcome ?? (claim.endedAt ? "ended" : "running"),
	].join("  ");

// A run whose runner died waits on a human to bring it back.
const restart = (run: RunStore.Run): string[] =>
	Loop.died(run) ? [`  restart: ${Loop.restartCommand(run.id)}`] : [];

/** One run, its worktree, and the questions its sessions are waiting on a human for. */
const statusOf = async (
	deps: Pick<Loop.Deps, "home" | "basePath">,
	runId: string,
): Promise<Outcome> => {
	const run = Loop.status(deps, runId);
	if (!run.ok) return failure(run.error);
	// Before the waiting ones: a dead run's are withdrawn, and no longer wait.
	const gone = await Loop.withdraw(deps, run.value);
	if (!gone.ok) return failure(gone.error);
	const waiting = await Loop.questions(deps, runId);
	if (!waiting.ok) return failure(waiting.error);
	return success(
		{ ...run.value, questions: waiting.value, withdrawn: gone.value },
		[
			line(run.value),
			...restart(run.value),
			...worktree(run.value),
			...run.value.claims.map(claimLine),
			...landing(run.value),
			...gone.value.map(withdrawn),
			...waiting.value.map(question),
		].join("\n"),
	);
};

const answer = async (
	args: ParsedArgs,
	deps: Pick<Loop.Deps, "home" | "basePath"> & { actor: string },
): Promise<Outcome> => {
	const [, questionId] = args.positionals;
	// A label can be several words: everything after the id is the answer.
	const given = args.positionals.slice(2).join(" ");
	if (!questionId || given === "")
		return usage("answer needs a question id and an option", USAGE);
	const answered = await Loop.answer(deps, questionId, given);
	return answered.ok
		? success(
				answered.value,
				`${answered.value.task}: answered "${answered.value.answer}" (run ${answered.value.runId})`,
			)
		: failure(answered.error);
};

type Deps = Loop.Deps &
	Pick<Loop.StartDeps, "cwd" | "settings" | "runner"> & {
		actor: string;
		mode: Harnesses.Mode;
	};
type Verb = (args: ParsedArgs, deps: Deps, target: string) => Promise<Outcome>;

const ran = (result: Result<RunStore.Run>): Outcome =>
	result.ok ? success(result.value, line(result.value)) : failure(result.error);

// `git worktree add` checks out what is committed, and nothing git ignores comes with it: the
// run's worktree, and each subtask's (`ClaimTrees`).
const WORKTREE_NOTE =
	"  note: a new worktree has no ignored files (node_modules, build output): a gate that needs them installs them first, say `bun install && bun test`, and the loop.setup setting readies each subtask's own worktree before its session";

// What `start` and `advise` take, and `--as` and `--scope`, which every command takes. A misspelt flag
// (`--work-tree`) is refused rather than dropped, which would start a run the human did not ask for.
const START_FLAGS: ReadonlySet<string> = new Set([
	"dir",
	"implementer",
	"model",
	"concurrency",
	"continuations",
	"spend",
	"gate",
	"worktree",
	"no-worktree",
	"isolation",
	"recheck",
	"no-recheck",
	"lens",
	"verifier",
	"land",
	"as",
	"scope",
]);

// The flags that take one of a few values, and those values.
const CHOICES: readonly (readonly [string, readonly string[]])[] = [
	["implementer", Harnesses.IDS],
	["verifier", Harnesses.IDS],
	["land", LoopConfig.LAND],
	["isolation", LoopConfig.ISOLATION],
];

// Why `start`'s flags are refused, before any is read: one it does not take, a value not among a
// flag's choices, a switch given a value or both ways.
const refusedFlags = (args: ParsedArgs): string | undefined => {
	const unknown = Object.keys(args.flags).filter((f) => !START_FLAGS.has(f));
	if (unknown.length > 0)
		return `Unknown loop start flag${unknown.length === 1 ? "" : "s"}: ${unknown.map((f) => `--${f}`).join(", ")}`;
	for (const [flag, values] of CHOICES) {
		const given = flagString(args, flag);
		if (given !== undefined && !values.includes(given))
			return `--${flag} must be one of ${values.join(", ")}`;
	}
	// A switch followed by a stray word takes it as a value and would read as not given.
	for (const name of SWITCHES) {
		for (const flag of [name, `no-${name}`])
			if (flag in args.flags && !flagBool(args, flag))
				return `--${flag} takes no value, not ${JSON.stringify(args.flags[flag])}`;
		if (flagBool(args, name) && flagBool(args, `no-${name}`))
			return `Give one of --${name} and --no-${name}`;
	}
	return undefined;
};

// What `start`'s flags ask of a run of `parent`, `advise`'s too; an error is a usage line.
const inputFrom = (
	args: ParsedArgs,
	parent: string,
): Result<Loop.StartInput> => {
	const refused = refusedFlags(args);
	if (refused !== undefined) return err(new Error(refused));
	const config = configFrom(args);
	if (!config.ok) return config;
	const dir = flagString(args, "dir");
	return ok({ parent, ...(dir ? { dir } : {}), config: config.value });
};

/** `kabane loop start`: exported so a test can drive it with a runner of its own. */
export const start: Verb = async (args, deps, target) => {
	const input = inputFrom(args, target);
	if (!input.ok) return usage(input.error.message, USAGE);
	const started = await Loop.start(deps, input.value);
	if (!started.ok) return ran(started);
	const placed = Loop.placement(started.value);
	const isNew =
		started.value.worktree !== undefined && !started.value.worktreeReused;
	const moves = Lenses.moves(
		RunStore.projectRoot(started.value),
		started.value.config.lenses,
	);
	return success(
		started.value,
		[
			line(started.value),
			...(placed ? [`  ${placed}`] : []),
			...(isNew ? [WORKTREE_NOTE] : []),
			...moves.map((move) => `  note: ${move}`),
		].join("\n"),
	);
};

type Recommendation = Loop.Advised["advice"][number];

const shown = (value: unknown): string => {
	if (value === undefined) return "unset";
	if (typeof value !== "object" || value === null) return String(value);
	const entries = Object.entries(value);
	return entries.length === 0
		? "none"
		: entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
};

// What a setting is under the run's layers now, to read the advice against.
const current = (config: LoopConfig.Config, r: Recommendation): unknown => {
	switch (r.path) {
		case "budget.concurrency":
			return config.budget.concurrency;
		case "gates":
			return config.gates;
		default:
			return config[r.path];
	}
};

// `loop start` takes the advice only as flags; setup and stallAfter have none, only a setting.
const asFlags = (r: Recommendation): string[] => {
	switch (r.path) {
		case "budget.concurrency":
			return [`--concurrency ${r.value}`];
		case "isolation":
			return [`--isolation ${r.value}`];
		case "gates":
			return Object.entries(r.value).map(
				([name, command]) => `--gate ${name}=${JSON.stringify(command)}`,
			);
		default:
			return [];
	}
};

const asSetting = (r: Recommendation): string[] =>
	r.path === "setup" || r.path === "stallAfter"
		? [`loop.${r.path} ${JSON.stringify(r.value)}`]
		: [];

// A subtask's route: its tags, the harness, agent and model they run it on, and why one is not
// honoured.
const routedLines = (s: Loop.Routed): string[] => [
	`  ${s.task}  ${s.title}`,
	`    ${[
		s.tags.length > 0 ? s.tags.join(" ") : "no tier: or agent: tag",
		s.harness,
		...(s.agent ? [`agent ${s.agent}`] : []),
		`model ${s.model ?? "unset"} (${modelSource(s)})`,
	].join("  ")}`,
	...s.notes.map((note) => `    note: ${note}`),
];

const advisedText = (a: Loop.Advised): string => {
	const flags = a.advice.flatMap(asFlags);
	const settings = a.advice.flatMap(asSetting);
	return [
		`${a.parent} in ${a.projectDir}`,
		`  implementer ${a.config.implementer}  model ${a.config.model ?? "unset"}  tiers ${LoopConfig.tierNames(a.config).join(", ")}`,
		"advised:",
		...a.advice.map(
			(r) =>
				`  ${r.path} ${shown(r.value)} (now ${shown(current(a.config, r))}): ${r.reason}`,
		),
		...(flags.length > 0 ? [`  start with: ${flags.join(" ")}`] : []),
		...(settings.length > 0
			? [`  no start flag, a setting: ${settings.join(", ")}`]
			: []),
		...(a.subtasks.length > 0 ? ["subtasks:"] : []),
		...a.subtasks.flatMap(routedLines),
	].join("\n");
};

/** `kabane loop advise`: what `start` with the same flags would be advised, and how it would route. */
const advise: Verb = async (args, deps, target) => {
	const input = inputFrom(args, target);
	if (!input.ok) return usage(input.error.message, USAGE);
	const advised = await Loop.advise(deps, input.value);
	return advised.ok
		? success(advised.value, advisedText(advised.value))
		: failure(advised.error);
};

const rollback: Verb = async (args, deps, target) => {
	const sha = args.positionals[2];
	if (!sha) return usage("rollback needs a run id and a checkpoint sha", USAGE);
	const reset = await Loop.rollback(deps, target, sha);
	return reset.ok
		? success(
				reset.value,
				`${reset.value.worktree} reset to ${reset.value.sha.slice(0, 12)}; the tracker is unchanged`,
			)
		: failure(reset.error);
};

const pause =
	(kind: "pause" | "resume"): Verb =>
	async (_args, deps, target) => {
		const asked = Loop.pause(deps, target, kind);
		return asked.ok
			? success(asked.value, `${kind} requested for ${target}`)
			: failure(asked.error);
	};

// `resume` unpauses a live run and restarts one whose runner died, detached as `start` runs it.
const resume: Verb = async (args, deps, target) => {
	const run = Loop.status(deps, target);
	if (!run.ok || !Loop.died(run.value))
		return pause("resume")(args, deps, target);
	const restarted = await Loop.restart(deps, target);
	return restarted.ok
		? success(restarted.value, `restarted ${line(restarted.value)}`)
		: failure(restarted.error);
};

const direct =
	(kind: "skip" | "next"): Verb =>
	async (_args, deps, target) => {
		const asked = await Loop.direct(deps, kind, target);
		return asked.ok
			? success(
					asked.value,
					`${kind} ${asked.value.task} requested for ${asked.value.runId}`,
				)
			: failure(asked.error);
	};

// Each verb that takes a target, with what the target is for the usage line when it is missing.
const VERBS: Record<string, { needs: string; run: Verb }> = {
	start: { needs: "an issue, or a parent issue", run: start },
	advise: { needs: "an issue, or a parent issue", run: advise },
	run: {
		needs: "a run id",
		run: async (_a, deps, id) => ran(await Loop.run(deps, id)),
	},
	stop: {
		needs: "a run id",
		run: async (_a, deps, id) => ran(await Loop.stop(deps, id)),
	},
	pause: { needs: "a run id", run: pause("pause") },
	resume: { needs: "a run id", run: resume },
	skip: {
		needs: "a subtask, or the issue of a single-issue run",
		run: direct("skip"),
	},
	next: {
		needs: "a subtask, or the issue of a single-issue run",
		run: direct("next"),
	},
	rollback: { needs: "a run id", run: rollback },
	land: {
		needs: "a run id",
		run: async (_a, deps, id) => {
			const landed = await Loop.land(deps, id);
			if (!landed.ok) return failure(landed.error);
			return landed.value.landing?.ok
				? success(landed.value, landed.value.landing.summary)
				: failure(new Error(landed.value.landing?.summary ?? "Not landed"));
		},
	},
};

const prune = async (deps: Deps): Promise<Outcome> => {
	const pruned = await Loop.prune(deps);
	if (!pruned.ok) return failure(pruned.error);
	const lines = pruned.value.map(
		(p) =>
			`${p.removed ? "removed" : "kept"} ${p.dir}${p.branch ? ` (branch ${p.branch})` : ""}: ${p.why}`,
	);
	return success(pruned.value, lines.join("\n") || "No run worktrees left");
};

const list = (deps: Deps): Outcome => {
	const runs = Loop.list(deps);
	return runs.ok
		? success(runs.value, runs.value.map(line).join("\n") || "No loop runs")
		: failure(runs.error);
};

const command: Extension.Command = {
	name: "loop",
	summary:
		"Drive an issue, or a parent issue's subtasks, to completion through coding harnesses",
	usage: USAGE,
	run: async (args, ctx) => {
		const [verb, target] = args.positionals;
		const deps: Deps = {
			home: ctx.home,
			basePath: ctx.store,
			kabaneBin: kabaneBin(),
			cwd: ctx.cwd,
			actor: ctx.actor,
			mode: ctx.harnessMode,
			settings: ctx.settings,
		};
		if (verb === "answer") return answer(args, deps);
		if (verb === "status") return target ? statusOf(deps, target) : list(deps);
		if (verb === "prune") return prune(deps);
		const known = verb && Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;
		if (!known)
			return usage(
				verb ? `Unknown loop command: ${verb}` : "Missing loop command",
				USAGE,
			);
		return target
			? known.run(args, deps, target)
			: usage(`${verb} needs ${known.needs}`, USAGE);
	},
};

// How the loop's settings read, here and in the board's run form (`LoopSettings`): the form's
// sections come in the order these first name them. A bound the schema states is not repeated: a
// bounded integer steps through its range.
const looks: Settings.Looks = {
	implementer: { label: "implementer", group: "Agents" },
	// A tier, resolved per harness through `loop.tiers`, or a model id the harness lists
	// (`LoopConfig.resolveModel`). The form adds the tiers `loop.tiers` names (`LoopSettings`).
	// Unset, the user's own settings decide.
	model: {
		label: "model",
		group: "Agents",
		options: LoopConfig.TIERS,
		none: "your own",
	},
	// Unset, it follows isolation: 2 in a worktree each, 1 in the run's one tree.
	"budget.concurrency": {
		label: "sessions at once",
		group: "Limits",
		none: "by isolation",
	},
	"budget.continuations": {
		label: "continuations",
		group: "Limits",
		options: [0, 1, 2, 3, 5, 10],
	},
	"budget.spend": {
		label: "spend",
		group: "Limits",
		options: [1, 5, 10, 25, 50, 100],
	},
	stallAfter: {
		label: "stall after (attempts)",
		group: "Limits",
		options: [1, 2, 3, 4, 5, 6],
	},
	// Unset, the lenses run on the implementer's harness.
	verifier: { label: "verifier", group: "Agents", none: "implementer" },
	lenses: {
		label: "lenses",
		group: "Checks",
		options: ({ projectDir }) => Lenses.offered(projectDir),
	},
	recheck: { label: "recheck the fixes", group: "Checks" },
	worktree: { label: "own git worktree", group: "Workspace" },
	isolation: { label: "each subtask works in", group: "Workspace" },
	reuse: { label: "reuse subtask worktrees", group: "Workspace" },
	// Unset, as many as the run has sessions at once.
	maxWorktrees: {
		label: "subtask worktrees kept",
		group: "Workspace",
		none: "one per session",
	},
	land: { label: "land the branch", group: "Workspace" },
};

export const loop: Extension = {
	name: LoopConfig.NAMESPACE,
	settings: LoopConfig.SettingsSchema,
	looks,
	commands: [command],
	// Each run on this device is a card with a tab of its own on the board, headed by the run's state.
	// `a` on an issue, alone or with subtasks, starts one from the board's directory, as `loop start` would.
	board: async (ctx) => {
		const LoopHeader = (await import("./header")).LoopHeader;
		return {
			activity: LoopActivity.source({
				home: ctx.home,
				basePath: ctx.store,
				actor: ctx.actor,
				kabaneBin: kabaneBin(),
			}),
			dispatcher: LoopDispatcher.make({
				home: ctx.home,
				basePath: ctx.store,
				kabaneBin: kabaneBin(),
				cwd: ctx.cwd,
				settings: ctx.settings,
			}),
			headers: { [LoopActivity.KIND]: LoopHeader.make(ctx.home, ctx.store) },
		};
	},
};
