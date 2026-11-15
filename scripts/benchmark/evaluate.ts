import { rmSync } from "node:fs";
import { join } from "node:path";
import { err, ok, trySync, type Result } from "../../packages/core/result";
import { writeJson, read, digestTree, copyTree } from "./files";
import { cleanEnvironment, runProcess } from "./process";
import type { Attempt, Grade, Manifest } from "./schema";

export const evaluateAttempt = async (
	root: string,
	manifest: Manifest,
	record: Attempt,
	directory: string,
): Promise<Result<Grade | null>> => {
	if (manifest.evaluator === null) return ok(null);
	const script = read(join(root, "evaluator.ts"));
	if (!script.ok || script.value !== manifest.evaluator)
		return err(new Error("Frozen evaluator differs from manifest."));
	const snapshot = digestTree(join(directory, "workspace"));
	if (!snapshot.ok || snapshot.value !== record.workspaceDigest)
		return err(
			new Error(
				"Attempt snapshot differs from its recorded digest; evaluation refused.",
			),
		);
	const stamp = Date.now();
	const argv = [process.execPath, join(root, "evaluator.ts")];
	const working = join(directory, `.evaluation-${stamp}`);
	const copied = copyTree(join(directory, "workspace"), working);
	if (!copied.ok) return copied;
	let result;
	try {
		result = await runProcess({
			argv,
			cwd: working,
			env: {
				...cleanEnvironment(),
				BENCHMARK_WORKSPACE: working,
				BENCHMARK_ROUND: String(record.round),
				BENCHMARK_EVIDENCE: directory,
			},
			seconds: 120,
			stdout: join(directory, `evaluation-${stamp}.stdout.log`),
			stderr: join(directory, `evaluation-${stamp}.stderr.log`),
		});
	} finally {
		trySync(() => rmSync(working, { recursive: true, force: true }));
	}
	if (!result.ok) return result;
	const value: Grade = {
		arm: record.arm,
		round: record.round,
		attempt: record.attempt,
		verdict:
			result.value.code === 0 &&
			!result.value.timedOut &&
			!result.value.interrupted
				? "pass"
				: "fail",
		evidence: `Frozen evaluator.ts; exit ${result.value.code}. Logs ${directory}/evaluation-${stamp}.*.log`,
		at: new Date().toISOString(),
		source: "command",
	};
	const saved = writeJson(
		join(root, "grades", `${stamp}-${record.arm}-${record.round}.json`),
		value,
	);
	return saved.ok ? ok(value) : err(saved.error);
};
