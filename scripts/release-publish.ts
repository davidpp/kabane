import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { runUpdateProcess } from "../packages/cli/src/update-process";
import { err, ok, type Result } from "../packages/core/result";
import {
	readArtifactFile,
	type ReleaseManifest,
	sha256,
	verifyReleaseFiles,
} from "./release-artifact";
import { discoverGitHubRelease, type GitHubRelease } from "./release-github";
import { runReleaseInteractive } from "./release-process";

export type RegistryState = {
	existingIntegrity: string | null;
	latest: string | null;
};
export type ReleaseState = {
	draft: boolean;
	immutable: boolean;
	assetsMatch: boolean;
	assetsComplete: boolean;
} | null;
export type PublishOperations = {
	verifyTag: () => Promise<Result<void>>;
	registry: () => Promise<Result<RegistryState>>;
	release: () => Promise<Result<ReleaseState>>;
	prepareDraft: () => Promise<Result<void>>;
	publishArchive: () => Promise<Result<void>>;
	finalizeDraft: () => Promise<Result<void>>;
};
const failure = (message: string): Result<never> => err(new Error(message));
export const compareVersion = (a: string, b: string): number => {
	const aa = a.split(".").map(Number),
		bb = b.split(".").map(Number);
	for (const i of [0, 1, 2]) {
		const difference = (aa[i] ?? 0) - (bb[i] ?? 0);
		if (difference) return difference;
	}
	return 0;
};

/** One exact archive, one publish attempt; recovery observes state rather than retrying writes. */
export const completeRelease = async (
	record: ReleaseManifest,
	ops: PublishOperations,
): Promise<Result<string>> => {
	if (record.dirty || record.tag !== `v${record.version}`)
		return failure(
			"Artifact is nonpromotable (dirty source or missing/mismatched tag).",
		);
	const tag = await ops.verifyTag();
	if (!tag.ok) return tag;
	const registry = await ops.registry(),
		release = await ops.release();
	if (!registry.ok || !release.ok)
		return failure(
			"Cannot establish registry/release state; no publish attempted.",
		);
	if (
		registry.value.existingIntegrity !== null &&
		registry.value.existingIntegrity !== record.integrity
	)
		return failure(
			"Existing npm version has different bytes; never replace or republish it.",
		);
	if (release.value && !release.value.assetsMatch)
		return failure("Existing release assets conflict; no overwrite attempted.");
	if (release.value && !release.value.draft)
		return registry.value.existingIntegrity === record.integrity &&
			release.value.immutable &&
			release.value.assetsComplete
			? ok("Verified already complete; no writes performed.")
			: failure(
					"Published release is inconsistent or not immutable; investigate manually.",
				);
	if (
		registry.value.existingIntegrity === null &&
		registry.value.latest !== null &&
		compareVersion(record.version, registry.value.latest) <= 0
	)
		return failure(
			"New stable version must advance latest; no implicit downgrade.",
		);
	if (
		registry.value.existingIntegrity !== null &&
		(registry.value.latest === null ||
			compareVersion(registry.value.latest, record.version) < 0)
	)
		return failure(
			"Existing npm version lacks the expected stable tag state; review dist-tags manually.",
		);
	const draft = await ops.prepareDraft();
	if (!draft.ok)
		return failure(
			"Draft preparation failed; npm was not invoked. Retain original assets for recovery.",
		);
	const prepared = await ops.release();
	if (
		!prepared.ok ||
		!prepared.value?.draft ||
		!prepared.value.assetsMatch ||
		!prepared.value.assetsComplete
	)
		return failure(
			"Draft assets are not fully verified; no publish attempted.",
		);
	const before = await ops.verifyTag();
	if (!before.ok) return before;
	if (registry.value.existingIntegrity === null) {
		const fresh = await ops.registry();
		if (
			!fresh.ok ||
			fresh.value.existingIntegrity !== null ||
			(fresh.value.latest !== null &&
				compareVersion(record.version, fresh.value.latest) <= 0)
		)
			return failure(
				"Registry changed before publish; stop and inspect without retrying writes.",
			);
		await ops.publishArchive(); // Its exit status cannot settle an ambiguous committed publish.
	}
	let confirmed: RegistryState | undefined;
	for (let attempt = 0; attempt < 3; attempt++) {
		if (attempt > 0) await Bun.sleep(1000);
		const observed = await ops.registry();
		if (
			observed.ok &&
			observed.value.existingIntegrity === record.integrity &&
			observed.value.latest !== null &&
			compareVersion(observed.value.latest, record.version) >= 0
		) {
			confirmed = observed.value;
			break;
		}
	}
	if (!confirmed)
		return failure(
			"Publication state is unverified/partial; never blindly retry npm. Retain the original archive/draft and inspect registry state.",
		);
	const stillTag = await ops.verifyTag();
	if (!stillTag.ok)
		return failure(
			"npm may be published but tag identity changed; stop before GitHub completion.",
		);
	const finalized = await ops.finalizeDraft();
	if (!finalized.ok)
		return failure(
			"npm is verified; GitHub completion failed. Resume from original matching bytes, never rebuild or republish.",
		);
	const final = await ops.release();
	return final.ok &&
		final.value &&
		!final.value.draft &&
		final.value.immutable &&
		final.value.assetsMatch &&
		final.value.assetsComplete
		? ok("Verified npm publication and immutable GitHub release.")
		: failure(
				"npm is verified; final GitHub immutability/assets remain unverified. Inspect partial state manually.",
			);
};

