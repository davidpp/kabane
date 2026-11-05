import { z } from "zod";

const NUMBER = "(0|[1-9]\\d*)";
const IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const safe = (version: string): boolean =>
	(version.match(/\d+/g) ?? []).every((part) =>
		Number.isSafeInteger(Number(part)),
	);

/** A SemVer 2.0 version without build metadata, as a registry may report one. */
export const SemverSchema = z
	.string()
	.max(64)
	.regex(
		new RegExp(
			`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-${IDENTIFIER}(?:\\.${IDENTIFIER})*)?$`,
		),
	)
	.refine(safe);

/** The versions kabane ships: stable `X.Y.Z` on npm `latest`, `X.Y.Z-beta.N` on npm `beta`. */
export const ChannelVersionSchema = z
	.string()
	.max(64)
	.regex(
		new RegExp(`^${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-beta\\.${NUMBER})?$`),
	)
	.refine(safe);

export const isPrerelease = (version: string): boolean => version.includes("-");

/** The `X.Y.Z` of a version, its prerelease dropped. */
export const versionCore = (version: string): string =>
	version.split("-")[0] ?? "";

/** The npm dist-tag a channel version is published on and read from. */
export const channelOf = (version: string): "latest" | "beta" =>
	isPrerelease(version) ? "beta" : "latest";

const compareIdentifiers = (a: string, b: string): number => {
	const numericA = /^\d+$/.test(a),
		numericB = /^\d+$/.test(b);
	if (numericA && numericB) return Number(a) - Number(b);
	// Numeric identifiers have lower precedence than alphanumeric ones.
	if (numericA !== numericB) return numericA ? -1 : 1;
	return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * SemVer precedence of two versions `SemverSchema` accepts: negative, zero or positive.
 * A prerelease sorts below its own release, and its identifiers compare field by field.
 */
export const compareVersions = (a: string, b: string): number => {
	const [coreA = "", preA] = a.split(/-(.*)/s),
		[coreB = "", preB] = b.split(/-(.*)/s);
	const partsA = coreA.split(".").map(Number),
		partsB = coreB.split(".").map(Number);
	for (const index of [0, 1, 2]) {
		const difference = (partsA[index] ?? 0) - (partsB[index] ?? 0);
		if (difference) return difference;
	}
	if (preA === undefined || preB === undefined)
		return preA === preB ? 0 : preA === undefined ? 1 : -1;
	const fieldsA = preA.split("."),
		fieldsB = preB.split(".");
	for (
		let index = 0;
		index < Math.max(fieldsA.length, fieldsB.length);
		index++
	) {
		const fieldA = fieldsA[index],
			fieldB = fieldsB[index];
		if (fieldA === undefined) return -1;
		if (fieldB === undefined) return 1;
		const difference = compareIdentifiers(fieldA, fieldB);
		if (difference) return difference;
	}
	return 0;
};

/** The registry's `latest` and `beta` dist-tags; any other tag is dropped. */
export const DistTagsSchema = z.object({
	latest: SemverSchema,
	beta: SemverSchema.optional(),
});
export type DistTags = z.infer<typeof DistTagsSchema>;

/**
 * The dist-tag an install follows. A stable install follows `latest` alone. A prerelease install
 * follows the higher of `beta` and `latest`, so a beta user reaches the stable release it precedes.
 */
export const followedTag = (
	runningVersion: string,
	tags: DistTags,
): "latest" | "beta" =>
	isPrerelease(runningVersion) &&
	tags.beta !== undefined &&
	compareVersions(tags.beta, tags.latest) > 0
		? "beta"
		: "latest";

/** A stable install takes only stable releases; a beta install takes stable or `X.Y.Z-beta.N`. */
export const onChannel = (target: string, runningVersion: string): boolean =>
	isPrerelease(runningVersion)
		? ChannelVersionSchema.safeParse(target).success
		: !isPrerelease(target);

/** Not a downgrade, the same major as the install, and the same minor below 1.0. */
export const withinVersionPolicy = (
	target: string,
	runningVersion: string,
): boolean => {
	const [major, minor] = versionCore(runningVersion).split("."),
		[targetMajor, targetMinor] = versionCore(target).split(".");
	return !(
		compareVersions(target, runningVersion) < 0 ||
		major !== targetMajor ||
		(major === "0" && minor !== targetMinor)
	);
};
