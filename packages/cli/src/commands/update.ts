import { err, ok, type Result } from "@cabane/core";
import { type Outcome, type ParsedArgs, usage } from "@cabane/extension";
import { z } from "zod";
import { version } from "../../package.json";
import type { Command } from "../context";
import {
	inspectRegistryInstall,
	type RegistryInstall,
	type UpdateHost,
} from "../update-install";
import { runUpdateProcess } from "../update-process";
import {
	compareVersions,
	DistTagsSchema,
	followedTag,
	isPrerelease,
	onChannel,
	SemverSchema,
	versionCore,
	withinVersionPolicy,
} from "../update-version";

const MetadataSchema = z.object({
	name: z.literal("kabane"),
	version: z.string().max(64),
	bin: z.object({ kabane: z.literal("bin/kabane.js") }),
	engines: z.object({ bun: z.string().regex(/^>=\d+\.\d+\.\d+$/) }),
	dist: z.object({
		tarball: z.string().url(),
		integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/),
	}),
});
type Metadata = z.infer<typeof MetadataSchema>;
type Tag = "latest" | "beta";
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

/** `bun info <spec> --json`, parsed; a failure is the reply to give. */
const readRegistry = async <T>(
	spec: string[],
	schema: z.ZodType<T, z.ZodTypeDef, unknown>,
	globalDir: string,
	host: UpdateHost,
): Promise<Result<T, Outcome>> => {
	const read = await runUpdateProcess(
		[host.bun, "info", ...spec, "--json"],
		globalDir,
		host.env,
	);
	if (!read.ok || read.value.code !== 0)
		return err(
			reply(
				"error",
				"Could not check registry metadata within its limits; inspect Bun registry/proxy settings and retry manually.",
				1,
			),
		);
	try {
		const parsed = schema.safeParse(JSON.parse(read.value.stdout));
		return parsed.success
			? ok(parsed.data)
			: err(
					reply(
						"error",
						"Invalid or unsupported registry metadata; no update attempted.",
						1,
					),
				);
	} catch {
		return err(
			reply("error", "Invalid registry JSON; no update attempted.", 1),
		);
	}
};

/** The release on the tag the install follows (`followedTag`), with its metadata. */
const readCandidate = async (
	runningVersion: string,
	globalDir: string,
	host: UpdateHost,
): Promise<Result<{ tag: Tag; metadata: Metadata }, Outcome>> => {
	if (!isPrerelease(runningVersion)) {
		const latest = await readRegistry(
			["kabane@latest"],
			MetadataSchema,
			globalDir,
			host,
		);
		return latest.ok ? ok({ tag: "latest", metadata: latest.value }) : latest;
	}
	// The tags themselves, not `kabane@beta`: Bun resolves a tag the package lacks to some
	// other version, or to none when every version is a prerelease.
	const tags = await readRegistry(
		["kabane", "dist-tags"],
		DistTagsSchema,
		globalDir,
		host,
	);
	if (!tags.ok) return tags;
	const tag = followedTag(runningVersion, tags.value);
	const metadata = await readRegistry(
		[`kabane@${tag}`],
		MetadataSchema,
		globalDir,
		host,
	);
	if (!metadata.ok) return metadata;
	return metadata.value.version === tags.value[tag]
		? ok({ tag, metadata: metadata.value })
		: err(
				reply(
					"error",
					"Registry dist-tags changed during the check; retry. No update attempted.",
					1,
				),
			);
};

type Details = { installedVersion: string; candidateVersion: string };

/** The version policy (`withinVersionPolicy`), and a Bun the candidate's engine range admits. */
const withinUpdatePolicy = (
	target: string,
	runningVersion: string,
	engine: string,
): boolean =>
	withinVersionPolicy(target, runningVersion) &&
	compareVersions(versionCore(Bun.version), engine.slice(2)) >= 0;

/**
 * The reply a candidate ends the command with before anything is installed: the channel and the
 * update policy held against it, then what `--check` reports. Undefined when the update goes ahead.
 */
