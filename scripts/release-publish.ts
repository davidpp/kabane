import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	type ProcessReply,
	runUpdateProcess,
} from "../packages/cli/src/update-process";
import {
	compareVersions,
	isPrerelease,
} from "../packages/cli/src/update-version";
import { err, ok, type Result } from "../packages/core/result";
import {
	INSTALLER,
	readArtifactFile,
	type ReleaseManifest,
	sha256,
	verifyReleaseFiles,
} from "./release-artifact";
import {
	discoverGitHubRelease,
	type GitHubRelease,
	readHighestStableRelease,
} from "./release-github";

export type ReleaseState = {
	draft: boolean;
	prerelease: boolean;
	immutable: boolean;
	assetsMatch: boolean;
	assetsComplete: boolean;
} | null;
export type PublishOperations = {
	verifyTag: () => Promise<Result<void>>;
	release: () => Promise<Result<ReleaseState>>;
	/** The highest published stable release, which a new release must pass. */
	highestStable: () => Promise<Result<string | null>>;
	prepareDraft: () => Promise<Result<void>>;
	finalizeDraft: () => Promise<Result<void>>;
};
// A draft can upload all four archives; retain bounded process cleanup for slow transfers.
const ASSET_TIMEOUT_MS = 600_000;
const failure = (message: string): Result<never> => err(new Error(message));
/** A step's failure with what caused it below, so the job log names the cause. */
const failedBecause = (message: string, cause: Error): Result<never> =>
	failure(`${message}\n${cause.message}`);
/** A failed gh call as gh reported it: its exit code and its own error, or why it was stopped. */
const ghError = (argv: string[], result: Result<ProcessReply>): Error => {
	const step = argv.slice(0, 3).join(" ");
	return new Error(
		result.ok
			? `${step} exited ${result.value.code}: ${result.value.stderr?.trim() || "(no stderr)"}`
			: `${step}: ${result.error.message}`,
	);
};

/** A beta is a GitHub prerelease and never the latest release; a stable release is the latest. */
const marked = (version: string, state: NonNullable<ReleaseState>): boolean =>
	state.prerelease === isPrerelease(version);

const prepareVerifiedDraft = async (
	ops: PublishOperations,
): Promise<Result<void>> => {
	const draft = await ops.prepareDraft();
	if (!draft.ok)
		return failedBecause(
			"Draft preparation failed; nothing was published. Retain original assets for recovery.",
			draft.error,
		);
	const prepared = await ops.release();
	if (!prepared.ok)
		return failedBecause(
			"Draft assets are not fully verified; nothing was published.",
			prepared.error,
		);
	if (
		!prepared.value?.draft ||
		!prepared.value.assetsMatch ||
		!prepared.value.assetsComplete
	)
		return failure(
			"Draft assets are not fully verified; nothing was published.",
		);
	return ok(undefined);
};

/** A complete published release, verified read-only, or null when there is none to draft over. */
const existingRelease = (
	version: string,
	existing: ReleaseState,
): Result<string | null> => {
	if (existing && !existing.assetsMatch)
		return failure("Existing release assets conflict; no overwrite attempted.");
	if (!existing || existing.draft) return ok(null);
	return existing.immutable &&
		existing.assetsComplete &&
		marked(version, existing)
		? ok("Verified already complete; no writes performed.")
		: failure(
				"Published release is inconsistent or not immutable; investigate manually.",
			);
};

/** The draft published while the tag still names its commit, then read back as final. */
const finalizeVerifiedDraft = async (
	version: string,
	ops: PublishOperations,
): Promise<Result<string>> => {
	const stillTag = await ops.verifyTag();
	if (!stillTag.ok)
		return failure(
			"Tag identity changed after the draft was prepared; the draft stays unpublished.",
		);
	const finalized = await ops.finalizeDraft();
	if (!finalized.ok)
		return failedBecause(
			"GitHub finalization failed. Inspect the draft; resume from the original matching bytes, never rebuild.",
			finalized.error,
		);
	const final = await ops.release();
	if (!final.ok)
		return failedBecause(
			"Final GitHub immutability/assets remain unverified. Inspect partial state manually.",
			final.error,
		);
	const state = final.value;
	return state &&
		!state.draft &&
		state.immutable &&
		state.assetsMatch &&
		state.assetsComplete &&
		marked(version, state)
		? ok(
				isPrerelease(version)
					? "Verified immutable GitHub prerelease."
					: "Verified immutable GitHub release, now the latest.",
			)
		: failure(
				"Final GitHub immutability/assets remain unverified. Inspect partial state manually.",
			);
};

/**
 * One exact set of assets, one GitHub release: a draft holding every asset, its bytes read back,
 * then finalized as an immutable release. A stable release becomes GitHub's latest; a beta is a
 * prerelease and leaves latest as it was. Recovery observes state rather than retrying writes: a
 * published release is verified, never edited.
 */
