// The `kabane` entry each harness on this machine registered, compared with how this kabane
// launches itself. A mise-installed binary's path carries its version, so `mise up` leaves an entry
// that starts nothing. The configs are read, never written and never handed to the harness: its
// own `mcp get` health-checks by starting the server. Re-registering goes through
// `kabane mcp install --force`, so the harness writes its own file.
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute } from "node:path";
import { err, ok, type Result } from "@kabane/core";
import type { Doctor, Extension } from "@kabane/extension";
import { McpInstall } from "../commands/mcp-install";
import { projectAt } from "../context";
import { McpClients } from "../mcp-clients";

export type InstallDeps = {
	home?: string;
	env?: NodeJS.ProcessEnv;
	which?: McpInstall.Which;
	launcher?: McpClients.Launch;
	run?: McpInstall.Runner;
};

const shown = (launch: McpClients.Launch): string =>
	[launch.command, ...launch.args].join(" ");

const isFile = (path: string): boolean =>
	existsSync(path) && statSync(path).isFile();

/**
 * Whether a registered launch still starts something: its command, and the paths it hands that
 * command before `mcp` (the entry script under bun), exist.
 */
const launches = (
	launch: McpClients.Launch,
	which: McpInstall.Which,
): boolean => {
	const command = isAbsolute(launch.command)
		? isFile(launch.command)
		: which(launch.command) !== null;
	const end = launch.args.indexOf("mcp");
	const leading = end === -1 ? launch.args : launch.args.slice(0, end);
	return command && leading.filter(isAbsolute).every(isFile);
};

const isBun = (command: string): boolean =>
	basename(command) === "bun" || basename(command) === "bun.exe";

/**
 * Two launches of the same kabane on different buns: the bun the entry names is the harness's
 * runtime for kabane, not another kabane, so a Bun bump alone is no finding while it still starts.
 */
const bunOnly = (a: McpClients.Launch, b: McpClients.Launch): boolean =>
	isBun(a.command) &&
	isBun(b.command) &&
	McpClients.sameLaunch({ ...a, command: b.command }, b);

export const install = async (
	ctx: Extension.Ctx,
	deps: InstallDeps = {},
): Promise<Result<Doctor.Finding[]>> => {
	const env = deps.env ?? process.env;
	const which = deps.which ?? Bun.which;
	const launcher = deps.launcher ?? McpInstall.launcher();
	const harnesses = McpInstall.detect(which, env);
	if (harnesses.length === 0) return ok([]);
	const project = await projectAt(ctx.cwd, ctx.home);
	if (!project.ok) return project;
	const where: McpClients.Where = {
		home: deps.home ?? homedir(),
		env,
		...(project.value ? { projectRoot: project.value.root } : {}),
	};
	const findings: Doctor.Finding[] = [];
	for (const harness of harnesses) {
		const found = McpClients.registrations(harness, where);
		if (!found.ok) {
			findings.push({
				id: `mcp-config-unreadable-${harness}`,

				severity: "mention",
				summary: `${harness}: ${found.error.message}. Repair this config so its MCP registration can be checked.`,
			});
			continue;
		}
		const expected = McpClients.launchFor(launcher, harness);
		const other = found.value.filter(
			(r) =>
				!McpClients.sameLaunch(r.launch, expected) &&
				!(bunOnly(r.launch, expected) && launches(r.launch, which)),
		);
		if (other.length === 0) continue;
		const id = `mcp-entry-stale-${harness}`;
		const dead = other.filter((r) => !launches(r.launch, which));
		const registered = other
			.map((r) => `${shown(r.launch)} (${r.at})`)
			.join("; ");
		const command = `kabane doctor --fix kabane/${id}`;
		findings.push({
			id,

			path: other[0]?.path,
			// An entry that still starts another kabane, a source checkout say, may be deliberate.
			severity: dead.length > 0 ? "mention" : "suggest",
			summary:
				dead.length > 0
					? `${harness}'s kabane MCP entry no longer launches: it runs ${registered}; this kabane is ${shown(expected)}. ${command} re-registers it.`
					: `${harness}'s kabane MCP entry runs another kabane: ${registered}; this one is ${shown(expected)}. If that is not deliberate, ${command} re-points it here.`,
			fix: async () => {
				const [report] = await McpInstall.run(
					[harness],
					{ force: true },
					{
						which,
						launcher,
						where,
						...(deps.run ? { run: deps.run } : {}),
					},
				);
				if (report?.status === "failed") return err(new Error(report.error));
				if (report?.status !== "replaced" && report?.status !== "installed")
					return err(new Error(`${harness}: ${report?.status ?? "not run"}`));
				return ok(`${harness} now runs ${shown(expected)}`);
			},
		});
	}
	return ok(findings);
};