export const authorizePublication = (
	record: ReleaseManifest,
	env: NodeJS.ProcessEnv,
): Result<void> => {
	if (
		env.GITHUB_ACTIONS !== "true" ||
		env.GITHUB_REPOSITORY !== "davidpp/kabane" ||
		env.GITHUB_SHA !== record.commit ||
		env.GITHUB_REF !== `refs/tags/${record.tag}` ||
		env.RELEASE_PUBLISH !== "true" ||
		env.RELEASE_SETUP_CONFIRMED !== "true" ||
		!env.GH_TOKEN ||
		!env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ||
		!env.ACTIONS_ID_TOKEN_REQUEST_URL
	)
		return failure(
			"Publication requires a matching tag-ref human-approved GitHub job and confirmed external setup/OIDC permissions.",
		);
	if (
		Object.entries(env).some(
			([key, value]) =>
				value && /(?:npm.*(?:token|auth|password)|node_auth_token)/i.test(key),
		)
	)
		return failure(
			"Publish-token fallback is forbidden; remove inherited npm credentials from the approved job.",
		);
	return ok(undefined);
};

const ROOT = resolve(import.meta.dir, "..");
const Stable = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
const NpmRecord = z.object({
	name: z.literal("kabane"),
	version: Stable,
	gitHead: z.string().optional(),
	dist: z.object({ integrity: z.string() }),
});
/** CI uses OIDC-only configuration; the explicit local command keeps human npm credentials. */
const publishVerifiedRelease = async (
	directory: string,
	originalEnv: NodeJS.ProcessEnv,
	mode: "oidc" | "local",
	sourceRoot = ROOT,
): Promise<Result<string>> => {
	const verified = verifyReleaseFiles(directory);
	if (!verified.ok) return verified;
	const record = verified.value;
	if (mode === "oidc") {
		const allowed = authorizePublication(record, originalEnv);
		if (!allowed.ok) return allowed;
	} else if (originalEnv.GITHUB_ACTIONS === "true") {
		return failure(
			"Local publication is human-run, not an alternative CI authentication path.",
		);
	}
	let work: string | undefined;
	try {
		work = mkdtempSync(join(tmpdir(), "kabane-publication-"));
		let env = originalEnv;
		if (mode === "oidc") {
			const userConfig = join(work, "npmrc"),
				globalConfig = join(work, "global-npmrc");
			writeFileSync(userConfig, "registry=https://registry.npmjs.org/\n");
			writeFileSync(globalConfig, "");
			env = {
				...originalEnv,
				NPM_CONFIG_USERCONFIG: userConfig,
				NPM_CONFIG_GLOBALCONFIG: globalConfig,
			};
		}
		const call = (argv: string[], cwd = sourceRoot, timeout = 120_000) =>
			runUpdateProcess(argv, cwd, env, timeout);
		const assets = [
			record.filename,
			"manifest.json",
			"SHA256SUMS",
			"release-notes.md",
		];
		const expected = new Map<string, string>();
		for (const name of assets) {
			const bytes = readArtifactFile(join(directory, name));
			if (!bytes.ok) return bytes;
			expected.set(name, sha256(bytes.value));
		}
		const api = () =>
			discoverGitHubRelease(record.tag, (endpoint) =>
				call(["gh", "api", "--include", endpoint], sourceRoot, 30_000),
			);
		const assetMatches = async (
			state: GitHubRelease,
		): Promise<Result<boolean>> => {
			if (
				state.tag_name !== record.tag ||
				new Set(state.assets.map((asset) => asset.name)).size !==
					state.assets.length ||
				state.assets.some((asset) => !expected.has(asset.name))
			)
				return ok(false);
			for (const asset of state.assets) {
				const downloaded = await call([
					"gh",
					"release",
					"download",
					record.tag ?? "",
					"--repo",
					"davidpp/kabane",
					"--pattern",
					asset.name,
					"--dir",
					work ?? "",
					"--clobber",
				]);
				if (!downloaded.ok || downloaded.value.code !== 0)
					return failure("Could not verify existing release asset bytes.");
				const bytes = readArtifactFile(join(work ?? "", asset.name));
				if (!bytes.ok) return bytes;
				if (sha256(bytes.value) !== expected.get(asset.name)) return ok(false);
			}
			return ok(state.draft || state.assets.length === assets.length);
		};
		const npmVersion = await call(["npm", "--version"], work);
		if (
			!npmVersion.ok ||
			npmVersion.value.code !== 0 ||
			npmVersion.value.stdout.trim() !== record.npm ||
			Bun.version !== record.bun
		)
			return failure(
				"Publisher/producer tool versions differ; no publication attempted.",
			);
		const ops: PublishOperations = {
			verifyTag: async () => {
				const current = verifyReleaseFiles(directory);
				if (!current.ok) return current;
				for (const name of assets) {
					const bytes = readArtifactFile(join(directory, name));
					if (!bytes.ok || sha256(bytes.value) !== expected.get(name))
						return failure(
							"Artifact assets changed before irreversible operation.",
						);
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
			},
			registry: async () => {
				const version = await call(
					[
						"npm",
						"view",
						`kabane@${record.version}`,
						"--json",
						"--registry",
						"https://registry.npmjs.org/",
					],
					work,
					15_000,
				);
				const latest = await call(
					[
						"npm",
						"view",
						"kabane",
						"dist-tags.latest",
						"--json",
						"--registry",
						"https://registry.npmjs.org/",
					],
					work,
					15_000,
				);
				if (!version.ok || !latest.ok || latest.value.code !== 0)
					return failure("Registry lookup failed; absence is not proven.");
				try {
					const latestVersion = Stable.safeParse(
						JSON.parse(latest.value.stdout),
					);
					if (!latestVersion.success)
						return failure("Invalid stable registry latest.");
					const raw: unknown = JSON.parse(version.value.stdout);
					if (version.value.code !== 0) {
						const missing = z
							.object({ error: z.object({ code: z.literal("E404") }) })
							.safeParse(raw);
						return missing.success
							? ok({ existingIntegrity: null, latest: latestVersion.data })
							: failure("Registry error is not proven version absence.");
					}
					const parsed = NpmRecord.safeParse(raw);
					if (
						!parsed.success ||
						parsed.data.version !== record.version ||
						(parsed.data.gitHead && parsed.data.gitHead !== record.commit)
					)
						return failure("Registry version/source identity mismatch.");
					return ok({
						existingIntegrity: parsed.data.dist.integrity,
						latest: latestVersion.data,
					});
				} catch {
					return failure("Invalid registry JSON.");
				}
			},
			release: async () => {
				const state = await api();
				if (!state.ok) return state;
				if (state.value === null) return ok(null);
				const matches = await assetMatches(state.value);
				return matches.ok
					? ok({
							draft: state.value.draft,
							immutable: state.value.immutable === true,
							assetsMatch: matches.value,
							assetsComplete: state.value.assets.length === assets.length,
						})
					: matches;
			},
			prepareDraft: async () => {
				const existing = await api();
				if (!existing.ok) return existing;
				let argv: string[];
				if (existing.value) {
					const matches = await assetMatches(existing.value);
					if (!matches.ok || !matches.value || !existing.value.draft)
						return failure("Conflicting existing draft.");
					const names = new Set(
						existing.value.assets.map((asset) => asset.name),
					);
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
						"--target",
						record.commit,
						"--title",
						`kabane ${record.version}`,
						"--notes-file",
						join(directory, "release-notes.md"),
					];
				const prepared = await call(argv);
				return prepared.ok && prepared.value.code === 0
					? ok(undefined)
					: failure(
							"Draft preparation failed; no overwrite/clobber or tag creation allowed.",
						);
			},
			publishArchive: async () => {
				const argv = [
					"npm",
					"publish",
					join(directory, record.filename),
					"--access",
					"public",
					"--tag",
					"latest",
					"--ignore-scripts",
					"--registry",
					"https://registry.npmjs.org/",
				];
				if (mode === "local")
					return runReleaseInteractive(argv, work ?? ROOT, env);
				const result = await call(argv, work);
				return result.ok && result.value.code === 0
					? ok(undefined)
					: failure(
							"npm publish failed or timed out; inspect committed state.",
						);
			},
			finalizeDraft: async () => {
				const latest = await ops.registry();
				if (!latest.ok || !latest.value.latest)
					return failure(
						"Stable tag state cannot be verified before finalization.",
					);
				const result = await call([
					"gh",
					"release",
					"edit",
					record.tag ?? "",
					"--repo",
					"davidpp/kabane",
					"--draft=false",
					latest.value.latest === record.version
						? "--latest"
						: "--latest=false",
				]);
				return result.ok && result.value.code === 0
					? ok(undefined)
					: failure("GitHub finalization failed.");
			},
		};
		return await completeRelease(record, ops);
	} catch {
		return failure(
			"Publication failed; state may be partial. Inspect original archive/registry/draft manually; do not blindly retry.",
		);
	} finally {
		if (work) rmSync(work, { recursive: true, force: true });
	}
};

export const publishRelease = (
	directory: string,
	env: NodeJS.ProcessEnv,
): Promise<Result<string>> => publishVerifiedRelease(directory, env, "oidc");

export const publishLocalRelease = (
	directory: string,
	env: NodeJS.ProcessEnv,
	sourceRoot = ROOT,
): Promise<Result<string>> =>
	publishVerifiedRelease(directory, env, "local", sourceRoot);
