import { err, ok, type Result } from "@cabane/core";
import { type Outcome, type ParsedArgs, usage } from "@cabane/extension";
import { z } from "zod";
import { version } from "../../package.json";
import type { Command } from "../context";
import { inspectRegistryInstall, type UpdateHost } from "../update-install";
import { runUpdateProcess } from "../update-process";
import {
	ChannelVersionSchema,
	compareVersions,
	isPrerelease,
	SemverSchema,
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

const readTag = async (
	tag: Tag,
	globalDir: string,
	host: UpdateHost,
): Promise<Result<Metadata, Outcome>> => {
	const metadata = await runUpdateProcess(
		[host.bun, "info", `kabane@${tag}`, "--json"],
		globalDir,
		host.env,
	);
	if (!metadata.ok || metadata.value.code !== 0)
		return err(
			reply(
				"error",
				"Could not check registry metadata within its limits; inspect Bun registry/proxy settings and retry manually.",
				1,
			),
		);
	try {
		const parsed = MetadataSchema.safeParse(JSON.parse(metadata.value.stdout));
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

/**
 * A stable install follows `latest` alone. A prerelease install follows the higher of `beta`
 * and `latest`, so a beta user reaches the stable release it precedes.
 */
const readCandidate = async (
	runningVersion: string,
	globalDir: string,
	host: UpdateHost,
): Promise<Result<{ tag: Tag; metadata: Metadata }, Outcome>> => {
	const latest = await readTag("latest", globalDir, host);
	if (!latest.ok || !isPrerelease(runningVersion))
		return latest.ok ? ok({ tag: "latest", metadata: latest.value }) : latest;
	// Bun answers a dist-tag the package lacks with latest, so no beta tag reads as latest.
	const beta = await readTag("beta", globalDir, host);
	if (!beta.ok) return beta;
	for (const read of [latest.value, beta.value])
		if (!SemverSchema.safeParse(read.version).success)
			return err(
				reply("error", "Invalid registry version; no update attempted.", 1),
			);
	return compareVersions(beta.value.version, latest.value.version) > 0
		? ok({ tag: "beta", metadata: beta.value })
		: ok({ tag: "latest", metadata: latest.value });
};

const core = (version: string): string[] =>
	(version.split("-")[0] ?? "").split(".");

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
	const { tag, metadata: candidate } = read.value;
	const prerelease = isPrerelease(runningVersion);
	const target = candidate.version;
	const details = {
		installedVersion: runningVersion,
		candidateVersion: target,
	};
	if (!SemverSchema.safeParse(target).success)
		return reply("error", "Invalid registry version; no update attempted.", 1);
	if (
		prerelease
			? !ChannelVersionSchema.safeParse(target).success
			: isPrerelease(target)
	)
		return reply(
			"manual_only",
			prerelease
				? `Registry ${tag} ${target} is a prerelease outside the beta channel. Review compatibility and choose a manual installation; no channel override is performed. Eligibility is policy-unverified.`
				: "Registry latest is a prerelease. Review compatibility and choose a manual installation; no prerelease/channel override is performed. Eligibility is policy-unverified.",
			args.flags.check ? 0 : 1,
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
	const currentParts = core(runningVersion),
		targetParts = core(target);
	if (
		compareVersions(target, runningVersion) < 0 ||
		currentParts[0] !== targetParts[0] ||
		(currentParts[0] === "0" && currentParts[1] !== targetParts[1]) ||
		compareVersions(
			core(Bun.version).join("."),
			candidate.engines.bun.slice(2),
		) < 0
	)
		return reply(
			"manual_only",
			`${prerelease ? `Registry ${tag}` : "Latest stable"} ${target} is outside the supported update policy or Bun engine. Read compatibility notes and choose a manual installation; no downgrade/channel override is performed. Eligibility is policy-unverified.`,
			args.flags.check ? 0 : 1,
			details,
		);
	if (target === runningVersion)
		return reply(
			"current",
			`Installed ${runningVersion} matches registry latest. Installation eligibility remains policy-unverified (metadata only).`,
			0,
			details,
		);
	if (args.flags.check)
		return reply(
			"candidate",
			`${isPrerelease(target) ? "Beta" : "Stable"} candidate ${target} (installed ${runningVersion}); installation eligibility is unknown/policy-unverified. Explicit update will check Bun policy.`,
			0,
			details,
		);
	if (install.value.dryRun)
		return reply(
			"blocked",
			"Bun configuration requests dry-run; no installation attempted and no setting was changed. Review your Bun configuration manually.",
			1,
			details,
		);
	const rechecked = await inspectRegistryInstall(host);
	if (
		!rechecked.ok ||
		rechecked.value.version !== runningVersion ||
		rechecked.value.bin !== install.value.bin ||
		rechecked.value.dryRun
	)
		return reply(
			"error",
			"Installation changed before update; inspect it manually. No install attempted.",
			1,
			details,
		);
	const argv = [host.bun, "add", "--global", "--exact", `kabane@${target}`];
	const preflight = await runUpdateProcess(
		[...argv, "--dry-run"],
		install.value.globalDir,
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
	const beforeWrite = await inspectRegistryInstall(host);
	if (
		!beforeWrite.ok ||
		beforeWrite.value.version !== runningVersion ||
		beforeWrite.value.bin !== install.value.bin ||
		beforeWrite.value.dryRun
	)
		return reply(
			"error",
			"Installation changed during preflight; inspect it manually. No install attempted.",
			1,
			details,
		);
	const changed = await runUpdateProcess(
		argv,
		install.value.globalDir,
		host.env,
		120_000,
	);
	const partial = (): Outcome =>
		reply(
			"partial_failure",
			"Update could not be verified; the executable installation may have changed partially. Inspect the Bun global package and bin manually; no automatic repair/rollback was attempted. Tracker data was not opened. Restart board/MCP only after a verified installation.",
			1,
			{ ...details, possiblePartialChange: true },
		);
	if (!changed.ok || changed.value.code !== 0) return partial();
	const after = await inspectRegistryInstall(host);
	if (
		!after.ok ||
		after.value.version !== target ||
		after.value.bin !== install.value.bin
	)
		return partial();
	const printed = await runUpdateProcess(
		[host.bun, after.value.bin, "--version"],
		after.value.globalDir,
		host.env,
	);
	if (
		!printed.ok ||
		printed.value.code !== 0 ||
		printed.value.stdout.trim() !== target
	)
		return partial();
	return reply(
		"updated",
		`Verified kabane ${target}. Restart running board/MCP sessions; source-pinned harness commands need deliberate manual rewiring. Tracker data was not opened; executable rollback is not database rollback.`,
		0,
		{ ...details, eligibility: "bun_preflight_passed", restartRequired: true },
	);
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
