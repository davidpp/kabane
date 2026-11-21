import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { runUpdateProcess } from "../packages/cli/src/update-process";
import {
	ChannelVersionSchema,
	compareVersions,
} from "../packages/cli/src/update-version";
import { err, ok, type Result } from "../packages/core/result";
import { readArtifactFile } from "./release-artifact";
import { readHighestStableRelease } from "./release-github";
import {
	queryRelease as query,
	runReleaseInteractive,
} from "./release-process";
import { SemanticBumpSchema, selectReleaseVersion } from "./release-version";

const ROOT = resolve(import.meta.dir, "..");
const REPOSITORY = "davidpp/kabane";
export const RELEASE_HELP = `Usage: bun run release [--version X.Y.Z[-beta.N] | --bump auto|major|minor|patch] [--notes-file path] [--dry-run]

From a clean main that matches origin: set packages/cli/package.json to the version, run the
gate on that tree, commit it with bun.lock, tag v<version>, push main and the tag, start release.yml
with publish=true on that tag, and watch the run. The run publishes the GitHub release, its
four binaries, the installer and SHA256SUMS, and for a stable version the davidpp/tap formula.
Nothing goes to npm, so no npm login.

--bump defaults to auto: the Conventional Commits since the highest published stable release's
tag. Breaking -> major (minor during 0.x), feat -> minor, fix/perf -> patch; maintenance-only or
unclear history needs an explicit --bump. Auto never selects 1.0.0 during 0.x: pass
--version 1.0.0. --version X.Y.Z-beta.N is the only way to a beta, published as a prerelease.
--notes-file holds the release notes (32KiB at most); without it they list the commits since
the previous release. --dry-run prints every step and any unmet precondition, and runs none.
Human-run only; agents must not run it without --dry-run.`;

const ReleaseArgsSchema = z
	.object({
		version: ChannelVersionSchema.optional(),
		bump: z.enum(["auto", ...SemanticBumpSchema.options]).optional(),
		notesFile: z.string().min(1).optional(),
		dryRun: z.boolean(),
	})
	.strict()
	.refine((args) => !(args.version && args.bump));
type ReleaseArgs = z.infer<typeof ReleaseArgsSchema>;

export const parseReleaseArgs = (argv: string[]): Result<ReleaseArgs> => {
	const values: Record<string, string> = {};
	let dryRun = false;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--dry-run" && !dryRun) {
			dryRun = true;
			continue;
		}
		const value = argv[index + 1];
		if (
			!flag ||
			!value ||
			value.startsWith("--") ||
			!["--version", "--bump", "--notes-file"].includes(flag) ||
			flag in values
		)
			return err(new Error(RELEASE_HELP));
		values[flag] = value;
		index++;
	}
	const parsed = ReleaseArgsSchema.safeParse({
		version: values["--version"],
		bump: values["--bump"],
		notesFile: values["--notes-file"],
		dryRun,
	});
	return parsed.success ? ok(parsed.data) : err(new Error(RELEASE_HELP));
};

/** One step of a release: what it runs, and what it says it does. */
type Step = { say: string; argv: string[] };

/**
 * Every step a release runs, in order, once the version is written to the CLI manifest: the gate
 * runs on that tree, which is the one the tag names. The dispatch names the tag as its ref, so
 * the run publishes exactly the tagged commit.
 */
export const releaseSteps = (version: string, notes: string): Step[] => {
	const tag = `v${version}`;
	return [
		{
			say: "Refresh bun.lock for the new CLI version",
			argv: ["bun", "install", "--lockfile-only", "--ignore-scripts"],
		},
		...["check", "typecheck", "test"].map((gate) => ({
			say: "Run the gate",
			argv: ["bun", "run", gate],
		})),
		{
			say: "Stage the version",
			argv: ["git", "add", "--", "packages/cli/package.json", "bun.lock"],
		},
		{
			say: "Commit it",
			argv: ["git", "commit", "-m", `chore: release kabane ${version}`],
		},
		{
			say: "Tag the release commit",
			argv: ["git", "tag", "-a", tag, "-m", `kabane ${version}`],
		},
		{
			say: "Push main and the tag together",
			argv: [
				"git",
				"push",
				"--atomic",
				"origin",
				"HEAD:refs/heads/main",
				`refs/tags/${tag}`,
			],
		},
		{
			say: "Start the publishing run on the tag",
			argv: [
				"gh",
				"workflow",
				"run",
				"release.yml",
				"--repo",
				REPOSITORY,
				"--ref",
				tag,
				"-f",
				"publish=true",
				"-f",
				`notes=${notes}`,
			],
		},
	];
};

