import { randomInt } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { err, ok, trySync, type Result } from "../../packages/core/result";
import {
	copyTree,
	digestTree,
	tree,
	hash,
	canonical,
	isNewDirectory,
	read,
	readJson,
	write,
	writeJson,
} from "./files";
import { command, cleanEnvironment } from "./process";
import {
	manifestSchema,
	recipeSchema,
	attemptSchema,
	type Arm,
	type Manifest,
	type Recipe,
} from "./schema";

const sourceRoot = resolve(import.meta.dir, "../..");
export const workspace = (root: string, arm: Arm): string =>
	join(root, arm, "workspace");
export const home = (root: string, arm: Arm): string => join(root, arm, "home");
export const environment = (root: string, arm: Arm): NodeJS.ProcessEnv => ({
	...cleanEnvironment(),
	HOME: home(root, arm),
	CODEX_HOME: join(home(root, arm), ".codex"),
	CLAUDE_CONFIG_DIR: join(home(root, arm), ".claude"),
	XDG_CONFIG_HOME: join(home(root, arm), ".config"),
	XDG_CACHE_HOME: join(home(root, arm), ".cache"),
	KABANE_HOME: join(home(root, arm), ".kabane"),
	KABANE_HARNESSES: "",
	CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
	DISABLE_AUTOUPDATER: "1",
	DISABLE_NONESSENTIAL_TRAFFIC: "1",
});
const workflow = (arm: Arm): string =>
	arm === "baseline"
		? "Maintain work state and handoff in repository notes, such as HANDOFF.md. Read the prior handoff before continuing."
		: "Use the provided Kabane MCP tools for work state and handoff: read kabane_context for existing work, create an issue if needed, and record completed work, decisions, verification and gaps with kabane_handoff. Read prior records before continuing. Repository notes and native planning remain available. Use only this experiment's supplied local Kabane server.";
const instructions = (manifest: Manifest, arm: Arm): string =>
	`${manifest.common}\n\n${workflow(arm)}\n${manifest.recipe.browser ? `\nBrowser tool (same in both conditions): ${JSON.stringify(manifest.recipe.browser.command)}. Use from the shell: open <local-url>, snapshot -i, click @e1, fill @e2 <text>, screenshot <path>, close. Re-snapshot after navigation. The browser executable/session environment is configured. Use a real local app; save evidence inside the workspace. Stop app servers you start before ending.\n` : ""}`;
const configFiles = (
	root: string,
	manifest: Manifest,
	arm: Arm,
): Record<string, string> => {
	const cli = join(manifest.sourceRoot, "packages/cli/index.ts");
	const mcp = {
		command: process.execPath,
		args: [cli, "mcp", "--as", "cabane://actor/agent/claude"],
		cwd: workspace(root, arm),
		env: {
			KABANE_HOME: join(home(root, arm), ".kabane"),
			KABANE_HARNESSES: "",
		},
	};
	const toml = [
		'model_provider = "openai"',
		'forced_login_method = "chatgpt"',
		'approval_policy = "never"',
		'sandbox_mode = "workspace-write"',
		"[features]",
		"apps = false",
		"plugins = false",
		"hooks = false",
		"multi_agent = false",
		"multi_agent_v2 = false",
		"memories = false",
		"skill_search = false",
		"skill_mcp_dependency_install = false",
		"skip_host_skill_discovery = true",
		"shell_snapshot = false",
		"[sandbox_workspace_write]",
		"network_access = true",
		`[projects.${JSON.stringify(workspace(root, arm))}]`,
		'trust_level = "trusted"',
	];
	if (arm === "kabane")
		toml.push(
			"[mcp_servers.kabane]",
			`command = ${JSON.stringify(mcp.command)}`,
			`args = ${JSON.stringify([...mcp.args.slice(0, -1), "cabane://actor/agent/codex"])}`,
			`cwd = ${JSON.stringify(mcp.cwd)}`,
			"[mcp_servers.kabane.env]",
			`KABANE_HOME = ${JSON.stringify(mcp.env.KABANE_HOME)}`,
			'KABANE_HARNESSES = ""',
		);
	return {
		"home/.codex/config.toml": `${toml.join("\n")}\n`,
		"home/.claude/settings.json": `${JSON.stringify({ permissions: { defaultMode: "acceptEdits" }, enabledPlugins: {}, autoUpdatesChannel: "stable" }, null, 2)}\n`,
		"mcp.json": `${JSON.stringify({ mcpServers: arm === "kabane" ? { kabane: mcp } : {} }, null, 2)}\n`,
		"workspace/AGENTS.md": instructions(manifest, arm),
		"workspace/CLAUDE.md": instructions(manifest, arm),
	};
};
const manifestDigest = (manifest: Omit<Manifest, "digest">): string =>
	hash(canonical(manifest));
