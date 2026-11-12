import { join } from "node:path";
import { err, ok, type Result } from "../../packages/core/result";
import { environment, home, workspace } from "./experiment";
import { writeJson } from "./files";
import { command } from "./process";
import type { Arm, Manifest } from "./schema";

const sandboxCommand = (
	root: string,
	arm: Arm,
	browser: string,
	args: string[],
): string[] => [
	"codex",
	"sandbox",
	"--permission-profile",
	"benchmark_browser",
	"-c",
	'permissions.benchmark_browser.extends=":workspace"',
	"-c",
	`permissions.benchmark_browser.filesystem={${JSON.stringify(home(root, arm))}="write"}`,
	"-c",
	"permissions.benchmark_browser.network.enabled=true",
	"-C",
	workspace(root, arm),
	"--",
	browser,
	...args,
];
/** A real browser companion plus native sandbox client, without a model request. */
export const checkBrowser = async (
	root: string,
	manifest: Manifest,
): Promise<Result<void>> => {
	const browser = manifest.recipe.browser;
	if (!browser)
		return err(new Error("Recipe has no browser command to check."));
	for (const arm of manifest.order) {
		const env = {
			...environment(root, arm),
			AGENT_BROWSER_SESSION: `preflight-${manifest.digest.slice(0, 12)}-${arm}`,
			AGENT_BROWSER_EXECUTABLE_PATH: browser.executable,
		};
		const page = `data:text/html,${encodeURIComponent('<button onclick="document.body.textContent=42">Check</button>')}`;
		const opened = await command(
			[browser.command, "open", page],
			workspace(root, arm),
			env,
		);
		if (!opened.ok) return opened;
		let checked: Result<void>;
		let closed: Result<string>;
		try {
			checked = await inspectBrowser(root, arm, browser.command, env);
		} finally {
			closed = await command(
				[browser.command, "close"],
				workspace(root, arm),
				env,
			);
		}
		if (!checked.ok) return checked;
		if (!closed.ok) return closed;
	}
	return ok(undefined);
};
const inspectBrowser = async (
	root: string,
	arm: Arm,
	browser: string,
	env: NodeJS.ProcessEnv,
): Promise<Result<void>> => {
	const snapshot = await command(
		sandboxCommand(root, arm, browser, ["snapshot", "-i"]),
		workspace(root, arm),
		env,
	);
	if (!snapshot.ok) return snapshot;
	if (!snapshot.value.includes('button "Check"'))
		return err(
			new Error(
				`${arm}: native sandbox browser did not observe the Check button.`,
			),
		);
	const click = await command(
		sandboxCommand(root, arm, browser, ["click", "@e1"]),
		workspace(root, arm),
		env,
	);
	if (!click.ok) return click;
	const text = await command(
		sandboxCommand(root, arm, browser, ["get", "text", "body"]),
		workspace(root, arm),
		env,
	);
	if (!text.ok) return text;
	if (text.value.trim() !== "42")
		return err(
			new Error(`${arm}: browser click did not change the page to 42.`),
		);
	return writeJson(join(root, arm, "browser-preflight.json"), {
		at: new Date().toISOString(),
		modelCalls: 0,
		snapshot: snapshot.value,
		observedAfterClick: text.value,
		sandbox: "Codex :workspace with isolated home write and network",
	});
};
