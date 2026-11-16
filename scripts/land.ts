// This repo's landing policy, one task for every caller: a branch lands as a pull request that
// GitHub merges once the required `gate` check passes. The loop runs it as its `onLanded` hook,
// after its own push and PR; dispatch runs it from the main checkout for each finished branch.
// It runs the user's own git and gh and holds no credentials. Running it again is safe: a loop
// retry runs `onLanded` again, and an existing PR is found rather than opened twice.
import { z } from "zod";
import { err, ok, type Result } from "../packages/core/result";

const BASE = "main";
export const LAND_HELP = `Usage: bun run land [branch] [--dry-run] [-- <gh pr create args>]

Lands one branch as a pull request against ${BASE} that merges itself once its checks pass.
branch:    the argument, else $KABANE_BRANCH, else the current branch. Never ${BASE}.
PR:        $KABANE_PR, else the branch's PR. Without $KABANE_PR, push the branch
           (--force-with-lease); with no PR open, open one with the args after --,
           or --fill.
Then:      gh pr merge --auto --merge, and print the PR URL.
--dry-run: print the git and gh commands that change something instead of running them.
KABANE_LAND=merge (a loop run that merged locally): do nothing.`;

type Args = { branch?: string; dryRun: boolean; create: string[] };

export const parseLandArgs = (argv: string[]): Result<Args> => {
	const split = argv.indexOf("--");
	const own = split < 0 ? argv : argv.slice(0, split);
	const create = split < 0 ? [] : argv.slice(split + 1);
	const flags = own.filter((arg) => arg.startsWith("-"));
	const positional = own.filter((arg) => !arg.startsWith("-"));
	const unknown = flags.find((flag) => flag !== "--dry-run");
	if (unknown !== undefined || positional.length > 1)
		return err(
			new Error(
				`${unknown === undefined ? "More than one branch" : `Unknown option ${unknown}`}.\n${LAND_HELP}`,
			),
		);
	return ok({
		...(positional[0] === undefined ? {} : { branch: positional[0] }),
		dryRun: flags.length > 0,
		create,
	});
};

/** The branch to land: the argument, else the loop's, else the checkout's; `null` is a detached HEAD. */
export const resolveBranch = (
	arg: string | undefined,
	env: NodeJS.ProcessEnv,
	current: () => string | null,
): Result<string> => {
	const branch = arg ?? (env.KABANE_BRANCH || undefined) ?? current();
	if (branch === null)
		return err(
			new Error(
				"HEAD is detached: name the branch to land, as bun run land <branch>.",
			),
		);
	if (branch === BASE)
		return err(
			new Error(
				`Refusing to land ${BASE} onto itself: name a feature branch, as bun run land <branch>.`,
			),
		);
	return ok(branch);
};

type Reply = { code: number; stdout: string; stderr: string };
const spawn = (argv: string[], stderr: "pipe" | "inherit"): Reply => {
	const child = Bun.spawnSync(argv, {
		stdin: "ignore",
		stdout: "pipe",
		stderr,
	});
	return {
		code: child.exitCode,
		stdout: child.stdout.toString().trim(),
		stderr: child.stderr?.toString().trim() ?? "",
	};
};

const currentBranch = (): string | null => {
	const head = spawn(
		["git", "symbolic-ref", "--quiet", "--short", "HEAD"],
		"pipe",
	);
	return head.code === 0 && head.stdout !== "" ? head.stdout : null;
};

const PullRequest = z.object({ url: z.string(), state: z.string() });
type PullRequest = z.infer<typeof PullRequest>;

const parsePullRequest = (stdout: string): PullRequest | null => {
	try {
		const parsed = PullRequest.safeParse(JSON.parse(stdout));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
};

/** The PR `selector` (a URL or a branch) names, or `null` when the branch has none. */
const findPullRequest = (selector: string): Result<PullRequest | null> => {
	const view = spawn(
		["gh", "pr", "view", selector, "--json", "url,state"],
		"pipe",
	);
	if (view.code !== 0)
		return /no pull requests found/i.test(view.stderr)
			? ok(null)
			: err(new Error(`gh pr view ${selector} failed: ${view.stderr}`));
	const pr = parsePullRequest(view.stdout);
	return pr
		? ok(pr)
		: err(new Error(`gh pr view ${selector} returned no url and state.`));
};

export const land = (args: Args, env: NodeJS.ProcessEnv): Result<string> => {
	const branch = resolveBranch(args.branch, env, currentBranch);
	if (!branch.ok) return branch;
	// A command that changes something, run or, on --dry-run, printed.
	const change = (argv: string[]): Result<string> => {
		if (args.dryRun) {
			console.error(`would run: ${argv.join(" ")}`);
			return ok("");
		}
		const ran = spawn(argv, "inherit");
		return ran.code === 0
			? ok(ran.stdout)
			: err(new Error(`${argv.slice(0, 3).join(" ")} failed (${ran.code}).`));
	};
	const found = findPullRequest(env.KABANE_PR || branch.value);
	if (!found.ok) return found;
	if (found.value?.state === "MERGED") return ok(found.value.url);
	// The loop pushed its own branch before it opened KABANE_PR. Anyone else pushes every time,
	// so a branch rebased onto main after its PR opened reaches that PR.
	if (!env.KABANE_PR) {
		const pushed = change([
			"git",
			"push",
			"-u",
			"--force-with-lease",
			"origin",
			branch.value,
		]);
		if (!pushed.ok) return pushed;
	}
	let url = found.value?.state === "OPEN" ? found.value.url : undefined;
	if (url === undefined) {
		const created = change([
			"gh",
			"pr",
			"create",
			"--base",
			BASE,
			"--head",
			branch.value,
			...(args.create.length > 0 ? args.create : ["--fill"]),
		]);
		if (!created.ok) return created;
		// gh pr create prints the new PR's URL as its last line.
		url = created.value.split("\n").at(-1) || `<new PR for ${branch.value}>`;
	}
	const merging = change(["gh", "pr", "merge", url, "--auto", "--merge"]);
	return merging.ok ? ok(url) : merging;
};

if (import.meta.main) {
	const argv = process.argv.slice(2);
	if (argv.length === 1 && argv[0] === "--help") console.log(LAND_HELP);
	// The loop already merged this run's branch into its base: there is no PR to land.
	else if (process.env.KABANE_LAND !== "merge") {
		const parsed = parseLandArgs(argv);
		const result = parsed.ok ? land(parsed.value, process.env) : parsed;
		if (result.ok) console.log(result.value);
		else {
			console.error(result.error.message);
			process.exitCode = parsed.ok ? 1 : 2;
		}
	}
}
