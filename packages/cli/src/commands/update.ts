import { realpathSync } from "node:fs";
import { trySync } from "@kabane/core";
import { type Outcome, type ParsedArgs, usage } from "@kabane/extension";
import { version } from "../../package.json";
import type { Command } from "../context";
import { Self } from "../self";
import { UpdateBinary } from "../update-binary";
import { inspectRegistryInstall, type UpdateHost } from "../update-install";
import { UpdateMain } from "../update-main";
import {
	compareVersions,
	followedTag,
	isPrerelease,
	onChannel,
	SemverSchema,
	withinVersionPolicy,
} from "../update-version";
import { mainBuild } from "../version";

type Tag = "latest" | "beta";
/**
 * What a Bun global install hears: releases stopped going to npm, so `bun add -g kabane` has
 * nothing newer to take, and the way on is one of the GitHub-release installs.
 */
const MOVED = [
	"kabane releases moved from npm to GitHub Releases, so this Bun install gets no newer release. Move to one of:",
	"  brew install davidpp/tap/kabane",
	"  curl -fsSL https://github.com/davidpp/kabane/releases/latest/download/install.sh | sh",
	"Then run bun remove -g kabane, and kabane mcp install --force so your coding agents launch the new kabane. Nothing was changed.",
].join("\n");
const POLICY = "unknown";
const USAGE = "kabane update [--check] [--json]";
const reply = (
	status: string,
	text: string,
	exitCode: 0 | 1 = 0,
	details: Record<string, unknown> = {},
): Outcome => ({
	exitCode,
	json: { status, eligibility: POLICY, ...details },
	text,
});

type Details = {
	installedVersion: string;
	candidateVersion: string;
	install?: "binary" | UpdateBinary.Manager["name"];
};
/** What replaces the running binary: itself, or the package manager that owns it. */
type Install =
	| { kind: "binary" }
	| { kind: "managed"; manager: UpdateBinary.Manager };

const MANAGERS = { brew: "Homebrew", mise: "mise" };
const managed = ({ name, upgrade }: UpdateBinary.Manager): string =>
	`${MANAGERS[name]} owns this install, so kabane update does not replace it: run ${upgrade}.`;

/**
 * The reply a candidate ends the command with before anything is installed: the channel and the
 * update policy held against it, then what `--check` reports, and for mise or Homebrew what to run
 * instead.
 * Undefined when the update goes ahead.
 */
const verdict = (
	{ tag, target, install }: { tag: Tag; target: string; install: Install },
	runningVersion: string,
	check: boolean,
	details: Details,
): Outcome | undefined => {
	const prerelease = isPrerelease(runningVersion);
	const manualExit = check ? 0 : 1;
	if (!SemverSchema.safeParse(target).success)
		return reply("error", "Invalid GitHub version; no update attempted.", 1);
	if (!onChannel(target, runningVersion))
		return reply(
			"manual_only",
			prerelease
				? `GitHub ${tag} ${target} is a prerelease outside the beta channel. Review compatibility and choose a manual installation; no channel override is performed. Eligibility is policy-unverified.`
				: "GitHub latest is a prerelease. Review compatibility and choose a manual installation; no prerelease/channel override is performed. Eligibility is policy-unverified.",
			manualExit,
			{
				installedVersion: runningVersion,
				...(details.install ? { install: details.install } : {}),
			},
		);
	// Nothing on either tag is newer than a beta that precedes them all; that is current, not a downgrade.
	if (prerelease && compareVersions(target, runningVersion) <= 0)
		return reply(
			"current",
			`No release on GitHub latest or beta is newer than installed ${runningVersion}. Installation eligibility remains policy-unverified (metadata only).`,
			0,
			details,
		);
	const candidate = `${prerelease ? `GitHub ${tag}` : "Latest stable"} ${target}`;
	if (!withinVersionPolicy(target, runningVersion))
		return reply(
			"manual_only",
			`${candidate} is outside the supported update policy. Read compatibility notes and choose a manual installation; no downgrade/channel override is performed. Eligibility is policy-unverified.`,
			manualExit,
			details,
		);
	if (target === runningVersion)
		return reply(
			"current",
			`Installed ${runningVersion} matches GitHub latest. Installation eligibility remains policy-unverified (metadata only).`,
			0,
			details,
		);
	const named = `${isPrerelease(target) ? "Beta" : "Stable"} candidate ${target} (installed ${runningVersion})`;
	if (install.kind === "managed")
		return reply(
			check ? "candidate" : "manual_only",
			`${named}. ${managed(install.manager)}`,
			manualExit,
			details,
		);
	if (check)
		return reply(
			"candidate",
			`${named}. kabane update downloads it and checks its SHA256SUMS and version before replacing this binary.`,
			0,
			details,
		);
	return undefined;
};

/**
 * A standalone binary: the candidate from the GitHub releases under the same policy, then the release
 * archive for this target downloaded, verified and renamed over the real executable. A binary mise
 * or Homebrew installed is left to that manager's upgrade.
 */
