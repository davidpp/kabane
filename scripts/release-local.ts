import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { runUpdateProcess } from "../packages/cli/src/update-process";
import { err, ok, type Result } from "../packages/core/result";
import { prepareRelease } from "./release";
import {
	readArtifactFile,
	ReleaseVersionSchema,
	sha256,
	verifyReleaseFiles,
} from "./release-artifact";
import { runReleaseInteractive } from "./release-process";
import { compareVersion, publishLocalRelease } from "./release-publish";

const ROOT = resolve(import.meta.dir, "..");
export const LOCAL_RELEASE_HELP = `Usage: bun run release:local prepare|publish --version X.Y.Z [--notes-file path]

prepare: require clean main, commit the version/lock, run the gates, build/pack once,
         smoke and retain .releases/X.Y.Z, enable GitHub release immutability,
         create an annotated tag (honoring configured signing), push source/tag.
         No npm login, publication or global-bin replacement.
publish: require that verified original archive, use local npm authentication,
         publish once and complete the matching GitHub release. Never rebuild.

Run npm login between phases if needed. Only prepare accepts --notes-file.
Human-run only; agents must not execute these release operations.`;

const StableVersionSchema = ReleaseVersionSchema.refine((version) =>
	version.split(".").every((part) => Number.isSafeInteger(Number(part))),
);

type LocalReleaseArgs = {
	mode: "prepare" | "publish";
	version: string;
	notesFile?: string;
};
export const parseLocalReleaseArgs = (
	argv: string[],
): Result<LocalReleaseArgs> => {
	const [mode, ...flags] = argv;
	const values: Record<string, string> = {};
	for (let index = 0; index < flags.length; index += 2) {
		const flag = flags[index],
			value = flags[index + 1];
		if (
			!flag ||
			!value ||
			value.startsWith("--") ||
			!["--version", "--notes-file"].includes(flag) ||
			flag in values
		)
			return err(new Error(LOCAL_RELEASE_HELP));
		values[flag] = value;
	}
	const parsed = z
		.object({
			mode: z.enum(["prepare", "publish"]),
			version: StableVersionSchema,
			notesFile: z.string().min(1).optional(),
		})
		.safeParse({
			mode,
			version: values["--version"],
			notesFile: values["--notes-file"],
		});
	return parsed.success &&
		!(parsed.data.mode === "publish" && parsed.data.notesFile)
		? ok(parsed.data)
		: err(new Error(LOCAL_RELEASE_HELP));
};

const Source = z
	.object({
		name: z.literal("kabane"),
		private: z.literal(true),
		version: StableVersionSchema,
	})
	.passthrough();
const Immutable = z.object({ enabled: z.boolean() });
const fail = (message: string): Result<never> => err(new Error(message));

const query = async (
	argv: string[],
	root: string,
	env: NodeJS.ProcessEnv,
): Promise<Result<string>> => {
	const result = await runUpdateProcess(argv, root, env, 30_000);
	return result.ok && result.value.code === 0
		? ok(result.value.stdout.trim())
		: fail(
				`${argv[0]} ${argv[1] ?? ""} failed; check local authentication/configuration. No automatic retry or rollback.`,
			);
};

const sourceState = async (
	root: string,
	env: NodeJS.ProcessEnv,
): Promise<Result<string>> => {
	const dirty = await query(["git", "status", "--porcelain"], root, env);
	const branch = await query(["git", "branch", "--show-current"], root, env);
	const origin = await query(
		["git", "config", "--get", "remote.origin.url"],
		root,
		env,
	);
	if (!dirty.ok || !branch.ok || !origin.ok)
		return fail("Could not establish clean source/repository identity.");
	if (dirty.value || branch.value !== "main")
		return fail(
			"Local release requires clean main. Commit/integrate your work first; nothing was stashed or reset.",
		);
	if (
		![
			"git@github.com:davidpp/kabane.git",
			"https://github.com/davidpp/kabane.git",
			"ssh://git@github.com/davidpp/kabane.git",
		].includes(origin.value)
	)
		return fail(
			"Local release is only for origin davidpp/kabane; no remote was changed.",
		);
	return query(["git", "rev-parse", "HEAD"], root, env);
};