export const completeRelease = async (
	record: ReleaseManifest,
	ops: PublishOperations,
): Promise<Result<string>> => {
	if (record.dirty || record.tag !== `v${record.version}` || !record.binaries)
		return failure(
			"Artifact is nonpromotable (dirty source, missing/mismatched tag or no binaries).",
		);
	const tag = await ops.verifyTag();
	if (!tag.ok) return tag;
	const release = await ops.release();
	if (!release.ok)
		return failedBecause(
			"Cannot establish GitHub release state; nothing published.",
			release.error,
		);
	const existing = existingRelease(record.version, release.value);
	if (!existing.ok) return existing;
	if (existing.value !== null) return ok(existing.value);
	const highest = await ops.highestStable();
	if (!highest.ok)
		return failure("Cannot read the published releases; nothing published.");
	if (
		highest.value !== null &&
		compareVersions(record.version, highest.value) <= 0
	)
		return failure(
			`${record.version} does not pass the published ${highest.value}; no implicit downgrade.`,
		);
	const draft = await prepareVerifiedDraft(ops);
	return draft.ok ? finalizeVerifiedDraft(record.version, ops) : draft;
};

export const authorizePublication = (
	record: ReleaseManifest,
	env: NodeJS.ProcessEnv,
): Result<void> =>
	env.GITHUB_ACTIONS === "true" &&
	env.GITHUB_REPOSITORY === "davidpp/kabane" &&
	env.GITHUB_SHA === record.commit &&
	env.GITHUB_REF === `refs/tags/${record.tag}` &&
	env.RELEASE_PUBLISH === "true" &&
	env.GH_TOKEN
		? ok(undefined)
		: failure(
				"Publication requires the release workflow's approved publish job on a matching tag ref.",
			);

const ROOT = resolve(import.meta.dir, "..");
type Publication = {
	record: ReleaseManifest;
	directory: string;
	work: string;
	call: (
		argv: string[],
		cwd?: string,
		timeout?: number,
	) => Promise<Result<ProcessReply>>;
	assets: string[];
	expected: Map<string, string>;
	api: () => Promise<Result<GitHubRelease | null>>;
};

const verifyPublicationTag = async (
	publication: Publication,
): Promise<Result<void>> => {
	const { record, directory, assets, expected, call } = publication;
	const current = verifyReleaseFiles(directory);
	if (!current.ok) return current;
	for (const name of assets) {
		const bytes = readArtifactFile(join(directory, name), 268_435_456);
		if (!bytes.ok || sha256(bytes.value) !== expected.get(name))
			return failure("Artifact assets changed before irreversible operation.");
	}
	const head = await call(["git", "rev-parse", "HEAD"]),
		dirty = await call(["git", "status", "--porcelain"]);
	const remote = await call([
		"git",
		"ls-remote",
		"--tags",
		"origin",
		`refs/tags/${record.tag}`,
		`refs/tags/${record.tag}^{}`,
	]);
	if (
		!head.ok ||
		!dirty.ok ||
		!remote.ok ||
		head.value.code !== 0 ||
		dirty.value.code !== 0 ||
		remote.value.code !== 0 ||
		head.value.stdout.trim() !== record.commit ||
		dirty.value.stdout.trim() !== ""
	)
		return failure("Source checkout/tag state cannot be verified.");
	const refs = new Map(
		remote.value.stdout
			.trim()
			.split("\n")
			.map((line) => {
				const [sha, ref] = line.split("\t");
				return [ref ?? "", sha ?? ""];
			}),
	);
	return refs.has(`refs/tags/${record.tag}`) &&
		(refs.get(`refs/tags/${record.tag}^{}`) ??
			refs.get(`refs/tags/${record.tag}`)) === record.commit
		? ok(undefined)
		: failure(
				"Existing remote tag is absent or points at another commit; never create/push it.",
			);
};

const readReleaseState = async (
	publication: Publication,
): Promise<Result<ReleaseState>> => {
	const { api, assets } = publication;
	const state = await api();
	if (!state.ok) return state;
	if (state.value === null) return ok(null);
	const matches = await releaseAssetsMatch(publication, state.value);
	return matches.ok
		? ok({
				draft: state.value.draft,
				prerelease: state.value.prerelease === true,
				immutable: state.value.immutable === true,
				assetsMatch: matches.value,
				assetsComplete: state.value.assets.length === assets.length,
			})
		: matches;
};