const updateBinary = async (
	host: Host,
	runningVersion: string,
	check: boolean,
): Promise<Outcome> => {
	const executable = trySync(() => realpathSync(host.bin));
	if (!executable.ok)
		return reply(
			"unsupported",
			`Cannot resolve the running executable ${host.bin}; replace it with a verified download by hand. No update attempted.`,
			1,
			{ install: "binary" },
		);
	const manager = UpdateBinary.manager(executable.value, host.env);
	const install = manager?.name ?? "binary";
	const tags = await UpdateBinary.fetchReleases(
		host.source.api,
		runningVersion,
		15_000,
	);
	if (!tags.ok)
		return reply(
			"error",
			`Could not read kabane's releases from ${host.source.api} (${tags.error.message}); check the network and retry. No update attempted.`,
			1,
			{ install },
		);
	const tag = followedTag(runningVersion, tags.value);
	const target = tags.value[tag] ?? tags.value.latest;
	const details: Details = {
		installedVersion: runningVersion,
		candidateVersion: target,
		install,
	};
	const ended = verdict(
		{
			tag,
			target,
			install: manager ? { kind: "managed", manager } : { kind: "binary" },
		},
		runningVersion,
		check,
		details,
	);
	if (ended) return ended;
	if (!host.target)
		return reply(
			"unsupported",
			`No standalone kabane is published for ${process.platform}-${process.arch}. No update attempted.`,
			1,
			details,
		);
	const replaced = await UpdateBinary.replace({
		executable: executable.value,
		version: target,
		runningVersion,
		target: host.target,
		source: host.source,
		env: host.env,
	});
	if (!replaced.ok)
		return reply(
			replaced.error.partial ? "partial_failure" : "error",
			replaced.error.text,
			1,
			replaced.error.partial
				? { ...details, possiblePartialChange: true }
				: details,
		);
	return reply(
		"updated",
		`Verified kabane ${target} at ${executable.value}. Restart running board/MCP sessions; harness entries keep this path. Tracker data was not opened.`,
		0,
		{ ...details, eligibility: "checksum_verified", restartRequired: true },
	);
};

/**
 * A main build: the source's main against the stamped commit, and on update the clone that built
 * it builds and installs main again over the running binary.
 */
const updateMain = async (
	stamp: UpdateMain.Stamp,
	host: Host,
	check: boolean,
): Promise<Outcome> => {
	const moved = await UpdateMain.status(stamp, host.env);
	if (!moved.ok)
		return reply("error", `${moved.error} No update attempted.`, 1, {
			channel: "main",
		});
	const details = {
		channel: "main",
		installedCommit: stamp.commit,
		...(moved.value.kind === "level"
			? {}
			: { candidateCommit: moved.value.head }),
		...(moved.value.kind === "behind"
			? { commitsBehind: moved.value.commits }
			: {}),
	};
	const said = UpdateMain.describe(stamp, moved.value);
	if (moved.value.kind === "level") return reply("current", said, 0, details);
	const { clone } = stamp.source;
	const present = UpdateMain.cloneExists(stamp);
	if (check)
		return reply(
			"candidate",
			present
				? `${said} kabane update builds main in ${clone} and installs it.`
				: `${said} ${clone}, the clone that built it, is gone: run ${UpdateMain.COMMAND} in a kabane clone.`,
			0,
			details,
		);
	if (!present)
		return reply(
			"manual_only",
			`${said} ${clone}, the clone that built it, is gone: run ${UpdateMain.COMMAND} in a kabane clone. Nothing was replaced.`,
			1,
			details,
		);
	const executable = trySync(() => realpathSync(host.bin));
	if (!executable.ok)
		return reply(
			"unsupported",
			`Cannot resolve the running executable ${host.bin}; run ${UpdateMain.COMMAND} in ${clone}. No update attempted.`,
			1,
			details,
		);
	// The build's own output is progress for the person, so it goes to stderr and stdout stays
	// this command's reply.
	const built = trySync(() =>
		Bun.spawnSync(["bun", "scripts/main-build.ts", "--bin", executable.value], {
			cwd: clone,
			env: host.env,
			stdio: ["ignore", 2, 2],
		}),
	);
	if (!built.ok || built.value.exitCode !== 0)
		return reply(
			"error",
			`${UpdateMain.COMMAND} in ${clone} failed${built.ok ? "" : " to start (is bun on PATH?)"}; its output above says where. It replaces the install only after every build succeeded.`,
			1,
			details,
		);
	return reply(
		"updated",
		`Built main in ${clone} and installed it at ${executable.value}. Restart running board/MCP sessions.`,
		0,
		{ ...details, restartRequired: true },
	);
};

/** How the running kabane was started and where releases are read; tests pass their own. */
export type Host = UpdateHost & {
	/** A standalone binary from `bun build --compile`, which replaces itself. */
	compiled: boolean;
	/** The stamp of a main build (`version.ts`), which takes main rather than releases. */
	mainBuild: UpdateMain.Stamp | undefined;
	/** This machine's release target, when a binary is published for it. */
	target: string | undefined;
	source: UpdateBinary.Source;
};

export const runUpdate = async (
	args: ParsedArgs,
	host: Host,
	runningVersion: string,
): Promise<Outcome> => {
	if (
		args.positionals.length ||
		Object.entries(args.flags).some(
			([key, value]) => key !== "check" || value !== true,
		)
	)
		return usage(
			"Only --check is supported; choose other versions/channels manually.",
			USAGE,
		);
	if (host.mainBuild)
		return updateMain(host.mainBuild, host, args.flags.check === true);
	if (host.compiled)
		return updateBinary(host, runningVersion, args.flags.check === true);
	const install = await inspectRegistryInstall(host);
	if (!install.ok)
		return reply("unsupported", install.error, 1, { reason: install.error });
	return reply("moved", MOVED, args.flags.check === true ? 0 : 1, {
		installedVersion: runningVersion,
		install: "bun",
	});
};

export const update: Command = {
	name: "update",
	summary:
		"check a candidate on the installed channel, or update a standalone binary or a main build",
	usage: USAGE,
	standalone: true,
	run: (args) =>
		runUpdate(
			args,
			{
				bin: Self.executable(),
				bun: process.execPath,
				env: process.env,
				compiled: Self.compiled(),
				mainBuild,
				target: UpdateBinary.target(),
				source: UpdateBinary.source(process.env),
			},
			version,
		),
};
