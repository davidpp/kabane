// What runs `kabane job tick` every minute on this machine: a per-user launchd agent on macOS, a
// crontab line on Linux. It is installed only on the human's yes: `job add` asks at a terminal, and
// `kabane doctor --fix recipes/job-tick-missing` is the yes an agent relays. It runs the kabane
// that installed it (`host.kabane.current`, which Homebrew and mise keep across upgrades), with that
// process's PATH, so the tick finds hc and the harnesses the human's shell finds, and with its
// KABANE_HOME, so a second device on the machine ticks its own jobs.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Doctor, Host, Result } from "@kabane/extension";
import { err, ok, trySync } from "./result";

export namespace JobTick {
	export const LABEL = "com.kabane.job-tick";

	/** What the tick runs: this kabane, the KABANE_HOME it serves and the PATH it searches. */
	export type Target = { kabane: string; kabaneHome: string; path: string };

	/** This kabane as the tick will run it, for the KABANE_HOME `kabaneHome`. */
	export const targetOf = (
		host: Pick<Host, "kabane">,
		kabaneHome: string,
	): Target => ({
		kabane: host.kabane.current?.() ?? host.kabane.executable,
		kabaneHome,
		path: process.env.PATH ?? "/usr/bin:/bin",
	});

	/** The schedulers kabane installs a tick into. */
	export type Platform = "darwin" | "linux";

	export const platformOf = (name: string): Platform | undefined =>
		name === "darwin" || name === "linux" ? name : undefined;

	/** What the human is offered, in their platform's words. */
	export const what = (platform: Platform): string =>
		platform === "darwin"
			? "a launchd agent that runs `kabane job tick` every minute"
			: "a crontab line that runs `kabane job tick` every minute";

	export const agentPath = (home: string): string =>
		join(home, "Library/LaunchAgents", `${LABEL}.plist`);

	const xml = (text: string): string =>
		text
			.replaceAll("&", "&amp;")
			.replaceAll("<", "&lt;")
			.replaceAll(">", "&gt;");