export const loadManifest = (root: string): Result<Manifest> => {
	const result = readJson(join(root, "manifest.json"), manifestSchema);
	if (!result.ok) return result;
	const { digest, ...body } = result.value;
	return manifestDigest(body) === digest
		? result
		: err(
				new Error("Frozen manifest changed; create a new experiment instead."),
			);
};
const versions = async (
	recipe: Recipe,
): Promise<Result<Manifest["versions"]>> => {
	const found: string[] = [];
	for (const argv of [
		["codex", "--version"],
		["claude", "--version"],
		["git", "rev-parse", "HEAD"],
	]) {
		const value = await command(argv, sourceRoot);
		if (!value.ok) return value;
		found.push(value.value);
	}
	const source: string[] = [];
	for (const folder of ["packages", "extensions", "scripts/benchmark"]) {
		const files = tree(join(sourceRoot, folder));
		if (!files.ok) return files;
		source.push(
			hash(
				canonical(
					Object.fromEntries(
						Object.entries(files.value).filter(
							([name]) =>
								!name.endsWith(".test.ts") && !name.endsWith(".test.tsx"),
						),
					),
				),
			),
		);
	}
	const dependencies = read(join(sourceRoot, "bun.lock"));
	if (!dependencies.ok) return dependencies;
	source.push(dependencies.value);
	const runner = read(join(sourceRoot, "scripts/benchmark.ts"));
	if (!runner.ok) return runner;
	source.push(runner.value);
	const browser = recipe.browser
		? await command([recipe.browser.command, "--version"], sourceRoot)
		: ok(null);
	if (!browser.ok) return browser;
	const browserExecutable = recipe.browser?.executable
		? await command([recipe.browser.executable, "--version"], sourceRoot)
		: ok(null);
	if (!browserExecutable.ok) return browserExecutable;
	return ok({
		kabaneSource: hash(source.join("\n")),
		browser:
			browser.value === null
				? null
				: `${browser.value}; ${browserExecutable.value ?? "bundled browser version not independently reported"}`,
		codex: found[0] ?? "",
		claude: found[1] ?? "",
		bun: Bun.version,
		kabane: found[2] ?? "",
	});
};
export const freeze = async (
	recipeDir: string,
	root: string,
): Promise<Result<Manifest>> => {
	const fresh = isNewDirectory(root);
	if (!fresh.ok) return fresh;
	const recipe = readJson(join(recipeDir, "recipe.json"), recipeSchema);
	if (!recipe.ok) return recipe;
	const content: string[] = [];
	for (const name of [
		recipe.value.common,
		recipe.value.rubric,
		...recipe.value.rounds.map((round) => round.prompt),
	]) {
		const result = read(join(recipeDir, name));
		if (!result.ok) return result;
		content.push(result.value);
	}
	const starterDigest = digestTree(join(recipeDir, recipe.value.starter));
	if (!starterDigest.ok) return starterDigest;
	const binaries = await versions(recipe.value);
	if (!binaries.ok) return binaries;
	const evaluator = recipe.value.evaluator
		? read(join(recipeDir, recipe.value.evaluator))
		: ok(null);
	if (!evaluator.ok) return evaluator;
	const body: Omit<Manifest, "digest"> = {
		version: 1,
		createdAt: new Date().toISOString(),
		recipe: recipe.value,
		common: content[0] ?? "",
		rubric: content[1] ?? "",
		prompts: content.slice(2),
		evaluator: evaluator.value,
		starterDigest: starterDigest.value,
		order: randomInt(2) ? ["baseline", "kabane"] : ["kabane", "baseline"],
		versions: binaries.value,
		sourceRoot,
	};
	const manifest: Manifest = { ...body, digest: manifestDigest(body) };
	const prepared = await prepareExperiment(root, recipeDir, manifest);
	return prepared.ok ? ok(manifest) : prepared;
};
const prepareExperiment = async (
	root: string,
	recipeDir: string,
	manifest: Manifest,
): Promise<Result<void>> => {
	const starter = copyTree(
		join(recipeDir, manifest.recipe.starter),
		join(root, "starter"),
	);
	if (!starter.ok) return starter;
	const saved = writeJson(join(root, "manifest.json"), manifest);
	if (!saved.ok) return saved;
	for (const arm of manifest.order) {
		const copied = copyTree(
			join(recipeDir, manifest.recipe.starter),
			workspace(root, arm),
		);
		if (!copied.ok) return copied;
		for (const [name, value] of Object.entries(
			configFiles(root, manifest, arm),
		)) {
			const result = write(join(root, arm, name), value);
			if (!result.ok) return result;
		}
		const made = trySync(() =>
			mkdirSync(join(root, arm, "attempts"), { recursive: true, mode: 0o700 }),
		);
		if (!made.ok) return made;
		const git = await command(
			["git", "init", "-q"],
			workspace(root, arm),
			environment(root, arm),
		);
		if (!git.ok) return git;
	}
	const env = environment(root, "kabane");
	const init = await command(
		[
			process.execPath,
			join(manifest.sourceRoot, "packages/cli/index.ts"),
			"init",
			"--scope",
			"benchmark",
			"--actor",
			"cabane://actor/benchmark-human",
		],
		workspace(root, "kabane"),
		env,
	);
	if (!init.ok) return init;
	if (manifest.evaluator !== null) {
		const evaluation = write(join(root, "evaluator.ts"), manifest.evaluator);
		if (!evaluation.ok) return evaluation;
	}
	return write(join(root, "rubric.md"), manifest.rubric);
};
const verifyWorkspace = (
	root: string,
	arm: Arm,
	manifest: Manifest,
): Result<void> => {
	const prior: { startedAt: string; workspaceDigest: string | null }[] = [];
	const names = trySync(() => readdirSync(join(root, arm, "attempts")));
	if (!names.ok) return names;
	for (const name of names.value) {
		const file = join(root, arm, "attempts", name, "attempt.json");
		if (!existsSync(file)) continue;
		const record = readJson(file, attemptSchema);
		if (!record.ok) return record;
		prior.push(record.value);
	}
	const last = prior
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
		.at(-1);
	if (last) {
		if (last.workspaceDigest === null) return ok(undefined); // Interrupted attempt: explicit retry owns recovery.
		const digest = digestTree(workspace(root, arm));
		return digest.ok && digest.value === last.workspaceDigest
			? ok(undefined)
			: err(
					new Error(
						`${arm} workspace changed outside a recorded attempt; preserve it and start a new experiment.`,
					),
				);
	}
	const expected = tree(join(root, "starter"));
	const actual = tree(workspace(root, arm));
	if (!expected.ok) return expected;
	if (!actual.ok) return actual;
	const files = {
		...expected.value,
		"AGENTS.md": hash(instructions(manifest, arm)),
		"CLAUDE.md": hash(instructions(manifest, arm)),
	};
	const canonical = (value: Record<string, string>) =>
		JSON.stringify(
			Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
		);
	return canonical(files) === canonical(actual.value)
		? ok(undefined)
		: err(new Error(`${arm} starter differs from frozen inputs.`));
};
export const verifyFrozen = async (
	root: string,
	manifest: Manifest,
): Promise<Result<void>> => {
	const starter = digestTree(join(root, "starter"));
	if (!starter.ok || starter.value !== manifest.starterDigest)
		return err(new Error("Frozen starter changed."));
	for (const arm of manifest.order) {
		const checked = verifyWorkspace(root, arm, manifest);
		if (!checked.ok) return checked;
	}
	const current = await versions(manifest.recipe);
	if (!current.ok) return current;
	if (canonical(current.value) !== canonical(manifest.versions))
		return err(
			new Error(
				"Harness/Bun/Kabane version changed since freeze; create a new experiment.",
			),
		);
	for (const arm of manifest.order)
		for (const [name, expected] of Object.entries(
			configFiles(root, manifest, arm),
		)) {
			const actual = read(join(root, arm, name));
			if (!actual.ok || actual.value !== expected)
				return err(
					new Error(
						`Configuration drift in ${arm}/${name}; do not silently repair a scored experiment.`,
					),
				);
		}
	if (manifest.evaluator !== null) {
		const grader = read(join(root, "evaluator.ts"));
		if (!grader.ok || grader.value !== manifest.evaluator)
			return err(
				new Error("Frozen evaluator changed; create a new experiment."),
			);
	}
	// Ancestor instruction files could add treatment awareness to both arms.
	let ancestor = root;
	while (true) {
		for (const name of [
			"AGENTS.md",
			"AGENTS.override.md",
			"CLAUDE.md",
			"CLAUDE.local.md",
		])
			if (existsSync(join(ancestor, name)))
				return err(
					new Error(
						`Ancestor instructions at ${join(ancestor, name)}; freeze outside a project tree.`,
					),
				);
		const parent = dirname(ancestor);
		if (parent === ancestor) break;
		ancestor = parent;
	}
	return ok(undefined);
};