const fail = (message: string): Result<never> => err(new Error(message));
const ORIGINS = [
	"git@github.com:davidpp/kabane.git",
	"https://github.com/davidpp/kabane.git",
	"ssh://git@github.com/davidpp/kabane.git",
];

/** The checkout: clean main at origin's main, with no tag for this version, older than it. */
const sourcePreconditions = async (
	version: string,
	root: string,
	env: NodeJS.ProcessEnv,
): Promise<string[]> => {
	const tag = `v${version}`;
	const [dirty, branch, origin, head, remote, localTag, remoteTag] =
		await Promise.all([
			query(["git", "status", "--porcelain"], root, env),
			query(["git", "branch", "--show-current"], root, env),
			query(["git", "config", "--get", "remote.origin.url"], root, env),
			query(["git", "rev-parse", "HEAD"], root, env),
			query(["git", "ls-remote", "origin", "refs/heads/main"], root, env),
			query(["git", "tag", "--list", tag], root, env),
			query(
				["git", "ls-remote", "--tags", "origin", `refs/tags/${tag}`],
				root,
				env,
			),
		]);
	const source = z
		.object({ version: ChannelVersionSchema })
		.safeParse(
			JSON.parse(readFileSync(join(root, "packages/cli/package.json"), "utf8")),
		);
	const onBranch = branch.ok ? branch.value || "a detached HEAD" : "unknown";
	return [
		[!dirty.ok || dirty.value !== "", "The working tree is not clean."],
		[
			!branch.ok || branch.value !== "main",
			`The checkout is on ${onBranch}, not main.`,
		],
		[
			!origin.ok || !ORIGINS.includes(origin.value),
			`origin is not ${REPOSITORY}.`,
		],
		[
			!head.ok || !remote.ok || remote.value.split("\t")[0] !== head.value,
			"HEAD is not origin's main; pull or push first.",
		],
		[
			!localTag.ok ||
				localTag.value !== "" ||
				!remoteTag.ok ||
				remoteTag.value !== "",
			`Tag ${tag} already exists, here or on origin.`,
		],
		[
			!source.success || compareVersions(version, source.data.version) <= 0,
			`${version} is not newer than the source's ${source.success ? source.data.version : "version"}.`,
		],
	]
		.filter(([unmet]) => unmet)
		.map(([, say]) => String(say));
};

/** GitHub: the version passes the published releases, immutability is on, the environment exists. */
const githubPreconditions = async (
	version: string,
	root: string,
	env: NodeJS.ProcessEnv,
): Promise<string[]> => {
	const unmet: string[] = [];
	const published = await readHighestStableRelease((endpoint) =>
		runUpdateProcess(["gh", "api", "--include", endpoint], root, env, 30_000),
	);
	if (!published.ok)
		unmet.push(`Cannot read the GitHub releases: ${published.error.message}`);
	else if (
		published.value !== null &&
		compareVersions(version, published.value) <= 0
	)
		unmet.push(`${version} does not pass the published ${published.value}.`);
	const immutable = await query(
		["gh", "api", `repos/${REPOSITORY}/immutable-releases`, "--jq", ".enabled"],
		root,
		env,
	);
	if (!immutable.ok || immutable.value !== "true")
		unmet.push(
			`Release immutability is not enabled: gh api --method PUT repos/${REPOSITORY}/immutable-releases.`,
		);
	// A job naming a missing environment creates it, unprotected and without the tap's key.
	const environment = await query(
		["gh", "api", `repos/${REPOSITORY}/environments/release`, "--jq", ".name"],
		root,
		env,
	);
	if (!environment.ok || environment.value !== "release")
		unmet.push(
			`The release environment does not exist on ${REPOSITORY} (docs/release.md, "One-time setup").`,
		);
	return unmet;
};

