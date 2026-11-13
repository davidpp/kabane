#!/usr/bin/env bun
import { resolve } from "node:path";
import { z } from "zod";
import { err, ok, type Result } from "../packages/core/result";
import { doctor } from "./benchmark/doctor";
import { freeze } from "./benchmark/experiment";
import { evaluate, grade, report } from "./benchmark/report";
import { runExperiment } from "./benchmark/run";
import { armSchema } from "./benchmark/schema";
import { initialize } from "./benchmark/templates";

const help = `Local subscription benchmark

  bun run benchmark init <recipe-dir> [--smoke]
  bun run benchmark freeze <recipe-dir> <experiment-dir>
  bun run benchmark doctor <experiment-dir> [--browser]
  bun run benchmark run <experiment-dir> [--next]
  bun run benchmark retry <experiment-dir> [--next]
  bun run benchmark evaluate <experiment-dir> <baseline|kabane> <round>
  bun run benchmark grade <experiment-dir> <baseline|kabane> <round> <pass|fail> <evidence>
  bun run benchmark report <experiment-dir>

Keep experiments outside repositories to avoid inherited instructions.
Each round starts a fresh harness session. Retry preserves failed attempts and starts a new session on the existing workspace.
`;
const main = async (args: string[]): Promise<Result<unknown>> => {
	const [command, directory, target, roundText, verdict, ...evidence] = args;
	if (!directory || !command || command === "help")
		return { ok: true, value: help };
	const root = resolve(directory);
	if (command === "init") return initialize(root, target === "--smoke");
	if (command === "freeze" && target) {
		const frozen = await freeze(root, resolve(target));
		return frozen.ok
			? ok({
					experiment: resolve(target),
					digest: frozen.value.digest,
					order: frozen.value.order,
				})
			: frozen;
	}
	if (command === "doctor") return doctor(root, false, target === "--browser");
	if (command === "run" || command === "retry") {
		const executed = await runExperiment(
			root,
			command === "retry",
			target === "--next",
		);
		const summary = report(root);
		if (!executed.ok) return executed;
		return summary.ok ? ok(`Report: ${root}/report.md`) : summary;
	}
	if (command === "report") return report(root);
	const arm = armSchema.safeParse(target);
	const round = z.coerce.number().int().min(1).safeParse(roundText);
	if (arm.success && round.success) {
		if (command === "evaluate") return evaluate(root, arm.data, round.data);
		if (command === "grade" && (verdict === "pass" || verdict === "fail"))
			return grade(root, arm.data, round.data, verdict, evidence.join(" "));
	}
	return err(new Error(help));
};
const result = await main(process.argv.slice(2));
if (!result.ok) {
	console.error(result.error.message);
	process.exitCode = 1;
} else if (result.value !== undefined)
	console.log(
		typeof result.value === "string"
			? result.value
			: JSON.stringify(result.value, null, 2),
	);
