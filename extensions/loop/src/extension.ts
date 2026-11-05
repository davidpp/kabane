// The loop as an official extension: one `kabane loop` command whose first positional picks the
// entry point. The CLI has already wired the runtime (`openContext`) by the time `run` is called.
import { resolve } from "node:path";
import { Harnesses } from "@cabane/acp";
import { err, ok, type Result } from "@cabane/core";
import {
	type Extension,
	failure,
	flagBool,
	flagList,
	flagString,
	type Outcome,
	type ParsedArgs,
	success,
	usage,
} from "@cabane/extension";
import { LoopActivity } from "./activity";
import { Loop } from "./commands";
import { LoopConfig } from "./config";
import { LoopDispatcher } from "./dispatcher";
import { LoopHeader } from "./header";
import { RunStore } from "./store";

const USAGE = `kabane loop start <issue> [--dir <path>] [--implementer claude|codex|gemini] [--model <name>] [--concurrency <n>] [--continuations <n>] [--spend <amount>] [--gate <name>=<command>]... [--worktree|--no-worktree] [--lens <name>]... [--verifier claude|codex|gemini]
       kabane loop run <runId>
       kabane loop status [<runId>]
       kabane loop stop <runId>
       kabane loop pause|resume <runId>      (resume also restarts a run whose runner died)
       kabane loop skip|next <subtask|issue>
       kabane loop rollback <runId> <sha>
       kabane loop answer <questionId> <option>`;

// The executable the runner and each session's MCP server run as: this process's own entry.
const kabaneBin = (): string => {
	const entry = process.argv[1];
	return entry ? resolve(entry) : "kabane";
};

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

// A run has a worktree unless a settings layer or `--no-worktree` turns it off; `--worktree` turns
// it back on over a layer that turns it off.
const worktreeFrom = (args: ParsedArgs): { worktree?: boolean } => {
	if (flagBool(args, "no-worktree")) return { worktree: false };
	return flagBool(args, "worktree") ? { worktree: true } : {};
};

// Flags become the caller's layer, validated with the layers below it.
const configFrom = (args: ParsedArgs): Result<LoopConfig.Input> => {
	const implementer = flagString(args, "implementer");
	const verifier = flagString(args, "verifier");
	const model = flagString(args, "model");
	const lenses = flagList(args, "lens");
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
		...worktreeFrom(args),
		...(lenses.length > 0 ? { lenses } : {}),
		...(verifier && Harnesses.isId(verifier) ? { verifier } : {}),
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

// A question the run's dead runner left: shown, with no answer to give.
const withdrawn = (q: Loop.Waiting): string =>
	`  withdrawn, its runner died: ${q.task} ${indented(q.question)} (the restarted run asks again)`;

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
	Pick<Loop.StartDeps, "cwd" | "settings"> & {
		actor: string;
		mode: Harnesses.Mode;
	};
type Verb = (args: ParsedArgs, deps: Deps, target: string) => Promise<Outcome>;

const ran = (result: Result<RunStore.Run>): Outcome =>
	result.ok ? success(result.value, line(result.value)) : failure(result.error);

// `git worktree add` checks out what is committed, and nothing git ignores comes with it.
const WORKTREE_NOTE =
	"  note: a new worktree has no ignored files (node_modules, build output): a gate that needs them installs them first, say `bun install && bun test`";

// What `start` takes, and `--as` and `--scope`, which every command takes. A misspelt flag
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
	"lens",
	"verifier",
	"as",
	"scope",
]);

const start: Verb = async (args, deps, target) => {
	const unknown = Object.keys(args.flags).filter((f) => !START_FLAGS.has(f));
	if (unknown.length > 0)
		return usage(
			`Unknown loop start flag${unknown.length === 1 ? "" : "s"}: ${unknown.map((f) => `--${f}`).join(", ")}`,
			USAGE,
		);
	for (const flag of ["implementer", "verifier"]) {
		const harness = flagString(args, flag);
		if (harness && !Harnesses.isId(harness))
			return usage(
				`--${flag} must be one of ${Harnesses.IDS.join(", ")}`,
				USAGE,
			);
	}
	// A switch followed by a stray word takes it as a value and would read as not given.
	for (const flag of ["worktree", "no-worktree"])
		if (flag in args.flags && !flagBool(args, flag))
			return usage(
				`--${flag} takes no value, not ${JSON.stringify(args.flags[flag])}`,
				USAGE,
			);
	if (flagBool(args, "worktree") && flagBool(args, "no-worktree"))
		return usage("Give one of --worktree and --no-worktree", USAGE);
	const config = configFrom(args);
	if (!config.ok) return usage(config.error.message, USAGE);
	const dir = flagString(args, "dir");
	const started = await Loop.start(deps, {
		parent: target,
		...(dir ? { dir } : {}),
		config: config.value,
	});
	if (!started.ok) return ran(started);
	const placed = Loop.placement(started.value);
	const isNew =
		started.value.worktree !== undefined && !started.value.worktreeReused;
	return success(
		started.value,
		[
			line(started.value),
			...(placed ? [`  ${placed}`] : []),
			...(isNew ? [WORKTREE_NOTE] : []),
		].join("\n"),
	);
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

export const loop: Extension = {
	name: LoopConfig.NAMESPACE,
	settings: LoopConfig.SettingsSchema,
	commands: [command],
	// Each run on this device is a card with a tab of its own on the board, headed by the run's state.
	// `a` on an issue, alone or with subtasks, starts one from the board's directory, as `loop start` would.
	board: (ctx) => ({
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
	}),
};