const verdict = (
	{ tag, metadata: candidate }: { tag: Tag; metadata: Metadata },
	runningVersion: string,
	check: boolean,
	details: Details,
): Outcome | undefined => {
	const prerelease = isPrerelease(runningVersion);
	const target = candidate.version;
	const manualExit = check ? 0 : 1;
	if (!SemverSchema.safeParse(target).success)
		return reply("error", "Invalid registry version; no update attempted.", 1);
	if (!onChannel(target, runningVersion))
		return reply(
			"manual_only",
			prerelease
				? `Registry ${tag} ${target} is a prerelease outside the beta channel. Review compatibility and choose a manual installation; no channel override is performed. Eligibility is policy-unverified.`
				: "Registry latest is a prerelease. Review compatibility and choose a manual installation; no prerelease/channel override is performed. Eligibility is policy-unverified.",
			manualExit,
			{ installedVersion: runningVersion },
		);
	if (!/^https?:\/\//.test(candidate.dist.tarball))
		return reply(
			"error",
			"Invalid registry version or tarball; no update attempted.",
			1,
			details,
		);
	// Nothing on either tag is newer than a beta that precedes them all; that is current, not a downgrade.
	if (prerelease && compareVersions(target, runningVersion) <= 0)
		return reply(
			"current",
			`No release on registry latest or beta is newer than installed ${runningVersion}. Installation eligibility remains policy-unverified (metadata only).`,
			0,
			details,
		);
	if (!withinUpdatePolicy(target, runningVersion, candidate.engines.bun))
		return reply(
			"manual_only",
			`${prerelease ? `Registry ${tag}` : "Latest stable"} ${target} is outside the supported update policy or Bun engine. Read compatibility notes and choose a manual installation; no downgrade/channel override is performed. Eligibility is policy-unverified.`,
			manualExit,
			details,
		);
	if (target === runningVersion)
		return reply(
			"current",
			`Installed ${runningVersion} matches registry latest. Installation eligibility remains policy-unverified (metadata only).`,
			0,
			details,
		);
	if (check)
		return reply(
			"candidate",
			`${isPrerelease(target) ? "Beta" : "Stable"} candidate ${target} (installed ${runningVersion}); installation eligibility is unknown/policy-unverified. Explicit update will check Bun policy.`,
			0,
			details,
		);
	return undefined;
};

/** The installation is still the one first inspected: same version, same bin, and not dry-run. */
const unchanged = (
	current: Result<RegistryInstall, string>,
	install: RegistryInstall,
): boolean =>
	current.ok &&
	current.value.version === install.version &&
	current.value.bin === install.bin &&
	!current.value.dryRun;

/** The installation now holds `target` behind the same bin, and that bin prints it. */
const verified = async (
	host: UpdateHost,
	install: RegistryInstall,
	target: string,
): Promise<boolean> => {
	const after = await inspectRegistryInstall(host);
	if (
		!after.ok ||
		after.value.version !== target ||
		after.value.bin !== install.bin
	)
		return false;
	const printed = await runUpdateProcess(
		[host.bun, after.value.bin, "--version"],
		after.value.globalDir,
		host.env,
	);
	return (
		printed.ok &&
		printed.value.code === 0 &&
		printed.value.stdout.trim() === target
	);
};

/**
 * Bun's own policy preflight, then the exact install, each only while the installation is still
 * the one inspected, and the result verified before it is reported.
 */
const installCandidate = async (
	host: UpdateHost,
	install: RegistryInstall,
	target: string,
	details: Details,
): Promise<Outcome> => {
	if (!unchanged(await inspectRegistryInstall(host), install))
		return reply(
			"error",
			"Installation changed before update; inspect it manually. No install attempted.",
			1,
			details,
		);
	const argv = [host.bun, "add", "--global", "--exact", `kabane@${target}`];
	const preflight = await runUpdateProcess(
		[...argv, "--dry-run"],
		install.globalDir,
		host.env,
		30_000,
	);
	if (!preflight.ok || preflight.value.code !== 0)
		return reply(
			"blocked",
			"Bun policy preflight failed or exceeded its limits; inspect registry/release-age/security settings manually. No install attempted; external package-manager cache may have changed.",
			1,
			details,
		);
	if (!unchanged(await inspectRegistryInstall(host), install))
		return reply(
			"error",
			"Installation changed during preflight; inspect it manually. No install attempted.",
			1,
			details,
		);
	const changed = await runUpdateProcess(
		argv,
		install.globalDir,
		host.env,
		120_000,
	);
	if (
		!changed.ok ||
		changed.value.code !== 0 ||
		!(await verified(host, install, target))
	)
		return reply(
			"partial_failure",
			"Update could not be verified; the executable installation may have changed partially. Inspect the Bun global package and bin manually; no automatic repair/rollback was attempted. Tracker data was not opened. Restart board/MCP only after a verified installation.",
			1,
			{ ...details, possiblePartialChange: true },
		);
	return reply(
		"updated",
		`Verified kabane ${target}. Restart running board/MCP sessions; source-pinned harness commands need deliberate manual rewiring. Tracker data was not opened; executable rollback is not database rollback.`,
		0,
		{ ...details, eligibility: "bun_preflight_passed", restartRequired: true },
	);
};

const runUpdate = async (
	args: ParsedArgs,
	host: UpdateHost,
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
	const install = await inspectRegistryInstall(host);
	if (!install.ok)
		return reply("unsupported", install.error, 1, { reason: install.error });
	if (install.value.version !== runningVersion)
		return reply(
			"unsupported",
			"Running binary and installed manifest disagree; inspect your installation manually. No update attempted.",
			1,
		);
	const read = await readCandidate(
		runningVersion,
		install.value.globalDir,
		host,
	);
	if (!read.ok) return read.error;
	const target = read.value.metadata.version;
	const details: Details = {
		installedVersion: runningVersion,
		candidateVersion: target,
	};
	const ended = verdict(
		read.value,
		runningVersion,
		args.flags.check === true,
		details,
	);
	if (ended) return ended;
	if (install.value.dryRun)
		return reply(
			"blocked",
			"Bun configuration requests dry-run; no installation attempted and no setting was changed. Review your Bun configuration manually.",
			1,
			details,
		);
	return installCandidate(host, install.value, target, details);
};

export const update: Command = {
	name: "update",
	summary:
		"check a candidate on the installed channel or explicitly update a verified Bun registry install",
	usage: USAGE,
	standalone: true,
	run: (args) =>
		runUpdate(
			args,
			{ bin: Bun.main, bun: process.execPath, env: process.env },
			version,
		),
};