const immutable = async (
	root: string,
	env: NodeJS.ProcessEnv,
	enable: boolean,
): Promise<Result<void>> => {
	const result = await query(
		["gh", "api", "repos/davidpp/kabane/immutable-releases"],
		root,
		env,
	);
	if (!result.ok) return result;
	const parsed = Immutable.safeParse(JSON.parse(result.value));
	if (!parsed.success)
		return fail(
			"Invalid GitHub immutability response; no publication authorized.",
		);
	if (parsed.data.enabled) return ok(undefined);
	if (!enable)
		return fail(
			"GitHub release immutability is disabled; run prepare to enable it before publication.",
		);
	const enabled = await query(
		["gh", "api", "--method", "PUT", "repos/davidpp/kabane/immutable-releases"],
		root,
		env,
	);
	return enabled.ok ? immutable(root, env, false) : enabled;
};

const verifyArtifactSource = (
	directory: string,
	version: string,
	commit: string,
): Result<void> => {
	const record = verifyReleaseFiles(directory);
	if (!record.ok) return record;
	if (
		record.value.dirty ||
		record.value.tag !== `v${version}` ||
		record.value.version !== version ||
		record.value.commit !== commit
	)
		return fail(
			"Prepared artifact/source/version/tag mismatch. Retain original bytes; do not rebuild a recovery artifact.",
		);
	return ok(undefined);
};

const verifiedPreparation = (
	directory: string,
	version: string,
	commit: string,
): Result<void> => {
	const source = verifyArtifactSource(directory, version, commit);
	if (!source.ok) return source;
	const manifest = readArtifactFile(join(directory, "manifest.json"), 65_536);
	const proof = readArtifactFile(join(directory, "verified.sha256"), 128);
	return manifest.ok &&
		proof.ok &&
		proof.value.toString() === `${sha256(manifest.value)}\n`
		? ok(undefined)
		: fail(
				"Artifact has no matching successful local gate/smoke record. Run prepare, not publish.",
			);
};