const prepareReleaseDraft = async (
	publication: Publication,
): Promise<Result<void>> => {
	const { record, directory, assets, api, call } = publication;
	const existing = await api();
	if (!existing.ok) return existing;
	let argv: string[];
	if (existing.value) {
		const matches = await releaseAssetsMatch(publication, existing.value);
		if (!matches.ok) return matches;
		if (!matches.value || !existing.value.draft)
			return failure("Conflicting existing draft.");
		const names = new Set(existing.value.assets.map((asset) => asset.name));
		const missing = assets.filter((name) => !names.has(name));
		if (!missing.length) return ok(undefined);
		argv = [
			"gh",
			"release",
			"upload",
			record.tag ?? "",
			...missing.map((name) => join(directory, name)),
			"--repo",
			"davidpp/kabane",
		];
	} else
		argv = [
			"gh",
			"release",
			"create",
			record.tag ?? "",
			...assets.map((name) => join(directory, name)),
			"--repo",
			"davidpp/kabane",
			"--verify-tag",
			"--draft",
			...(isPrerelease(record.version) ? ["--prerelease"] : []),
			"--target",
			record.commit,
			"--title",
			`kabane ${record.version}`,
			"--notes-file",
			join(directory, "release-notes.md"),
		];
	const prepared = await call(argv, undefined, ASSET_TIMEOUT_MS);
	return prepared.ok && prepared.value.code === 0
		? ok(undefined)
		: err(ghError(argv, prepared));
};

/** What publishes the draft: a stable release as GitHub's latest, a beta as a prerelease that is not. */
export const finalizeArguments = (record: ReleaseManifest): string[] => [
	"gh",
	"release",
	"edit",
	record.tag ?? "",
	"--repo",
	"davidpp/kabane",
	"--draft=false",
	...(isPrerelease(record.version)
		? ["--prerelease", "--latest=false"]
		: ["--latest"]),
];

const finalizeReleaseDraft = async (
	publication: Publication,
): Promise<Result<void>> => {
	const { record, call } = publication;
	const argv = finalizeArguments(record);
	const result = await call(argv);
	return result.ok && result.value.code === 0
		? ok(undefined)
		: err(ghError(argv, result));
};

const releaseAssetsMatch = async (
	publication: Publication,
	state: GitHubRelease,
): Promise<Result<boolean>> => {
	const { record, expected, call, work, assets } = publication;
	if (
		state.tag_name !== record.tag ||
		new Set(state.assets.map((asset) => asset.name)).size !==
			state.assets.length ||
		state.assets.some((asset) => !expected.has(asset.name))
	)
		return ok(false);
	for (const asset of state.assets) {
		const argv = [
			"gh",
			"release",
			"download",
			record.tag ?? "",
			"--repo",
			"davidpp/kabane",
			"--pattern",
			asset.name,
			"--dir",
			work,
			"--clobber",
		];
		const downloaded = await call(argv, undefined, ASSET_TIMEOUT_MS);
		if (!downloaded.ok || downloaded.value.code !== 0)
			return failedBecause(
				"Could not verify existing release asset bytes.",
				ghError(argv, downloaded),
			);
		const bytes = readArtifactFile(join(work, asset.name), 268_435_456);
		if (!bytes.ok) return bytes;
		if (sha256(bytes.value) !== expected.get(asset.name)) return ok(false);
	}
	return ok(state.draft || state.assets.length === assets.length);
};

/** The approved publish job: the retained assets of one tag, published as its GitHub release. */
export const publishRelease = async (
	directory: string,
	env: NodeJS.ProcessEnv,
	sourceRoot = ROOT,
): Promise<Result<string>> => {
	const verified = verifyReleaseFiles(directory);
	if (!verified.ok) return verified;
	const record = verified.value;
	const allowed = authorizePublication(record, env);
	if (!allowed.ok) return allowed;
	let work: string | undefined;
	try {
		work = mkdtempSync(join(tmpdir(), "kabane-publication-"));
		const call = (argv: string[], cwd = sourceRoot, timeout = 120_000) =>
			runUpdateProcess(argv, cwd, env, timeout, { captureStderr: true });
		const assets = [
			...(record.binaries ?? []).map((binary) => binary.filename),
			INSTALLER,
			"manifest.json",
			"SHA256SUMS",
			"release-notes.md",
		];
		const expected = new Map<string, string>();
		for (const name of assets) {
			const bytes = readArtifactFile(join(directory, name), 268_435_456);
			if (!bytes.ok) return bytes;
			expected.set(name, sha256(bytes.value));
		}
		const request = (endpoint: string) =>
			call(["gh", "api", "--include", endpoint], sourceRoot, 30_000);
		if (Bun.version !== record.bun)
			return failure(
				"Publisher/producer Bun versions differ; no publication attempted.",
			);
		const publication: Publication = {
			record,
			directory,
			work,
			call,
			assets,
			expected,
			api: () => discoverGitHubRelease(record.tag, request),
		};
		return await completeRelease(record, {
			verifyTag: () => verifyPublicationTag(publication),
			release: () => readReleaseState(publication),
			highestStable: () => readHighestStableRelease(request),
			prepareDraft: () => prepareReleaseDraft(publication),
			finalizeDraft: () => finalizeReleaseDraft(publication),
		});
	} catch {
		return failure(
			"Publication failed; state may be partial. Inspect the original assets and the draft manually; do not blindly retry.",
		);
	} finally {
		if (work) rmSync(work, { recursive: true, force: true });
	}
};
