import {
	existsSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { err, ok, trySync, type Result } from "../../packages/core/result";
import { prepareAuth } from "./auth";
import { doctor } from "./doctor";
import { evaluateAttempt } from "./evaluate";
import {
	environment,
	home,
	loadManifest,
	verifyFrozen,
	workspace,
} from "./experiment";
import {
	copyTree,
	digestTree,
	read,
	readJson,
	write,
	writeJson,
} from "./files";
import { command, runProcess, type ProcessResult } from "./process";
import { attemptSchema, type Arm, type Attempt, type Manifest } from "./schema";
import {
	emptyUsage,
	summarizeTrace,
	inventoryProblems,
	normalizedInventory,
} from "./usage";

export const attempts = (root: string): Result<Attempt[]> => {
	const values: Attempt[] = [];
	for (const arm of ["baseline", "kabane"] as const) {
		const directory = join(root, arm, "attempts");
		if (!existsSync(directory)) continue;
		const names = trySync(() => readdirSync(directory));
		if (!names.ok) return names;
		for (const name of names.value.sort()) {
			const path = join(directory, name, "attempt.json");
			if (!existsSync(path)) continue;
			const record = readJson(path, attemptSchema);
			if (!record.ok) return record;
			values.push(record.value);
		}
	}
	return ok(values);
};
export const attemptDirectory = (
	root: string,
	arm: Arm,
	round: number,
	attempt: number,
): string => join(root, arm, "attempts", `round-${round}-attempt-${attempt}`);
const launchArguments = (
	root: string,
	manifest: Manifest,
	arm: Arm,
	round: number,
): string[] => {
	const harness = manifest.recipe.rounds[round - 1]?.harness;
	if (harness === "codex")
		return [
			"codex",
			"exec",
			"--json",
			"--ephemeral",
			"--add-dir",
			home(root, arm),
			"--ignore-rules",
			"--model",
			manifest.recipe.models.codex,
			"-c",
			`model_reasoning_effort=${JSON.stringify(manifest.recipe.effort)}`,
			"-",
		];
	return [
		"claude",
		"-p",
		"--model",
		manifest.recipe.models.claude,
		"--effort",
		manifest.recipe.effort,
		"--setting-sources",
		"",
		"--settings",
		join(home(root, arm), ".claude/settings.json"),
		"--strict-mcp-config",
		"--mcp-config",
		join(root, arm, "mcp.json"),
		"--disable-slash-commands",
		"--output-format",
		"stream-json",
		"--verbose",
		"--permission-mode",
		"acceptEdits",
		"--allowedTools",
		arm === "kabane"
			? "Bash,Read,Write,Edit,Glob,Grep,mcp__kabane__*"
			: "Bash,Read,Write,Edit,Glob,Grep",
		"--tools",
		"Bash,Read,Write,Edit,Glob,Grep",
	];
};
const compareInventory = (
	root: string,
	record: Attempt,
	trace: ReturnType<typeof summarizeTrace>,
): Result<void> => {
	if (!trace.inventory) return ok(undefined);
	const previous = attempts(root);
	if (!previous.ok) return previous;
	for (const other of previous.value) {
		if (other.harness !== record.harness || other.arm === record.arm) continue;
		if (!existsSync(join(root, other.trace))) continue;
		const source = read(join(root, other.trace));
		if (!source.ok) return source;
		const inventory = summarizeTrace(source.value, other.harness).inventory;
		if (
			inventory &&
			normalizedInventory(inventory) !== normalizedInventory(trace.inventory)
		)
			return err(
				new Error(
					"Effective native tool/plugin inventory differs across conditions",
				),
			);
	}
	return ok(undefined);
};
const snapshot = (
	root: string,
	record: Attempt,
	directory: string,
): Result<void> => {
	const saved = copyTree(
		workspace(root, record.arm),
		join(directory, "workspace"),
	);
	if (!saved.ok) return saved;
	if (record.arm === "kabane")
		return copyTree(
			join(home(root, record.arm), ".kabane"),
			join(directory, "kabane-state"),
		);
	return ok(undefined);
};
const executeAttempt = async (
	root: string,
	manifest: Manifest,
	arm: Arm,
	round: number,
	attempt: number,
): Promise<Result<Attempt>> => {
	const stage = manifest.recipe.rounds[round - 1];
	if (!stage) return err(new Error(`No round ${round}`));
	const directory = attemptDirectory(root, arm, round, attempt);
	const made = trySync(() =>
		mkdirSync(directory, { recursive: true, mode: 0o700 }),
	);
	if (!made.ok) return made;
	const record: Attempt = {
		arm,
		round,
		attempt,
		harness: stage.harness,
		model: manifest.recipe.models[stage.harness],
		startedAt: new Date().toISOString(),
		endedAt: null,
		elapsedMs: null,
		status: "running",
		exitCode: null,
		usage: emptyUsage(),
		toolCalls: 0,
		kabaneCalls: 0,
		trace: relative(root, join(directory, "stdout.jsonl")),
		workspaceDigest: null,
	};
	const argv = launchArguments(root, manifest, arm, round);
	const prompt = `${manifest.prompts[round - 1]}\n\n${attempt > 1 ? "This is an explicitly requested retry after an incomplete prior attempt. Inspect the current workspace and preserve valid work.\n" : ""}`;
	for (const result of [
		writeJson(join(directory, "attempt.json"), record),
		writeJson(join(directory, "launch.json"), {
			argv,
			cwd: workspace(root, arm),
			manifestDigest: manifest.digest,
		}),
		write(join(directory, "prompt.md"), prompt),
	])
		if (!result.ok) return result;
	const result = await executeRecorded({
		root,
		manifest,
		record,
		directory,
		argv,
		prompt,
	});
	if (result.ok) return result;
	record.status = "failed";
	record.endedAt = new Date().toISOString();
	record.elapsedMs = Date.now() - Date.parse(record.startedAt);
	const digest = digestTree(workspace(root, arm));
	record.workspaceDigest = digest.ok ? digest.value : null;
	const saved = writeJson(join(directory, "attempt.json"), record);
	if (!saved.ok) return saved;
	const failure = writeJson(join(directory, "failure.json"), {
		kind: "infrastructure",
		message: result.error.message,
	});
	return failure.ok ? result : failure;
};
type Launch = {
	root: string;
	manifest: Manifest;
	record: Attempt;
	directory: string;
	argv: string[];
	prompt: string;
};
const statusOf = (result: ProcessResult, valid: boolean): Attempt["status"] => {
	if (result.interrupted) return "interrupted";
	if (result.timedOut) return "timed_out";
	return result.code === 0 && valid ? "completed" : "failed";
};
const executeRecorded = async (launch: Launch): Promise<Result<Attempt>> => {
	const { root, manifest, record, directory, argv, prompt } = launch;
	const { arm, round, attempt, harness } = record;
	const env = environment(root, arm);
	if (manifest.recipe.browser) {
		env.AGENT_BROWSER_EXECUTABLE_PATH = manifest.recipe.browser.executable;
		env.AGENT_BROWSER_SESSION = `bench-${manifest.digest.slice(0, 12)}-${arm}-${round}-${attempt}`;
	}
	const browser = manifest.recipe.browser;
	if (browser) {
		const opened = await command(
			[browser.command, "open", "about:blank"],
			workspace(root, arm),
			env,
		);
		if (!opened.ok) return opened;
		const receipt = writeJson(join(directory, "browser.json"), {
			session: env.AGENT_BROWSER_SESSION,
			executable: browser.executable ?? "bundled",
			started: true,
			startupOutput: opened.value,
		});
		if (!receipt.ok) {
			await command([browser.command, "close"], workspace(root, arm), env);
			return receipt;
		}
	}
	// Start the browser companion before adding credentials: its daemon never inherits them.
	const auth = await prepareAuth(harness, home(root, arm), env);
	if (!auth.ok) {
		if (browser)
			await command([browser.command, "close"], workspace(root, arm), env);
		return auth;
	}
	console.log(
		`${arm} round ${round} attempt ${attempt}: ${harness} (${record.model})`,
	);
	let executed;
	let browserClosed: Result<string> = ok("");
	try {
		executed = await runProcess({
			argv,
			cwd: workspace(root, arm),
			env,
			seconds: manifest.recipe.maxSeconds,
			stdin: prompt,
			stdout: join(directory, "stdout.jsonl"),
			stderr: join(directory, "stderr.log"),
		});
	} finally {
		auth.value();
		if (browser)
			browserClosed = await command(
				[browser.command, "close"],
				workspace(root, arm),
				env,
			);
	}
	if (!executed.ok) return executed;
	const finished = await finishAttempt(launch, executed.value);
	return browserClosed.ok ? finished : browserClosed;
};
const finishAttempt = async (
	launch: Launch,
	executed: ProcessResult,
): Promise<Result<Attempt>> => {
	const { root, manifest, record, directory } = launch;
	const raw = read(join(directory, "stdout.jsonl"));
	if (!raw.ok) return raw;
	const trace = summarizeTrace(raw.value, record.harness);
	const deviations =
		record.harness === "claude"
			? inventoryProblems(trace, record.model, record.arm === "kabane")
			: [];
	const inventoryCheck = compareInventory(root, record, trace);
	if (!inventoryCheck.ok) deviations.push(inventoryCheck.error.message);
	if (
		record.arm === "kabane" &&
		!trace.successfulKabaneTools.includes("kabane_handoff")
	)
		deviations.push("Treatment did not complete a successful Kabane handoff");
	record.endedAt = new Date().toISOString();
	record.elapsedMs = Date.now() - Date.parse(record.startedAt);
	record.exitCode = executed.code;
	record.status = statusOf(
		executed,
		trace.completed && !trace.failed && deviations.length === 0,
	);
	record.usage = trace.usage;
	record.toolCalls = trace.toolCalls;
	record.kabaneCalls = trace.kabaneCalls;
	const digest = digestTree(workspace(root, record.arm));
	if (!digest.ok) return digest;
	record.workspaceDigest = digest.value;
	const evidence = writeJson(join(directory, "observed.json"), {
		model: trace.model,
		inventory: trace.inventory,
		kabaneCalls: trace.kabaneCalls,
		successfulKabaneTools: trace.successfulKabaneTools,
		deviations,
	});
	if (!evidence.ok) return evidence;
	const saved = writeJson(join(directory, "attempt.json"), record);
	if (!saved.ok) return saved;
	const copied = snapshot(root, record, directory);
	if (!copied.ok) return copied;
	const evaluation = await evaluateAttempt(root, manifest, record, directory);
	if (!evaluation.ok) return evaluation;
	return ok(record);
};

const lock = (root: string, retry: boolean): Result<() => void> => {
	const path = join(root, "run.lock");
	if (existsSync(path) && retry) {
		const previous = readJson(path, z.object({ pid: z.number().int() }));
		if (!previous.ok) return previous;
		const alive = trySync(() => process.kill(previous.value.pid, 0));
		if (alive.ok)
			return err(new Error(`Runner ${previous.value.pid} is still alive.`));
		const removed = trySync(() => rmSync(path));
		if (!removed.ok) return removed;
	}
	const created = trySync(() =>
		writeFileSync(path, JSON.stringify({ pid: process.pid }), {
			flag: "wx",
			mode: 0o600,
		}),
	);
	return created.ok
		? ok(() => rmSync(path, { force: true }))
		: err(
				new Error(
					"Experiment already locked. If its runner died, use retry; never run both arms concurrently.",
				),
			);
};
export const runExperiment = async (
	root: string,
	retry: boolean,
	single: boolean,
): Promise<Result<void>> => {
	const loaded = loadManifest(root);
	if (!loaded.ok) return loaded;
	const manifest = loaded.value;
	if (!manifest.recipe.billingControlsVerified)
		return err(
			new Error(
				"Model runs blocked: verify automatic paid usage/credit purchase controls in both accounts, set billingControlsVerified=true in the recipe only after checking, and freeze a new experiment.",
			),
		);
	const acquired = lock(root, retry);
	if (!acquired.ok) return acquired;
	try {
		const checked = await doctor(root, true);
		if (!checked.ok) return checked;
		return await runStages(root, manifest, retry, single);
	} finally {
		acquired.value();
	}
};
const runStages = async (
	root: string,
	manifest: Manifest,
	retry: boolean,
	single: boolean,
): Promise<Result<void>> => {
	const records = attempts(root);
	if (!records.ok) return records;
	for (let round = 1; round <= manifest.recipe.rounds.length; round++)
		for (const arm of manifest.order) {
			const previous = records.value
				.filter((record) => record.arm === arm && record.round === round)
				.sort((a, b) => a.attempt - b.attempt);
			const latest = previous.at(-1);
			if (latest?.status === "completed") continue;
			if (latest && !retry)
				return err(
					new Error(
						`${arm} round ${round} has a ${latest.status} attempt. Inspect evidence; use retry explicitly to continue with a new attempt.`,
					),
				);
			const next = (latest?.attempt ?? 0) + 1;
			if (next > manifest.recipe.maxAttempts)
				return err(
					new Error(
						`${arm} round ${round} exhausted its frozen ${manifest.recipe.maxAttempts}-attempt allowance.`,
					),
				);
			const verified = await verifyFrozen(root, manifest);
			if (!verified.ok) return verified;
			const result = await executeAttempt(root, manifest, arm, round, next);
			if (!result.ok) return result;
			if (result.value.status !== "completed")
				return err(
					new Error(
						`${arm} round ${round}: ${result.value.status}. Evidence retained at ${result.value.trace}.`,
					),
				);
			if (single) return ok(undefined);
		}
	return ok(undefined);
};