const verifyExistingTag = async (
	version: string,
	sourceVersion: string,
	commit: string,
	root: string,
	env: NodeJS.ProcessEnv,
): Promise<Result<boolean>> => {
	const tag = `v${version}`;
	const tagged = await query(["git", "tag", "--list", tag], root, env);
	if (!tagged.ok) return tagged;
	if (tagged.value) {
		const local = await query(
			["git", "rev-parse", `${tag}^{commit}`],
			root,
			env,
		);
		if (!local.ok || local.value !== commit || sourceVersion !== version)
			return fail(
				"Existing local tag conflicts with this source/version; never move it.",
			);
	}
	const remote = await query(
		["git", "ls-remote", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
		root,
		env,
	);
	if (!remote.ok) return remote;
	const refs = new Map(
		remote.value.split("\n").map((line) => {
			const [sha, ref] = line.split("\t");
			return [ref ?? "", sha ?? ""];
		}),
	);
	if (
		remote.value &&
		(!tagged.value ||
			(refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`)) !==
				commit)
	)
		return fail(
			"Existing remote tag needs original-source/artifact recovery; no version/tag replacement attempted.",
		);
	return ok(tagged.value !== "");
};

type PreparedSource = { commit: string; tagged: boolean; notes?: string };

const prepareSource = async (
	args: LocalReleaseArgs,
	root: string,
	env: NodeJS.ProcessEnv,
	directory: string,
): Promise<Result<PreparedSource>> => {
	const source = Source.safeParse(
		JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")),
	);
	if (!source.success) return fail("Invalid source CLI manifest.");
	const latest = await query(
		[
			"npm",
			"view",
			"kabane",
			"dist-tags.latest",
			"--json",
			"--registry",
			"https://registry.npmjs.org/",
		],
		root,
		env,
	);
	if (!latest.ok) return latest;
	const published = StableVersionSchema.safeParse(JSON.parse(latest.value));
	if (
		!published.success ||
		compareVersion(args.version, published.data) <= 0 ||
		compareVersion(args.version, source.data.version) < 0
	)
		return fail(
			"Select a stable version newer than npm latest and not older than the source. No version fallback/downgrade.",
		);
	let notes: string | undefined;
	if (args.notesFile) {
		if (existsSync(directory))
			return fail(
				"Retained release notes cannot be replaced; resume with no --notes-file.",
			);
		const read = readArtifactFile(resolve(args.notesFile), 32_768);
		if (!read.ok) return read;
		notes = read.value.toString();
	}
	const fetch = await runReleaseInteractive(
		["git", "fetch", "origin", "main"],
		root,
		env,
	);
	if (!fetch.ok) return fetch;
	const ancestor = await query(
		["git", "merge-base", "--is-ancestor", "origin/main", "HEAD"],
		root,
		env,
	);
	if (!ancestor.ok)
		return fail(
			"Remote main is ahead or diverged; integrate it deliberately before release.",
		);
	const head = await query(["git", "rev-parse", "HEAD"], root, env);
	if (!head.ok) return head;
	if (existsSync(directory)) {
		const retained = verifyArtifactSource(directory, args.version, head.value);
		if (!retained.ok) return retained;
		if (source.data.version !== args.version)
			return fail(
				"Source version conflicts with the retained archive; no version write attempted.",
			);
	}
	const tagged = await verifyExistingTag(
		args.version,
		source.data.version,
		head.value,
		root,
		env,
	);
	if (!tagged.ok) return tagged;
	if (source.data.version !== args.version) {
		writeFileSync(
			join(root, "packages/cli/package.json"),
			`${JSON.stringify({ ...source.data, version: args.version }, null, "\t")}\n`,
		);
		for (const argv of [
			[process.execPath, "install", "--lockfile-only", "--ignore-scripts"],
			["git", "add", "--", "packages/cli/package.json", "bun.lock"],
			["git", "commit", "-m", `chore: release kabane ${args.version}`],
		]) {
			const changed = await runReleaseInteractive(argv, root, env);
			if (!changed.ok) return changed;
		}
	}
	const committed = await sourceState(root, env);
	return committed.ok
		? ok({ commit: committed.value, tagged: tagged.value, notes })
		: committed;
};

const prepareArchive = async (
	version: string,
	source: PreparedSource,
	root: string,
	env: NodeJS.ProcessEnv,
	directory: string,
): Promise<Result<void>> => {
	const tag = `v${version}`;
	if (!existsSync(join(directory, "verified.sha256"))) {
		for (const gate of ["check", "typecheck", "test"]) {
			const checked = await runReleaseInteractive(
				[process.execPath, "run", gate],
				root,
				env,
			);
			if (!checked.ok) return checked;
		}
		if (!existsSync(directory)) {
			let notes = source.notes;
			if (notes === undefined) {
				const history = await query(
					["git", "log", "-12", "--format=- %s"],
					root,
					env,
				);
				if (!history.ok) return history;
				notes = `# kabane ${version}\n\nRecent source changes (review before publishing):\n\n${history.value}\n\nSource commit: ${source.commit}\n\nRead compatibility notes and restart board/MCP sessions after upgrading. Executable rollback is not database rollback.\n`;
			}
			const packed = await prepareRelease(
				directory,
				`refs/tags/${tag}`,
				source.commit,
				notes,
				root,
			);
			if (!packed.ok) return packed;
		}
		const retained = verifyArtifactSource(directory, version, source.commit);
		if (!retained.ok) return retained;
		const smoke = await runReleaseInteractive(
			[process.execPath, "scripts/smoke.ts", "--artifact-dir", directory],
			root,
			env,
		);
		if (!smoke.ok) return smoke;
		const manifest = readArtifactFile(join(directory, "manifest.json"), 65_536);
		if (!manifest.ok) return manifest;
		writeFileSync(
			join(directory, "verified.sha256"),
			`${sha256(manifest.value)}\n`,
		);
	}
	return verifiedPreparation(directory, version, source.commit);
};

const prepare = async (
	args: LocalReleaseArgs,
	root: string,
	env: NodeJS.ProcessEnv,
	directory: string,
): Promise<Result<string>> => {
	const source = await prepareSource(args, root, env, directory);
	if (!source.ok) return source;
	const archive = await prepareArchive(
		args.version,
		source.value,
		root,
		env,
		directory,
	);
	if (!archive.ok) return archive;
	const setting = await immutable(root, env, true);
	if (!setting.ok) return setting;
	const tag = `v${args.version}`;
	if (!source.value.tagged) {
		const created = await runReleaseInteractive(
			["git", "tag", "-a", tag, "-m", `kabane ${args.version}`],
			root,
			env,
		);
		if (!created.ok) return created;
	}
	const pushed = await runReleaseInteractive(
		[
			"git",
			"push",
			"--atomic",
			"origin",
			"HEAD:refs/heads/main",
			`refs/tags/${tag}`,
		],
		root,
		env,
	);
	if (!pushed.ok) return pushed;
	return ok(
		`Verified archive retained at ${directory}. No npm publication attempted.\nReview release-notes.md and perform the manual board check, then:\n  npm login\n  bun run release:local publish --version ${args.version}\nPublishing will reuse these bytes without running gates, building or packing again.`,
	);
};

export const runLocalRelease = async (
	args: LocalReleaseArgs,
	root = ROOT,
	env: NodeJS.ProcessEnv = process.env,
): Promise<Result<string>> => {
	if (env.GITHUB_ACTIONS === "true")
		return fail(
			"Use the protected OIDC workflow in CI; local release is human-run.",
		);
	let lock: string | undefined;
	try {
		const head = await sourceState(root, env);
		if (!head.ok) return head;
		// Checking GitHub access before version writes avoids preparing a release that cannot be finished.
		const access = await query(
			["gh", "api", "repos/davidpp/kabane/immutable-releases"],
			root,
			env,
		);
		if (!access.ok) return access;
		const parent = join(root, ".releases"),
			directory = join(parent, args.version);
		mkdirSync(parent, { recursive: true });
		const candidate = join(parent, `${args.version}.lock`);
		if (existsSync(candidate))
			return fail(
				`Release lock exists at ${candidate}; another local release may be running. Investigate before removing a stale lock.`,
			);
		mkdirSync(candidate);
		lock = candidate;
		if (args.mode === "prepare")
			return await prepare(args, root, env, directory);
		const proven = verifiedPreparation(directory, args.version, head.value);
		if (!proven.ok) return proven;
		const setting = await immutable(root, env, false);
		if (!setting.ok) return setting;
		const authenticated = await query(
			["npm", "whoami", "--registry", "https://registry.npmjs.org/"],
			root,
			env,
		);
		if (!authenticated.ok)
			return fail(
				`Run npm login, then retry publish --version ${args.version}. Original archive retained; no draft or npm publication attempted.`,
			);
		return await publishLocalRelease(directory, env);
	} catch {
		return fail(
			"Local release stopped; source/settings may have changed. Inspect the retained .releases directory and git state. No automatic rollback, tag movement or artifact replacement.",
		);
	} finally {
		if (lock) rmSync(lock, { recursive: true, force: true });
	}
};

if (import.meta.main) {
	const argv = process.argv.slice(2);
	if (argv.length === 1 && argv[0] === "--help")
		console.log(LOCAL_RELEASE_HELP);
	else {
		const parsed = parseLocalReleaseArgs(argv);
		const result = parsed.ok ? await runLocalRelease(parsed.value) : parsed;
		if (result.ok) console.log(result.value);
		else {
			console.error(result.error.message);
			process.exitCode = parsed.ok ? 1 : 2;
		}
	}
}
