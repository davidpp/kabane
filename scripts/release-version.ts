import { z } from "zod";
import { err, ok, type Result } from "../packages/core/result";
import { ReleaseVersionSchema } from "./release-artifact";
import { queryRelease } from "./release-process";

export const StableReleaseVersionSchema = ReleaseVersionSchema.refine(
	(version) =>
		version.split(".").every((part) => Number.isSafeInteger(Number(part))),
);
export const SemanticBumpSchema = z.enum(["major", "minor", "patch"]);
export type SemanticBump = z.infer<typeof SemanticBumpSchema>;
const fail = (message: string): Result<never> => err(new Error(message));
const GUIDANCE =
	"Choose --bump major|minor|patch explicitly if that release intent is deliberate.";

export const bumpReleaseVersion = (
	current: string,
	bump: SemanticBump,
): Result<string> => {
	if (!StableReleaseVersionSchema.safeParse(current).success)
		return fail("Invalid stable release version.");
	const [major = 0, minor = 0, patch = 0] = current.split(".").map(Number);
	const next =
		bump === "major"
			? `${major + 1}.0.0`
			: bump === "minor"
				? `${major}.${minor + 1}.0`
				: `${major}.${minor}.${patch + 1}`;
	const parsed = StableReleaseVersionSchema.safeParse(next);
	return parsed.success
		? ok(parsed.data)
		: fail("Release version increment exceeds safe numeric bounds.");
};

