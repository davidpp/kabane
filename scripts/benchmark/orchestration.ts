import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import { err, ok, trySync, type Result } from "../../packages/core/result";
import { prepareAuth } from "./auth";
import { doctor } from "./doctor";
import {
	configFiles,
	environment,
	home,
	loadManifest,
	verifyFrozen,
	workspace,
} from "./experiment";
import {
	canonical,
	copyTree,
	digestTree,
	hash,
	read,
	readJson,
	write,
	writeJson,
} from "./files";
import { mergeWorkers, roles, type Role } from "./orchestration-policy";
import { command, runProcess, type ProcessResult } from "./process";
import { launchArguments } from "./run";
import { attemptSchema, type Arm, type Manifest } from "./schema";
import {
	inventoryProblems,
	normalizedInventory,
	summarizeTrace,
	type Trace,
} from "./usage";

const roleRoot = (root: string, role: Role): string =>
	join(root, "roles", role);
const roleDirectory = (root: string, arm: Arm, role: Role): string =>
	join(root, arm, "roles", role);
const statePath = (root: string): string =>
	join(home(root, "kabane"), ".kabane");
const notesPath = (root: string, arm: Arm): string => join(root, arm, "notes");
const roleRecord = attemptSchema.extend({
	role: z.enum(roles),
	turns: z.number().nullable(),
	resultSubtype: z.string().nullable(),
	deviations: z.array(z.string()),
	quotaExhausted: z.boolean(),
});
type RoleRecord = z.infer<typeof roleRecord>;
const records = (root: string): Result<RoleRecord[]> => {
	const found: RoleRecord[] = [];
	for (const arm of ["baseline", "kabane"] as const)
		for (const role of roles) {
			const path = join(roleDirectory(root, arm, role), "attempt.json");
			if (!existsSync(path)) continue;
			const value = readJson(path, roleRecord);
			if (!value.ok) return value;
			found.push(value.value);
		}
	return ok(found);
};
const prepareRole = async (
	root: string,
	manifest: Manifest,
	arm: Arm,
	role: Role,
): Promise<Result<void>> => {
	const nested = roleRoot(root, role);
	const target = workspace(nested, arm);
	if (existsSync(target))
		return err(
			new Error(
				`Role workspace already exists: ${target}; inspect it, do not retry.`,
			),
		);
	const source =
		role === "plan"
			? workspace(root, arm)
			: workspace(roleRoot(root, "plan"), arm);
	const copied =
		role === "integrate"
			? mergeWorkers(
					source,
					[
						workspace(roleRoot(root, "domain"), arm),
						workspace(roleRoot(root, "ui"), arm),
					],
					target,
				)
			: copyTree(source, target);
	if (!copied.ok) return copied;
	const paths = trySync(() => {
		mkdirSync(notesPath(root, arm), { recursive: true, mode: 0o700 });
		mkdirSync(join(target, ".runtime"), { recursive: true, mode: 0o700 });
	});
	if (!paths.ok) return paths;
	for (const [name, value] of Object.entries(
		configFiles(nested, manifest, arm, statePath(root), `claude-${role}`),
	)) {
		const saved = write(join(nested, arm, name), value);
		if (!saved.ok) return saved;
	}
	const git = await command(
		["git", "init", "-q"],
		target,
		environment(nested, arm),
	);
	if (!git.ok) return git;
	const initial = digestTree(target);
	if (!initial.ok) return initial;
	return writeJson(join(roleDirectory(root, arm, role), "prepared.json"), {
		manifestDigest: manifest.digest,
		workspaceDigest: initial.value,
		configurationDigest: hash(
			canonical(
				configFiles(nested, manifest, arm, statePath(root), `claude-${role}`),
			),
		),
	});
};
const preparedSchema = z.object({
	manifestDigest: z.string(),
	workspaceDigest: z.string(),
	configurationDigest: z.string(),
});
const verifyRole = (
	root: string,
	manifest: Manifest,
	arm: Arm,
	role: Role,
): Result<void> => {
	const nested = roleRoot(root, role);
	const receipt = readJson(
		join(roleDirectory(root, arm, role), "prepared.json"),
		preparedSchema,
	);
	if (!receipt.ok) return receipt;
	const current = digestTree(workspace(nested, arm));
	if (!current.ok) return current;
	const configs = configFiles(
		nested,
		manifest,
		arm,
		statePath(root),
		`claude-${role}`,
	);
	if (
		receipt.value.manifestDigest !== manifest.digest ||
		receipt.value.workspaceDigest !== current.value ||
		receipt.value.configurationDigest !== hash(canonical(configs))
	)
		return err(new Error(`${arm}/${role}: prepared inputs changed.`));
	for (const [name, expected] of Object.entries(configs)) {
		const actual = read(join(nested, arm, name));
		if (!actual.ok || actual.value !== expected)
			return err(new Error(`${arm}/${role}: configuration changed: ${name}`));
	}
	return ok(undefined);
};
const promptFor = (
	root: string,
	manifest: Manifest,
	arm: Arm,
	role: Role,
): string => {
	const round = roles.indexOf(role);
	const deliveries =
		role === "integrate"
			? `\nWorker source deliveries (read-only): ${workspace(roleRoot(root, "domain"), arm)} and ${workspace(roleRoot(root, "ui"), arm)}. Read .benchmark/transport.json for applied deltas and unresolved conflicts. No worker transcript is provided.`
			: "";
	return `${manifest.prompts[round]}\n\nYour role is ${role}. Your native turn allowance is ${manifest.recipe.orchestration?.turnCaps[round]}; leave durable notes before it expires. Shared live coordination directory (available equally to every role): ${notesPath(root, arm)}. Discover prior records there${arm === "kabane" ? " and through the supplied Kabane MCP" : ""}. Use role-specific note filenames to avoid concurrent overwrites. Other experiment directories and harness transcripts are out of bounds.${deliveries}\n`;
};
const executeRole = async (
	root: string,
	manifest: Manifest,
	arm: Arm,
	role: Role,
): Promise<Result<RoleRecord>> => {
	const verified = verifyRole(root, manifest, arm, role);
	if (!verified.ok) return verified;
	const directory = roleDirectory(root, arm, role);
	const path = join(directory, "attempt.json");
	if (existsSync(path))
		return err(
			new Error(
				`${arm}/${role} already attempted; no retries in this protocol.`,
			),
		);
	const nested = roleRoot(root, role);
	const cwd = workspace(nested, arm);
	const round = roles.indexOf(role) + 1;
	const cap = manifest.recipe.orchestration?.turnCaps[round - 1];
	if (cap === undefined) return err(new Error("Missing native turn cap"));
	const argv = [
		...launchArguments(nested, manifest, arm, round),
		"--max-turns",
		String(cap),
		"--no-session-persistence",
		"--add-dir",
		notesPath(root, arm),
	];
	if (role === "integrate")
		argv.push(
			"--add-dir",
			workspace(roleRoot(root, "domain"), arm),
			"--add-dir",
			workspace(roleRoot(root, "ui"), arm),
		);
	const prompt = promptFor(root, manifest, arm, role);
	const record: RoleRecord = {
		arm,
		round,
		attempt: 1,
		harness: "claude",
		model: manifest.recipe.models.claude,
		role,
		turns: null,
		resultSubtype: null,
		deviations: [],
		quotaExhausted: false,
		startedAt: new Date().toISOString(),
		endedAt: null,
		elapsedMs: null,
		status: "running",
		exitCode: null,
		usage: {
			input: null,
			cachedInput: null,
			cacheWrite: null,
			output: null,
			source: "not reported",
		},
		toolCalls: 0,
		kabaneCalls: 0,
		trace: relative(root, join(directory, "stdout.jsonl")),
		workspaceDigest: null,
	};
	for (const value of [
		writeJson(path, record),
		writeJson(join(directory, "launch.json"), {
			argv,
			cwd,
			manifestDigest: manifest.digest,
		}),
		write(join(directory, "prompt.md"), prompt),
	])
		if (!value.ok) return value;
	const executed = await launchRole(root, manifest, record, argv, prompt);
	if (!executed.ok) {
		record.status = "failed";
		record.endedAt = new Date().toISOString();
		record.deviations.push(executed.error.message);
		writeJson(path, record);
		return executed;
	}
	return finishRole(root, record, executed.value);
};
const launchRole = async (
	root: string,
	manifest: Manifest,
	record: RoleRecord,
	argv: string[],
	prompt: string,
): Promise<Result<ProcessResult>> => {
	const { arm, role } = record;
	const nested = roleRoot(root, role);
	const cwd = workspace(nested, arm);
	const directory = roleDirectory(root, arm, role);
	const env = environment(nested, arm);
	env.TMPDIR = join(cwd, ".runtime");
	env.KABANE_HOME =
		arm === "kabane" ? statePath(root) : join(home(nested, arm), ".kabane");
	env.AGENT_BROWSER_SESSION = `o-${manifest.digest.slice(0, 4)}-${arm[0]}-${roles.indexOf(role)}`;
	env.AGENT_BROWSER_EXECUTABLE_PATH = manifest.recipe.browser?.executable;
	const browser = manifest.recipe.browser;
	if (browser) {
		const opened = await command(
			[browser.command, "open", "about:blank"],
			cwd,
			env,
		);
		if (!opened.ok) return opened;
	}
	const auth = await prepareAuth("claude", home(nested, arm), env);
	if (!auth.ok) {
		if (browser) await command([browser.command, "close"], cwd, env);
		return auth;
	}
	console.log(`${arm}/${role}: Claude`);
	let executed;
	try {
		executed = await runProcess({
			argv,
			cwd,
			env,
			seconds: manifest.recipe.maxSeconds,
			stdin: prompt,
			stdout: join(directory, "stdout.jsonl"),
			stderr: join(directory, "stderr.log"),
		});
	} finally {
		auth.value();
		if (browser) await command([browser.command, "close"], cwd, env);
	}
	return executed;
};
const roleStatus = (
	executed: ProcessResult,
	trace: Trace,
	deviations: string[],
): RoleRecord["status"] => {
	if (executed.interrupted) return "interrupted";
	if (executed.timedOut) return "timed_out";
	return executed.code === 0 &&
		trace.completed &&
		!trace.failed &&
		deviations.length === 0
		? "completed"
		: "failed";
};
const finishRole = (
	root: string,
	record: RoleRecord,
	executed: ProcessResult,
): Result<RoleRecord> => {
	const { arm, role } = record;
	const cwd = workspace(roleRoot(root, role), arm);
	const directory = roleDirectory(root, arm, role);
	const path = join(directory, "attempt.json");
	const raw = read(join(directory, "stdout.jsonl"));
	if (!raw.ok) return raw;
	const trace = summarizeTrace(raw.value, "claude");
	record.endedAt = new Date().toISOString();
	record.elapsedMs = Date.now() - Date.parse(record.startedAt);
	record.exitCode = executed.code;
	record.usage = trace.usage;
	record.turns = trace.turns;
	record.resultSubtype = trace.resultSubtype;
	record.toolCalls = trace.toolCalls;
	record.kabaneCalls = trace.kabaneCalls;
	record.deviations = inventoryProblems(trace, record.model, arm === "kabane");
	if (
		arm === "kabane" &&
		!trace.successfulKabaneTools.includes("kabane_handoff")
	)
		record.deviations.push("No successful Kabane handoff observed");
	record.quotaExhausted = trace.quotaExhausted;
	const parity = inventoryParity(root, arm, role, trace);
	if (!parity.ok) record.deviations.push(parity.error.message);
	record.status = roleStatus(executed, trace, record.deviations);
	const digest = digestTree(cwd);
	if (!digest.ok) return digest;
	record.workspaceDigest = digest.value;
	const saved = writeJson(path, record);
	if (!saved.ok) return saved;
	const observed = writeJson(join(directory, "observed.json"), {
		inventory: trace.inventory,
		normalizedInventory:
			trace.inventory && normalizedInventory(trace.inventory),
		successfulKabaneTools: trace.successfulKabaneTools,
	});
	if (!observed.ok) return observed;
	const snapshot = copyTree(cwd, join(directory, "workspace"));
	if (!snapshot.ok) return snapshot;
	const notes = copyTree(notesPath(root, arm), join(directory, "notes"));
	if (!notes.ok) return notes;
	if (arm === "kabane" && role !== "domain" && role !== "ui") {
		const state = copyTree(statePath(root), join(directory, "kabane-state"));
		if (!state.ok) return state;
	}
	return ok(record);
};
const inventoryParity = (
	root: string,
	arm: Arm,
	role: Role,
	trace: Trace,
): Result<void> => {
	if (arm === "baseline") return ok(undefined);
	const previous = readJson(
		join(roleDirectory(root, "baseline", role), "observed.json"),
		z.object({ normalizedInventory: z.string().nullable() }),
	);
	if (!previous.ok) return previous;
	return trace.inventory &&
		previous.value.normalizedInventory === normalizedInventory(trace.inventory)
		? ok(undefined)
		: err(new Error("Same-role native inventories differ between arms"));
};
const verifyPriorWorkspaces = (
	root: string,
	previous: RoleRecord[],
): Result<void> => {
	for (const record of previous) {
		if (!record.workspaceDigest)
			return err(
				new Error(
					`${record.arm}/${record.role}: missing final snapshot digest`,
				),
			);
		for (const directory of [
			workspace(roleRoot(root, record.role), record.arm),
			join(roleDirectory(root, record.arm, record.role), "workspace"),
		]) {
			const digest = digestTree(directory);
			if (!digest.ok || digest.value !== record.workspaceDigest)
				return err(
					new Error(
						`${record.arm}/${record.role}: completed workspace or evidence changed`,
					),
				);
		}
	}
	return ok(undefined);
};
const validateProtocol = (manifest: Manifest): Result<void> =>
	manifest.recipe.orchestration &&
	manifest.recipe.rounds.length === 4 &&
	manifest.recipe.rounds.every((stage) => stage.harness === "claude") &&
	manifest.recipe.maxAttempts === 1 &&
	manifest.recipe.billingControlsVerified &&
	manifest.evaluator === null
		? ok(undefined)
		: err(
				new Error(
					"Orchestration requires four Claude stages, frozen turnCaps, maxAttempts=1, billing verification, and manual semantic evaluation.",
				),
			);

