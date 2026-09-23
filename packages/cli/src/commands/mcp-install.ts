import { flagBool, flagList, type ParsedArgs } from "../args";
import { McpClients } from "../mcp-clients";
import { type Outcome, success, usage } from "../output";

/**
 * Register this device's MCP server in the coding harnesses on this machine,
 * through each harness's own `mcp add`: their config files are theirs to
 * write. The harness spawns are behind an injectable runner, so tests assert
 * argv without executing a harness.
 */
export namespace McpInstall {
	export type Run = McpClients.Probe;
	export type Runner = (argv: string[]) => Promise<Run>;
	export type Which = (binary: string) => string | null;

	export type Options = { force?: boolean };
	export type Deps = {
		run?: Runner;
		which?: Which;
		launcher?: McpClients.Launch;
	};

	export type Report =
		| {
				harness: McpClients.Id;
				status: "installed" | "present" | "replaced" | "missing";
		  }
		| { harness: McpClients.Id; status: "failed"; error: string };

	const runSpawn: Runner = async (argv) => {
		try {
			const proc = Bun.spawn(argv, {
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			return { code: await proc.exited, out, err };
		} catch (error) {
			return { code: -1, out: "", err: String(error) };
		}
	};

	/**
	 * Absolute bun, then this very script. A harness spawns its servers with
	 * its own PATH, which often lacks ~/.bun/bin, and the bin's
	 * `#!/usr/bin/env bun` shebang would need bun on that PATH too.
	 */
	export const launcher = (): McpClients.Launch => ({
		command: process.execPath,
		args: [Bun.main],
	});

	/**
	 * The harnesses whose binary is on PATH. `CABANE_HARNESSES` narrows that to
	 * a comma-separated list, and set but empty means none: `bun run sandbox`
	 * relies on it so a throwaway device never registers itself in the real
	 * harness configs.
	 */
	export const detect = (
		which: Which = Bun.which,
		env: NodeJS.ProcessEnv = process.env,
	): McpClients.Id[] => {
		const allowed = env.CABANE_HARNESSES?.split(",").map((id) => id.trim());
		return McpClients.IDS.filter(
			(id) =>
				(allowed === undefined || allowed.includes(id)) &&
				which(McpClients.entry(id).binary) !== null,
		);
	};

	const failed = (harness: McpClients.Id, result: Run): Report => ({
		harness,
		status: "failed",
		error: result.err.trim() || result.out.trim() || `exit ${result.code}`,
	});

	const installOne = async (
		harness: McpClients.Id,
		opts: Options,
		deps: Required<Deps>,
	): Promise<Report> => {
		const entry = McpClients.entry(harness);
		if (deps.which(entry.binary) === null)
			return { harness, status: "missing" };

		const probe = await deps.run(entry.find);
		const present = entry.isPresent(probe);
		if (present && !opts.force) return { harness, status: "present" };
		if (present) {
			const removed = await deps.run(entry.remove);
			if (removed.code !== 0) return failed(harness, removed);
		}

		const launch = McpClients.launchFor(deps.launcher, harness);
		const added = await deps.run(entry.add(launch));
		if (added.code !== 0) return failed(harness, added);
		return { harness, status: present ? "replaced" : "installed" };
	};

	/** Sequential: two harness CLIs at once would interleave their prompts and output. */
	export const run = async (
		harnesses: readonly McpClients.Id[],
		opts: Options = {},
		deps: Deps = {},
	): Promise<Report[]> => {
		const resolved: Required<Deps> = {
			run: deps.run ?? runSpawn,
			which: deps.which ?? Bun.which,
			launcher: deps.launcher ?? launcher(),
		};
		const reports: Report[] = [];
		for (const harness of harnesses) {
			reports.push(await installOne(harness, opts, resolved));
		}
		return reports;
	};

	export const snippets = (
		harnesses: readonly McpClients.Id[],
		launch: McpClients.Launch,
	): McpClients.Snippet[] => [
		...harnesses.map((id) => McpClients.snippetFor(id, launch)),
		McpClients.genericSnippet(launch),
	];
}

const formatSnippets = (snippets: McpClients.Snippet[]): string =>
	snippets.map((s) => `# ${s.title}\n${s.text}`).join("\n\n");

const REPORT_TEXT: Record<McpInstall.Report["status"], string> = {
	installed: "installed",
	replaced: "replaced",
	present: "already installed (pass --force to replace)",
	missing: "not on PATH",
	failed: "failed",
};

const formatReport = (report: McpInstall.Report): string => {
	const ok = report.status !== "failed" && report.status !== "missing";
	const detail =
		report.status === "failed"
			? `failed: ${report.error}`
			: REPORT_TEXT[report.status];
	const actor =
		report.status === "installed" || report.status === "replaced"
			? `  as ${McpClients.actorFor(report.harness)}`
			: "";
	return `${ok ? "✓" : "✗"} ${report.harness.padEnd(6)} ${detail}${actor}`;
};

export const MCP_INSTALL_USAGE =
	"cabane mcp install [--harness claude|codex|gemini]... [--force] [--print]";

/** `cabane mcp install`: every detected harness, or the ones `--harness` names. */
export const mcpInstall = async (
	args: ParsedArgs,
	deps: McpInstall.Deps = {},
): Promise<Outcome> => {
	const named = flagList(args, "harness");
	const unknown = named.filter((h) => !McpClients.isId(h));
	if (unknown.length > 0)
		return usage(`Unknown harness: ${unknown.join(", ")}`, MCP_INSTALL_USAGE);
	const chosen = named.filter(McpClients.isId);

	const launch = deps.launcher ?? McpInstall.launcher();
	const targets = chosen.length > 0 ? chosen : McpInstall.detect(deps.which);

	if (flagBool(args, "print") || targets.length === 0) {
		const printed = McpInstall.snippets(
			chosen.length > 0 ? chosen : McpClients.IDS,
			launch,
		);
		const lead = flagBool(args, "print")
			? []
			: ["No claude, codex or gemini on PATH. Paste one of these instead:", ""];
		return success(
			{ launcher: launch, snippets: printed },
			[...lead, formatSnippets(printed)].join("\n"),
		);
	}

	const reports = await McpInstall.run(
		targets,
		{ force: flagBool(args, "force") },
		{ ...deps, launcher: launch },
	);
	const failed = reports.some(
		(r) => r.status === "failed" || r.status === "missing",
	);
	return {
		exitCode: failed ? 1 : 0,
		json: { launcher: launch, reports },
		text: reports.map(formatReport).join("\n"),
	};
};
