import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { err, ok, trySync, type Result } from "../../packages/core/result";
import { prepareAuth } from "./auth";
import { checkBrowser } from "./browser";
import {
	environment,
	loadManifest,
	verifyFrozen,
	workspace,
} from "./experiment";
import { writeJson } from "./files";
import { command, runProcess } from "./process";
import type { Harness, Arm } from "./schema";

const nativeAuth = async (
	root: string,
	harness: Harness,
): Promise<Result<void>> => {
	const temporary = trySync(() =>
		mkdtempSync(join(tmpdir(), "kabane-benchmark-auth-")),
	);
	if (!temporary.ok) return temporary;
	const profile = temporary.value;
	const env = {
		...environment(root, "baseline"),
		HOME: profile,
		CODEX_HOME: join(profile, ".codex"),
		CLAUDE_CONFIG_DIR: join(profile, ".claude"),
	};
	const made = trySync(() =>
		mkdirSync(join(profile, ".claude"), { recursive: true, mode: 0o700 }),
	);
	if (!made.ok) return made;
	const auth = await prepareAuth(harness, profile, env);
	if (!auth.ok) {
		trySync(() => rmSync(profile, { recursive: true, force: true }));
		return auth;
	}
	try {
		const argv =
			harness === "codex"
				? ["codex", "login", "status"]
				: ["claude", "auth", "status"];
		const checked = await runProcess({
			argv,
			cwd: workspace(root, "baseline"),
			env,
			seconds: 30,
		});
		if (!checked.ok) return checked;
		if (checked.value.code !== 0)
			return err(new Error(`${harness} native authentication check failed.`));
		if (harness === "codex")
			return /Logged in using ChatGPT/.test(
				checked.value.stdout + checked.value.stderr,
			)
				? ok(undefined)
				: err(
						new Error(
							"Codex did not confirm ChatGPT subscription authentication.",
						),
					);
		const raw = trySync((): unknown => JSON.parse(checked.value.stdout));
		const parsed = raw.ok
			? z
					.object({
						loggedIn: z.literal(true),
						authMethod: z.literal("oauth_token"),
						apiProvider: z.literal("firstParty"),
					})
					.safeParse(raw.value)
			: null;
		return parsed?.success
			? ok(undefined)
			: err(
					new Error("Claude did not confirm first-party OAuth authentication."),
				);
	} finally {
		auth.value();
		trySync(() => rmSync(profile, { recursive: true, force: true }));
	}
};
const mcpInventory = z.array(
	z.object({ name: z.string(), enabled: z.boolean().optional() }).passthrough(),
);

const verifyMcp = async (root: string, arm: Arm): Promise<Result<void>> => {
	const config = await command(
		["codex", "mcp", "list", "--json"],
		workspace(root, arm),
		environment(root, arm),
	);
	if (!config.ok) return config;
	const raw = trySync((): unknown => JSON.parse(config.value));
	const parsed = raw.ok ? mcpInventory.safeParse(raw.value) : null;
	if (!parsed?.success)
		return err(new Error("Codex MCP inventory has an unsupported format."));
	const names = parsed.data
		.filter((server) => server.enabled !== false)
		.map((server) => server.name);
	if (
		JSON.stringify(names) !== JSON.stringify(arm === "kabane" ? ["kabane"] : [])
	)
		return err(new Error(`${arm}: unexpected native MCP inventory.`));
	const saved = writeJson(join(root, arm, "codex-mcp-inventory.json"), {
		at: new Date().toISOString(),
		servers: parsed.data,
	});
	if (!saved.ok) return saved;
	return ok(undefined);
};
export const doctor = async (
	root: string,
	ownsLock = false,
	withBrowser = false,
): Promise<Result<string[]>> => {
	if (!ownsLock && existsSync(join(root, "run.lock")))
		return err(
			new Error(
				"Experiment is locked; doctor will not touch an active runner's credentials.",
			),
		);
	const manifest = loadManifest(root);
	if (!manifest.ok) return manifest;
	const parity = await verifyFrozen(root, manifest.value);
	if (!parity.ok) return parity;
	const notes = [
		"Frozen manifest, per-harness configuration and versions match.",
		"No ancestor project instruction files found.",
	];
	for (const harness of ["codex", "claude"] as const) {
		const checked = await nativeAuth(root, harness);
		if (!checked.ok) return checked;
		notes.push(
			`${harness}: native client confirms subscription authentication in isolated profile.`,
		);
	}
	for (const arm of manifest.value.order) {
		const verified = await verifyMcp(root, arm);
		if (!verified.ok) return verified;
	}
	if (withBrowser) {
		const browser = await checkBrowser(root, manifest.value);
		if (!browser.ok) return browser;
		notes.push(
			"Both conditions passed real browser open/snapshot/click/read through the native Codex sandbox client; no model calls.",
		);
	}
	if (!manifest.value.recipe.billingControlsVerified)
		notes.push(
			"MODEL RUNS BLOCKED: billing controls have not been verified. Check both accounts before setting billingControlsVerified in a new recipe.",
		);
	notes.push(
		"Account overage settings are not observable by this runner; subscription authentication is not an API-enforced spend cap. Disable automatic credit/extra-usage fallback in account settings.",
		"Configuration isolation is not an OS security boundary. Managed policy and provider-side behavior may remain.",
		"Claude effective tool inventory is captured and checked at each launch; Codex inventory is its native mcp list plus observed calls.",
	);
	const saved = writeJson(join(root, "doctor.json"), {
		at: new Date().toISOString(),
		notes,
	});
	return saved.ok ? ok(notes) : err(saved.error);
};
