import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { err, ok, trySync, type Result } from "../../packages/core/result";
import { evaluateAttempt } from "./evaluate";
import { loadManifest } from "./experiment";
import { readJson, write, writeJson } from "./files";
import { attemptDirectory, attempts } from "./run";
import { gradeSchema, type Arm, type Attempt, type Grade } from "./schema";

const grades = (root: string): Result<Grade[]> => {
	const directory = join(root, "grades");
	if (!existsSync(directory)) return ok([]);
	const names = trySync(() => readdirSync(directory));
	if (!names.ok) return names;
	const values: Grade[] = [];
	for (const name of names.value.sort()) {
		const grade = readJson(join(directory, name), gradeSchema);
		if (!grade.ok) return grade;
		values.push(grade.value);
	}
	return ok(values);
};
export const grade = (
	root: string,
	arm: Arm,
	round: number,
	verdict: "pass" | "fail",
	evidence: string,
): Result<void> => {
	const records = attempts(root);
	if (!records.ok) return records;
	const record = records.value
		.filter((item) => item.arm === arm && item.round === round)
		.sort((a, b) => a.attempt - b.attempt)
		.at(-1);
	if (!record || record.status === "running")
		return err(new Error("No finished attempt to grade."));
	if (!evidence.trim())
		return err(
			new Error(
				"A grade requires concrete verification evidence or an artifact path.",
			),
		);
	const value: Grade = {
		arm,
		round,
		attempt: record.attempt,
		verdict,
		evidence,
		at: new Date().toISOString(),
		source: "human",
	};
	return writeJson(
		join(root, "grades", `${Date.now()}-${arm}-${round}.json`),
		value,
	);
};
export const evaluate = async (
	root: string,
	arm: Arm,
	round: number,
): Promise<Result<void>> => {
	const manifest = loadManifest(root);
	if (!manifest.ok) return manifest;
	if (!manifest.value.recipe.evaluator)
		return err(
			new Error(
				"No evaluator command frozen. Use grade with real browser evidence, or add an evaluator to a new recipe.",
			),
		);
	const records = attempts(root);
	if (!records.ok) return records;
	const record = records.value
		.filter((item) => item.arm === arm && item.round === round)
		.sort((a, b) => a.attempt - b.attempt)
		.at(-1);
	if (!record || record.status === "running")
		return err(new Error("No finished attempt to evaluate."));
	const result = await evaluateAttempt(
		root,
		manifest.value,
		record,
		attemptDirectory(root, arm, round, record.attempt),
	);
	return result.ok ? ok(undefined) : result;
};
const elapsed = (records: Attempt[]): string =>
	records.length === 0 || records.some((record) => record.elapsedMs === null)
		? "unknown/partial"
		: (
				records.reduce((sum, record) => sum + (record.elapsedMs ?? 0), 0) / 1000
			).toFixed(1);
const format = (value: number | null): string =>
	value === null ? "unreported" : String(value);
const total = (
	records: Attempt[],
	field: "input" | "cachedInput" | "cacheWrite" | "output",
): number | null =>
	records.length && records.every((record) => record.usage[field] !== null)
		? records.reduce((sum, record) => sum + (record.usage[field] ?? 0), 0)
		: null;
export const report = (root: string): Result<string> => {
	const manifest = loadManifest(root);
	if (!manifest.ok) return manifest;
	const records = attempts(root);
	if (!records.ok) return records;
	const judgments = grades(root);
	if (!judgments.ok) return judgments;
	const lines = [
		`# ${manifest.value.recipe.name}`,
		"",
		`Frozen ${manifest.value.createdAt}; digest ${manifest.value.digest}.`,
		"",
		"Process completion is not application success. Ungraded means unverified. All attempts count; provider token categories are not interchangeable and are not subscription dollars.",
		"",
		"| Arm | Round | Attempt | Harness | Process | Grade | Seconds | Input | Cache read | Cache write | Output | Tools | Kabane calls |",
		"| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const record of records.value.sort(
		(a, b) =>
			a.round - b.round || a.arm.localeCompare(b.arm) || a.attempt - b.attempt,
	)) {
		const judgment = judgments.value
			.filter(
				(entry) =>
					entry.arm === record.arm &&
					entry.round === record.round &&
					entry.attempt === record.attempt,
			)
			.at(-1);
		lines.push(
			`| ${record.arm} | ${record.round} | ${record.attempt} | ${record.harness} | ${record.status} | ${judgment?.verdict ?? "ungraded"} | ${record.elapsedMs === null ? "unknown" : (record.elapsedMs / 1000).toFixed(1)} | ${format(record.usage.input)} | ${format(record.usage.cachedInput)} | ${format(record.usage.cacheWrite)} | ${format(record.usage.output)} | ${record.toolCalls} | ${record.kabaneCalls} |`,
		);
	}
	lines.push(
		"",
		"## Totals by harness",
		"",
		"| Arm | Harness | Attempts | Active seconds | Input | Cache read | Cache write | Output |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
	);
	for (const arm of manifest.value.order)
		for (const harness of ["codex", "claude"] as const) {
			const group = records.value.filter(
				(record) => record.arm === arm && record.harness === harness,
			);
			lines.push(
				`| ${arm} | ${harness} | ${group.length} | ${elapsed(group)} | ${format(total(group, "input"))} | ${format(total(group, "cachedInput"))} | ${format(total(group, "cacheWrite"))} | ${format(total(group, "output"))} |`,
			);
		}
	lines.push("", "## Evaluation evidence", "");
	for (const entry of judgments.value)
		lines.push(
			`- ${entry.arm} round ${entry.round}, attempt ${entry.attempt}: **${entry.verdict}**, ${entry.source}, ${entry.at}. ${entry.evidence}`,
		);
	lines.push(
		"",
		"## Interpretation",
		"",
		"Compare paired outcomes at the same quality bar. Round 2 inherits round 1's implementation quality; it does not isolate handoff effects. One pair is a pilot, not proof. Review traces for rediscovery/rework; do not infer waste from token counts or deleted lines. Quota/reset waits between attempts are excluded from active seconds. Human intervention time must be recorded separately in notes; it is not inferred from wall time.",
		"",
		"## Frozen rubric",
		"",
		manifest.value.rubric,
	);
	const markdown = `${lines.join("\n")}\n`;
	const saved = write(join(root, "report.md"), markdown);
	if (!saved.ok) return saved;
	const json = writeJson(join(root, "report.json"), {
		manifestDigest: manifest.value.digest,
		attempts: records.value,
		grades: judgments.value,
	});
	if (!json.ok) return json;
	const csv = [
		"arm,round,attempt,harness,model,status,elapsed_ms,input,cache_read,cache_write,output,tool_calls,kabane_calls",
		...records.value.map((r) =>
			[
				r.arm,
				r.round,
				r.attempt,
				r.harness,
				r.model,
				r.status,
				r.elapsedMs,
				r.usage.input,
				r.usage.cachedInput,
				r.usage.cacheWrite,
				r.usage.output,
				r.toolCalls,
				r.kabaneCalls,
			]
				.map((cell) => JSON.stringify(cell ?? ""))
				.join(","),
		),
	].join("\n");
	const written = write(join(root, "results.csv"), `${csv}\n`);
	return written.ok ? ok(markdown) : written;
};