const NOTED = /^(?:feat|fix|perf)(?:\([^()]+\))?!?: +\S/i;
const NOTES_LINES = 60;

/**
 * Notes drafted from history: the feat, fix and perf subjects since the previous tag, at most
 * NOTES_LINES of them, with the compare view for the rest. Pass --notes-file for reviewed notes.
 */
export const draftNotes = (
	version: string,
	previous: string | null,
	subjects: string[],
): string => {
	const noted = subjects.filter((subject) => NOTED.test(subject));
	const shown = noted.slice(0, NOTES_LINES).map((subject) => `- ${subject}`);
	const more = noted.length - shown.length;
	const compare = previous
		? `https://github.com/${REPOSITORY}/compare/${previous}...v${version}`
		: null;
	return [
		`# kabane ${version}`,
		"",
		previous ? `Changes since ${previous}:` : "Changes:",
		"",
		...shown,
		...(more > 0 ? [`- and ${more} more`] : []),
		...(compare ? ["", `Every commit: ${compare}`] : []),
		"",
		"Read compatibility notes and restart board/MCP sessions after upgrading. Executable rollback is not database rollback.",
		"",
	].join("\n");
};

const releaseNotes = async (
	version: string,
	notesFile: string | undefined,
	root: string,
	env: NodeJS.ProcessEnv,
): Promise<Result<string>> => {
	if (notesFile) {
		const read = readArtifactFile(resolve(notesFile), 32_768);
		return read.ok ? ok(read.value.toString()) : read;
	}
	const previous = await query(
		["git", "describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"],
		root,
		env,
	);
	const history = await query(
		[
			"git",
			"log",
			"--format=%s",
			...(previous.ok ? [`${previous.value}..HEAD`] : ["-200"]),
		],
		root,
		env,
	);
	if (!history.ok) return history;
	return ok(
		draftNotes(
			version,
			previous.ok ? previous.value : null,
			history.value.split("\n"),
		),
	);
};

/** The dispatch run for the tag's commit: the pushed tag also starts a nonpublishing run. */
const findDispatchRun = async (
	commit: string,
	root: string,
	env: NodeJS.ProcessEnv,
): Promise<Result<{ id: number; url: string }>> => {
	const Runs = z.array(z.object({ databaseId: z.number(), url: z.string() }));
	for (let attempt = 0; attempt < 12; attempt++) {
		if (attempt > 0) await Bun.sleep(5_000);
		const listed = await query(
			[
				"gh",
				"run",
				"list",
				"--repo",
				REPOSITORY,
				"--workflow",
				"release.yml",
				"--event",
				"workflow_dispatch",
				"--commit",
				commit,
				"--json",
				"databaseId,url",
				"--limit",
				"1",
			],
			root,
			env,
		);
		const runs = listed.ok ? Runs.safeParse(JSON.parse(listed.value)) : null;
		const run = runs?.success ? runs.data[0] : undefined;
		if (run) return ok({ id: run.databaseId, url: run.url });
	}
	return fail(
		`The dispatch was accepted but its run did not appear within a minute; find it with gh run list --repo ${REPOSITORY} --workflow release.yml --event workflow_dispatch.`,
	);
};

const printPlan = (
	{
		version,
		steps,
		notes,
		unmet,
		root,
	}: {
		version: string;
		steps: Step[];
		notes: string;
		unmet: string[];
		root: string;
	},
	print: (line: string) => void,
): Result<string> => {
	print(`kabane ${version}, from ${root}. A real run would:`);
	print(`  Set packages/cli/package.json to ${version}`);
	for (const step of steps)
		print(
			`  ${step.say}: ${step.argv
				.map((arg) =>
					arg.startsWith("notes=")
						? "notes=<the release notes below>"
						: /[\s"']/.test(arg)
							? JSON.stringify(arg)
							: arg,
				)
				.join(" ")}`,
		);
	print("  Watch that run: gh run watch <its id> --exit-status");
	print(`Release notes:\n${notes}`);
	if (!unmet.length) return ok("Dry run: nothing was run.");
	print("It would stop before any write, because:");
	for (const line of unmet) print(`  - ${line}`);
	return fail("Dry run: preconditions unmet; nothing was run.");
};