type Commit = { sha: string; message: string };
export const inferReleaseBump = (
	current: string,
	commits: Commit[],
): Result<SemanticBump> => {
	if (!StableReleaseVersionSchema.safeParse(current).success)
		return fail("Invalid stable release version.");
	if (commits.length > 1000)
		return fail(`Auto release history exceeds 1000 commits. ${GUIDANCE}`);
	let severity = 0;
	for (const commit of commits) {
		const header = /^([a-z][a-z0-9-]*)(?:\([^()\r\n]+\))?(!)?: +\S.*$/i.exec(
			commit.message.split("\n")[0] ?? "",
		);
		if (!header)
			return fail(
				`Unrecognized release intent at ${commit.sha.slice(0, 12)}. ${GUIDANCE}`,
			);
		const type = header[1]?.toLowerCase();
		const paragraphs = commit.message
			.trimEnd()
			.split(/\n\s*\n/)
			.slice(1);
		const footerStart = paragraphs.findIndex((paragraph) =>
			/^(?:BREAKING CHANGE|[\w-]+)(?:: +| #)\S/.test(paragraph),
		);
		const footer =
			footerStart < 0 ? "" : paragraphs.slice(footerStart).join("\n\n");
		const breaking =
			header[2] === "!" || /^BREAKING(?: CHANGE|-CHANGE): +\S/m.test(footer);
		if (breaking) severity = 3;
		else if (type === "feat") severity = Math.max(severity, 2);
		else if (type === "fix" || type === "perf")
			severity = Math.max(severity, 1);
		else if (
			!type ||
			!["docs", "chore", "style", "refactor", "test", "tests", "ci"].includes(
				type,
			)
		)
			return fail(
				`Unsupported release type at ${commit.sha.slice(0, 12)}. ${GUIDANCE}`,
			);
	}
	if (!severity)
		return fail(
			`No release-affecting commits since the previous release. ${GUIDANCE}`,
		);
	// Initial development must not become stable 1.0.0 merely because a commit breaks an API.
	return ok(
		severity === 3 && !current.startsWith("0.")
			? "major"
			: severity >= 2
				? "minor"
				: "patch",
	);
};

const RegistryRelease = z.object({
	name: z.literal("kabane"),
	version: StableReleaseVersionSchema,
	gitHead: z
		.string()
		.regex(/^[a-f0-9]{40}$/)
		.optional(),
});
const CommitSha = z.string().regex(/^[a-f0-9]{40}$/);

const releaseBaseline = async (
	release: z.infer<typeof RegistryRelease>,
	root: string,
	env: NodeJS.ProcessEnv,
): Promise<Result<string>> => {
	const tag = `refs/tags/v${release.version}`;
	const remote = await queryRelease(
		["git", "ls-remote", "origin", tag, `${tag}^{}`],
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
	const remoteCommit = refs.get(`${tag}^{}`) ?? refs.get(tag);
	const local = await queryRelease(
		["git", "rev-parse", "--verify", `${tag}^{commit}`],
		root,
		env,
	);
	if (local.ok && remoteCommit && local.value !== remoteCommit)
		return fail(`Previous release tags disagree. ${GUIDANCE}`);
	if (!local.ok && remoteCommit) {
		const fetched = await queryRelease(
			["git", "fetch", "--no-tags", "origin", `${tag}:${tag}`],
			root,
			env,
		);
		if (!fetched.ok) return fetched;
	}
	const baseline = remoteCommit ?? release.gitHead;
	if (
		!baseline ||
		!CommitSha.safeParse(baseline).success ||
		(release.gitHead && release.gitHead !== baseline) ||
		(local.ok && local.value !== baseline)
	)
		return fail(
			`No consistent previous release tag/gitHead baseline. ${GUIDANCE}`,
		);
	const ancestor = await queryRelease(
		["git", "merge-base", "--is-ancestor", baseline, "HEAD"],
		root,
		env,
	);
	if (!ancestor.ok)
		return fail(
			`Previous release history is missing or not an ancestor; fetch/integrate it deliberately. ${GUIDANCE}`,
		);
	const manifest = await queryRelease(
		["git", "show", `${baseline}:packages/cli/package.json`],
		root,
		env,
	);
	if (!manifest.ok) return manifest;
	try {
		const source = z
			.object({
				name: z.literal("kabane"),
				version: z.literal(release.version),
			})
			.safeParse(JSON.parse(manifest.value));
		return source.success
			? ok(baseline)
			: fail(
					`Previous release baseline has a different CLI version. ${GUIDANCE}`,
				);
	} catch {
		return fail(
			`Previous release baseline has an invalid CLI manifest. ${GUIDANCE}`,
		);
	}
};

const releaseCommits = async (
	baseline: string,
	root: string,
	env: NodeJS.ProcessEnv,
): Promise<Result<Commit[]>> => {
	const shallow = await queryRelease(
		["git", "rev-parse", "--is-shallow-repository"],
		root,
		env,
	);
	if (!shallow.ok) return shallow;
	if (shallow.value !== "false")
		return fail(
			`Auto needs complete release history; fetch/unshallow deliberately. ${GUIDANCE}`,
		);
	const log = await queryRelease(
		[
			"git",
			"log",
			"--max-count=1001",
			"--format=%H%x00%B%x00",
			`${baseline}..HEAD`,
		],
		root,
		env,
	);
	if (!log.ok) return log;
	if (!log.value) return ok([]);
	const fields = log.value.split("\0");
	if (fields.pop() !== "" || fields.length % 2 !== 0)
		return fail("Invalid bounded release commit history.");
	const commits: Commit[] = [];
	for (let index = 0; index < fields.length; index += 2) {
		const sha = CommitSha.safeParse(fields[index]?.trim());
		const message = fields[index + 1];
		if (!sha.success || !message)
			return fail("Invalid bounded release commit record.");
		commits.push({ sha: sha.data, message });
	}
	return ok(commits);
};

export const selectReleaseVersion = async (
	selector: SemanticBump | "auto",
	root: string,
	env: NodeJS.ProcessEnv,
): Promise<Result<string>> => {
	try {
		const latest = await queryRelease(
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
		const version = StableReleaseVersionSchema.safeParse(
			JSON.parse(latest.value),
		);
		if (!version.success)
			return fail("npm latest is not a safe stable version.");
		if (selector !== "auto") return bumpReleaseVersion(version.data, selector);
		const metadata = await queryRelease(
			[
				"npm",
				"view",
				`kabane@${version.data}`,
				"--json",
				"--registry",
				"https://registry.npmjs.org/",
			],
			root,
			env,
		);
		if (!metadata.ok) return metadata;
		const release = RegistryRelease.safeParse(JSON.parse(metadata.value));
		if (!release.success || release.data.version !== version.data)
			return fail(`Invalid previous npm release metadata. ${GUIDANCE}`);
		const baseline = await releaseBaseline(release.data, root, env);
		if (!baseline.ok) return baseline;
		const commits = await releaseCommits(baseline.value, root, env);
		if (!commits.ok) return commits;
		const inferred = inferReleaseBump(version.data, commits.value);
		return inferred.ok
			? bumpReleaseVersion(version.data, inferred.value)
			: inferred;
	} catch {
		return fail(
			`Could not read previous release metadata/history. ${GUIDANCE}`,
		);
	}
};