export const orchestrationReport = (root: string): Result<string> => {
	const found = records(root);
	if (!found.ok) return found;
	const lines = [
		"# Orchestration pilot",
		"",
		"Tokens and native Claude result.num_turns are primary, conditional on real acceptance checks. Unknown usage is not zero. Elapsed time is diagnostic. No hard aggregate token cap is claimed.",
		"",
		"| Arm | Role | Status | Turns | Input | Cache read | Cache write | Output | Tools | Kabane |",
		"| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
	];
	for (const r of found.value)
		lines.push(
			`| ${r.arm} | ${r.role} | ${r.status} | ${r.turns ?? "unknown"} | ${r.usage.input ?? "unknown"} | ${r.usage.cachedInput ?? "unknown"} | ${r.usage.cacheWrite ?? "unknown"} | ${r.usage.output ?? "unknown"} | ${r.toolCalls} | ${r.kabaneCalls} |`,
		);
	const totals = (["baseline", "kabane"] as const).map((arm) => {
		const group = found.value.filter((r) => r.arm === arm);
		const sum = (values: (number | null)[]): number | null =>
			group.length === 4 && values.every((value) => value !== null)
				? values.reduce<number>((a, b) => a + (b ?? 0), 0)
				: null;
		return {
			arm,
			attemptedRoles: group.length,
			turns: sum(group.map((r) => r.turns)),
			input: sum(group.map((r) => r.usage.input)),
			cachedInput: sum(group.map((r) => r.usage.cachedInput)),
			cacheWrite: sum(group.map((r) => r.usage.cacheWrite)),
			output: sum(group.map((r) => r.usage.output)),
		};
	});
	lines.push(
		"",
		"## All-role totals",
		"",
		"| Arm | Attempted roles | Turns | Input | Cache read | Cache write | Output |",
		"| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
	);
	for (const t of totals)
		lines.push(
			`| ${t.arm} | ${t.attemptedRoles}/4 | ${t.turns ?? "unknown"} | ${t.input ?? "unknown"} | ${t.cachedInput ?? "unknown"} | ${t.cacheWrite ?? "unknown"} | ${t.output ?? "unknown"} |`,
		);
	const markdown = lines.join("\n") + "\n";
	const saved = writeJson(join(root, "orchestration-report.json"), {
		attempts: found.value,
		totals,
	});
	if (!saved.ok) return saved;
	const written = write(join(root, "orchestration-report.md"), markdown);
	return written.ok ? ok(markdown) : written;
};
const advanceArm = async (
	root: string,
	manifest: Manifest,
	arm: Arm,
): Promise<Result<string>> => {
	const found = records(root);
	if (!found.ok) return found;
	if (
		found.value.some(
			(r) =>
				r.quotaExhausted ||
				r.status === "running" ||
				r.status === "interrupted" ||
				r.status === "timed_out",
		)
	)
		return err(
			new Error(
				"Stopped: quota/interruption/timeout/incomplete process record. Evidence retained; no automatic retry.",
			),
		);
	const protectedWork = verifyPriorWorkspaces(root, found.value);
	if (!protectedWork.ok) return protectedWork;
	if (
		found.value.some(
			(r) =>
				(r.status === "failed" && r.resultSubtype !== "error_max_turns") ||
				r.deviations.some((d) => d !== "No successful Kabane handoff observed"),
		)
	)
		return err(
			new Error(
				"Stopped after non-cap failure; inspect evidence without resetting the allowance.",
			),
		);
	const prior = found.value.filter((r) => r.arm === arm);
	const pending = roles.find((role) => !prior.some((r) => r.role === role));
	if (!pending) return ok(`${arm} finished all four invocations.`);
	const next: Role[] = pending === "domain" ? ["domain", "ui"] : [pending];
	for (const role of next) {
		if (!existsSync(join(roleDirectory(root, arm, role), "prepared.json"))) {
			const prepared = await prepareRole(root, manifest, arm, role);
			if (!prepared.ok) return prepared;
		}
	}
	const result = await Promise.all(
		next.map((role) => executeRole(root, manifest, arm, role)),
	);
	for (const item of result) if (!item.ok) return item;
	const unchanged = verifyPriorWorkspaces(root, found.value);
	if (!unchanged.ok) return unchanged;
	if (pending === "domain") {
		const prepared = await prepareRole(root, manifest, arm, "integrate");
		if (!prepared.ok) return prepared;
		const snapshot = copyTree(
			workspace(roleRoot(root, "integrate"), arm),
			join(root, arm, "first-integration"),
		);
		if (!snapshot.ok) return snapshot;
		const state =
			arm === "kabane"
				? copyTree(statePath(root), join(root, arm, "workers-kabane-state"))
				: ok(undefined);
		if (!state.ok) return state;
	}
	return ok(
		`${arm}: finished ${next.join(" + ")}. Next invocation is explicit; inspect saved checkpoints.`,
	);
};
export const runOrchestration = async (
	root: string,
	arm: Arm,
): Promise<Result<string>> => {
	const manifest = loadManifest(root);
	if (!manifest.ok) return manifest;
	const valid = validateProtocol(manifest.value);
	if (!valid.ok) return valid;
	const lock = join(root, "orchestration.lock");
	const acquired = trySync(() =>
		writeFileSync(lock, JSON.stringify({ pid: process.pid }), {
			flag: "wx",
			mode: 0o600,
		}),
	);
	if (!acquired.ok)
		return err(
			new Error(
				"Orchestration already locked; inspect the recorded PID, never retry an active run.",
			),
		);
	try {
		const checked = await verifyFrozen(root, manifest.value);
		if (!checked.ok) return checked;
		const initial = records(root);
		if (!initial.ok) return initial;
		if (
			arm === "kabane" &&
			roles.some(
				(role) =>
					!initial.value.some((r) => r.arm === "baseline" && r.role === role),
			)
		)
			return err(new Error("Run all baseline phases before treatment."));
		if (!initial.value.length) {
			const health = await doctor(root, true);
			if (!health.ok) return health;
		}
		const result = await advanceArm(root, manifest.value, arm);
		const summary = orchestrationReport(root);
		return result.ok && !summary.ok ? summary : result;
	} finally {
		rmSync(lock, { force: true });
	}
};