/** The version, its gate, commit, tag, push and dispatch, stopping at the first failure. */
const cutRelease = async (
	version: string,
	steps: Step[],
	root: string,
	env: NodeJS.ProcessEnv,
): Promise<Result<void>> => {
	const manifest = join(root, "packages/cli/package.json");
	const source = JSON.parse(readFileSync(manifest, "utf8")) as Record<
		string,
		unknown
	>;
	writeFileSync(
		manifest,
		`${JSON.stringify({ ...source, version }, null, "\t")}\n`,
	);
	for (const step of steps) {
		const argv =
			step.argv[0] === "bun"
				? [process.execPath, ...step.argv.slice(1)]
				: step.argv;
		const ran = await runReleaseInteractive(argv, root, env);
		if (!ran.ok)
			return fail(
				`${ran.error.message}\nStopped at: ${step.argv.join(" ")}. Earlier steps stay done; inspect git and GitHub before rerunning.`,
			);
	}
	return ok(undefined);
};

/** Finds the publishing run the dispatch started and watches it to its end. */
const watchRelease = async (
	version: string,
	root: string,
	env: NodeJS.ProcessEnv,
	print: (line: string) => void,
): Promise<Result<string>> => {
	const commit = await query(["git", "rev-parse", "HEAD"], root, env);
	if (!commit.ok) return commit;
	const run = await findDispatchRun(commit.value, root, env);
	if (!run.ok) return run;
	print(`Publishing run: ${run.value.url}`);
	const watched = await runReleaseInteractive(
		[
			"gh",
			"run",
			"watch",
			String(run.value.id),
			"--repo",
			REPOSITORY,
			"--exit-status",
		],
		root,
		env,
	);
	return watched.ok
		? ok(
				`kabane ${version} is published: https://github.com/${REPOSITORY}/releases/tag/v${version}`,
			)
		: fail(
				`The publishing run failed: ${run.value.url}. The tag and main are pushed; fix and rerun that run, or release the next version.`,
			);
};

export const runRelease = async (
	args: ReleaseArgs,
	root = ROOT,
	env: NodeJS.ProcessEnv = process.env,
	print: (line: string) => void = console.log,
): Promise<Result<string>> => {
	if (env.GITHUB_ACTIONS === "true")
		return fail(
			"bun run release is human-run; CI publishes through its dispatch.",
		);
	const selected = args.version
		? ok(args.version)
		: await selectReleaseVersion(args.bump ?? "auto", root, env);
	if (!selected.ok) return selected;
	const version = selected.value;
	const notes = await releaseNotes(version, args.notesFile, root, env);
	if (!notes.ok) return notes;
	if (Buffer.byteLength(notes.value) > 32_768)
		return fail("Release notes exceed 32KiB.");
	const unmet = [
		...(await sourcePreconditions(version, root, env)),
		...(await githubPreconditions(version, root, env)),
	];
	const steps = releaseSteps(version, notes.value);
	if (args.dryRun)
		return printPlan(
			{ version, steps, notes: notes.value, unmet, root },
			print,
		);
	if (unmet.length)
		return fail(`Nothing was changed, because:\n  - ${unmet.join("\n  - ")}`);
	const cut = await cutRelease(version, steps, root, env);
	return cut.ok ? watchRelease(version, root, env, print) : cut;
};

if (import.meta.main) {
	const argv = process.argv.slice(2);
	if (argv.length === 1 && argv[0] === "--help") console.log(RELEASE_HELP);
	else {
		const parsed = parseReleaseArgs(argv);
		const result = parsed.ok ? await runRelease(parsed.value) : parsed;
		if (result.ok) console.log(result.value);
		else {
			console.error(result.error.message);
			process.exitCode = parsed.ok ? 1 : 2;
		}
	}
}