	/** The launchd agent, a tick every minute. */
	export const plist = ({ kabane, kabaneHome, path }: Target): string => {
		const string = (text: string) => `<string>${xml(text)}</string>`;
		return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by kabane. Remove: launchctl bootout gui/$(id -u)/${LABEL}, then delete this file. -->
<plist version="1.0">
<dict>
	<key>Label</key>
	${string(LABEL)}
	<key>ProgramArguments</key>
	<array>
		${string(kabane)}
		${string("job")}
		${string("tick")}
	</array>
	<key>StartInterval</key>
	<integer>60</integer>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		${string(path)}
		<key>KABANE_HOME</key>
		${string(kabaneHome)}
	</dict>
	<key>StandardOutPath</key>
	${string(join(kabaneHome, "job-tick.log"))}
	<key>StandardErrorPath</key>
	${string(join(kabaneHome, "job-tick.error.log"))}
</dict>
</plist>
`;
	};

	// Single-quoted for sh, and `%` escaped: cron turns a bare one into a newline.
	const sh = (text: string): string =>
		`'${text.replaceAll("'", `'\\''`)}'`.replaceAll("%", "\\%");

	/** The crontab line, a tick every minute. */
	export const cronLine = ({ kabane, kabaneHome, path }: Target): string =>
		`* * * * * PATH=${sh(path)} KABANE_HOME=${sh(kabaneHome)} ${sh(kabane)} job tick >> ${sh(join(kabaneHome, "job-tick.log"))} 2>> ${sh(join(kabaneHome, "job-tick.error.log"))}`;

	/** Whether a crontab already runs a tick, kabane's line or one of the human's own. */
	export const inCrontab = (crontab: string): boolean =>
		crontab
			.split("\n")
			.some(
				(line) =>
					!line.trimStart().startsWith("#") && line.includes(" job tick"),
			);

	const run = (
		command: string[],
		stdin?: string,
	): { code: number; stdout: string; stderr: string } => {
		const done = Bun.spawnSync(command, {
			stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			code: done.exitCode,
			stdout: done.stdout.toString(),
			stderr: done.stderr.toString().trim(),
		};
	};

	/**
	 * This user's crontab. `crontab -l` exits 1 with "no crontab for <user>" when there is none:
	 * that is an empty one. Any other failure is an `err`, so install never rewrites a crontab it
	 * could not read.
	 */
	const crontab = (): Result<string> => {
		const listed = trySync(() => run(["crontab", "-l"]));
		if (!listed.ok) return listed;
		const { code, stdout, stderr } = listed.value;
		if (code === 0) return ok(stdout);
		return stderr.includes("no crontab")
			? ok("")
			: err(new Error(`crontab -l exited ${code}: ${stderr}`));
	};

	/** Whether something already runs the tick: kabane's launchd agent, or a crontab line. */
	export const installed = (platform: Platform, home: string): boolean => {
		if (platform === "darwin") return existsSync(agentPath(home));
		const current = crontab();
		return current.ok && inCrontab(current.value);
	};

	/** Writes the launchd agent under `home`; its path. Loading it is `load`'s. */
	export const write = (target: Target, home: string): Result<string> => {
		const file = agentPath(home);
		return trySync(() => {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, plist(target));
			return file;
		});
	};

	// launchd reads the agent at login; bootstrap starts it now, in this user's session.
	const load = (file: string): Result<void> => {
		const loaded = trySync(() =>
			run(["launchctl", "bootstrap", `gui/${process.getuid?.() ?? ""}`, file]),
		);
		if (!loaded.ok) return loaded;
		return loaded.value.code === 0
			? ok(undefined)
			: err(
					new Error(
						`wrote ${file}, but launchctl bootstrap exited ${loaded.value.code}: ${loaded.value.stderr.split("\n").at(-1) ?? ""}`,
					),
				);
	};

	/**
	 * What `install` would do, which it says instead of doing it under `KABANE_JOB_TICK=print`: the
	 * sandbox sets it, since launchctl and crontab act on the user's real session whatever HOME is.
	 */
	const preview = (platform: Platform, target: Target, home: string): string =>
		platform === "darwin"
			? `KABANE_JOB_TICK=print: would write ${agentPath(home)} and run launchctl bootstrap on it:\n${plist(target)}`
			: `KABANE_JOB_TICK=print: would add this line to the crontab:\n${cronLine(target)}`;

	/** Installs the tick for this user and starts it; what it did, as one line. */
	export const install = (
		platform: Platform,
		target: Target,
		home: string,
	): Result<string> => {
		if (process.env.KABANE_JOB_TICK === "print")
			return ok(preview(platform, target, home));
		if (platform === "darwin") {
			const file = write(target, home);
			if (!file.ok) return file;
			const loaded = load(file.value);
			return loaded.ok
				? ok(
						`Installed ${file.value}; launchd runs kabane job tick every minute`,
					)
				: loaded;
		}
		const read = crontab();
		if (!read.ok) return read;
		const current = read.value;
		const next = `${current}${current === "" || current.endsWith("\n") ? "" : "\n"}${cronLine(target)}\n`;
		const saved = trySync(() => run(["crontab", "-"], next));
		if (!saved.ok) return saved;
		return saved.value.code === 0
			? ok("Added a crontab line that runs kabane job tick every minute")
			: err(
					new Error(
						`crontab exited ${saved.value.code}: ${saved.value.stderr}`,
					),
				);
	};

	/**
	 * `job-tick-missing` while this machine has open jobs and nothing ticks them; nothing on a
	 * platform kabane installs no tick on.
	 */
	export const check = (
		jobs: number,
		target: Target,
		{ platform, home }: { platform: Platform | undefined; home: string },
	): Doctor.Finding[] => {
		if (jobs === 0 || platform === undefined || installed(platform, home))
			return [];
		return [
			{
				id: "job-tick-missing",
				...(platform === "darwin" ? { path: agentPath(home) } : {}),
				severity: "suggest",
				summary: `Nothing runs kabane job tick on this machine, so its ${jobs === 1 ? "job never fires" : `${jobs} jobs never fire`}. --fix recipes/job-tick-missing installs ${what(platform)}.`,
				fix: async () => install(platform, target, home),
			},
		];
	};
}
