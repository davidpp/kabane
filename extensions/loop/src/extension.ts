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
import type { LoopConfig } from "./config";
import { LoopDispatcher } from "./dispatcher";
import { LoopHeader } from "./header";
import { RunStore } from "./store";

const USAGE = `kabane loop start <parent> [--dir <path>] [--implementer claude|codex|gemini] [--model <name>] [--concurrency <n>] [--wall-minutes <n>] [--continuations <n>] [--spend <amount>] [--gate <name>=<command>]... [--worktree] [--lens <name>]... [--verifier claude|codex|gemini]
       kabane loop run <runId>
       kabane loop status [<runId>]
       kabane loop stop <runId>
       kabane loop pause|resume <runId>
       kabane loop skip|next <subtask>
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

// Flags become config overrides; LoopConfig validates them with the repo file.
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
			["wallMinutes", number(args, "wall-minutes")],
			["continuations", number(args, "continuations")],
			["spend", number(args, "spend")],
		].filter(([, value]) => value !== undefined),
	);
	return ok({
		...(implementer && Harnesses.isId(implementer) ? { implementer } : {}),
		...(model ? { model } : {}),
		budget,
		gates: gates.value,
		...(flagBool(args, "worktree") ? { worktree: true } : {}),
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

// A question waiting on a human, with what `kabane loop answer` takes for it.
const question = (q: Loop.Waiting): string =>
	[
		`  waiting on you: ${q.task} ${q.question}`,
		...q.choices.map((choice, i) => `    ${i + 1}. ${choice}`),
		`    kabane loop answer ${q.questionId} <option>`,
	].join("\n");

// Where a run with a worktree works, and the checkpoints `rollback` takes.
const worktree = (run: RunStore.Run): string[] =>
	run.worktree
		? [
				`  worktree: ${run.worktree}`,
				...RunStore.checkpoints(run).map((sha) => `    checkpoint ${sha}`),
			]
		: [];

/** One run, its worktree, and the questions its sessions are waiting on a human for. */
const statusOf = async (
	deps: Pick<Loop.Deps, "home" | "basePath">,
	runId: string,
): Promise<Outcome> => {
	const run = Loop.status(deps, runId);
	if (!run.ok) return failure(run.error);
	const waiting = await Loop.questions(deps, runId);
	if (!waiting.ok) return failure(waiting.error);
	return success(
		{ ...run.value, questions: waiting.value },
		[
			line(run.value),
			...worktree(run.value),
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

type Deps = Loop.Deps & { cwd: string; actor: string };
type Verb = (args: ParsedArgs, deps: Deps, target: string) => Promise<Outcome>;

const ran = (result: Result<RunStore.Run>): Outcome =>
	result.ok ? success(result.value, line(result.value)) : failure(result.error);

const start: Verb = async (args, deps, target) => {
	for (const flag of ["implementer", "verifier"]) {
		const harness = flagString(args, flag);
		if (harness && !Harnesses.isId(harness))
			return usage(
				`--${flag} must be one of ${Harnesses.IDS.join(", ")}`,
				USAGE,
			);
	}
	const config = configFrom(args);
	if (!config.ok) return usage(config.error.message, USAGE);
	const dir = flagString(args, "dir");
	return ran(
		await Loop.start(deps, {
			parent: target,
			...(dir ? { dir } : {}),
			config: config.value,
		}),
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
	start: { needs: "a parent issue", run: start },
	run: {
		needs: "a run id",
		run: async (_a, deps, id) => ran(await Loop.run(deps, id)),
	},
	stop: {
		needs: "a run id",
		run: async (_a, deps, id) => ran(await Loop.stop(deps, id)),
	},
	pause: { needs: "a run id", run: pause("pause") },
	resume: { needs: "a run id", run: pause("resume") },
	skip: { needs: "a subtask", run: direct("skip") },
	next: { needs: "a subtask", run: direct("next") },
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
		"Drive a parent issue's subtasks to completion through coding harnesses",
	usage: USAGE,
	run: async (args, ctx) => {
		const [verb, target] = args.positionals;
		const deps: Deps = {
			home: ctx.home,
			basePath: ctx.store,
			kabaneBin: kabaneBin(),
			cwd: ctx.cwd,
			actor: ctx.actor,
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
	name: "loop",
	commands: [command],
	// Each run on this device is a card with a tab of its own on the board, headed by the run's state.
	// `a` on an issue with subtasks starts one from the board's directory, as `loop start` would.
	board: (ctx) => ({
		activity: LoopActivity.source({
			home: ctx.home,
			basePath: ctx.store,
			actor: ctx.actor,
		}),
		dispatcher: LoopDispatcher.make({
			home: ctx.home,
			basePath: ctx.store,
			kabaneBin: kabaneBin(),
			cwd: ctx.cwd,
		}),
		headers: { [LoopActivity.KIND]: LoopHeader.make(ctx.home, ctx.store) },
	}),
};
