// Landing a run's branch with real git: the project's remote is a bare repository on disk, so
// fetch, rebase and push are git's own, and a teammate's clone of it moves the base meanwhile.
// Only git's config is the fixture's (an identity, no signing), as in every test. GitHub is the
// one thing not real: `gh` goes through the runner's port, here a recorder that answers as gh
// does, so no test reaches a GitHub repository.
import "@cabane/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, Planner, type Task, trySync } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { Loop } from "./commands";
import { LoopConfig } from "./config";
import { Land } from "./land";
import { LoopPlan } from "./plan";
import { Runner } from "./runner";
import type { RunState } from "./state";
import { Steering } from "./steering";
import { RunStore } from "./store";
import { Worktree } from "./worktree";

let root = "";
let home = "";
let remote = "";
let repo = "";
let teammate = "";

const git: Worktree.Git = async (cwd, args) =>
	trySync(() => GitFixture.run(cwd, args));

const PR_URL = "https://github.com/acme/widget/pull/7";

// What each test's gh was asked, and how it answers: `pr view` finds no pull request until one
// is open, as gh does for a branch that has none, and `pr create` prints the new one's URL.
let ghCalls: string[][] = [];
let openPr: string | undefined;
let ghFails: string | undefined;
const gh: Land.Gh = async (_cwd, args) => {
	ghCalls.push(args);
	if (ghFails) return err(new Error(ghFails));
	if (args[0] === "pr" && args[1] === "view")
		return openPr
			? ok(JSON.stringify({ url: openPr, state: "OPEN" }))
			: err(new Error(`no pull requests found for branch "${args[2]}"`));
	if (args[0] === "pr" && args[1] === "create") {
		openPr = PR_URL;
		return ok(`Creating pull request\n${PR_URL}\n`);
	}
	return err(new Error(`unexpected gh ${args.join(" ")}`));
};

const BRANCH = "jcab-1-make-the-thing";
const remoteTip = (): string =>
	GitFixture.run(remote, ["rev-parse", `refs/heads/${BRANCH}`]).trim();
const head = (dir: string, rev = "HEAD"): string =>
	GitFixture.run(dir, ["rev-parse", rev]).trim();

const commit = (dir: string, file: string, text = `${file}\n`): void => {
	writeFileSync(join(dir, file), text);
	GitFixture.run(dir, ["add", "-A"]);
	GitFixture.run(dir, ["commit", "-q", "-m", file]);
};

// A teammate's commit on the remote's main, which the project's checkout has not fetched.
const baseMoves = (file: string, text?: string): void => {
	GitFixture.run(teammate, ["pull", "-q", "--ff-only"]);
	commit(teammate, file, text);
	GitFixture.run(teammate, ["push", "-q", "origin", "main"]);
};

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "loop-land-"));
	home = join(root, "home");
	remote = join(root, "remote.git");
	repo = join(root, "repo");
	teammate = join(root, "teammate");
	mkdirSync(home);
	GitFixture.run(root, ["init", "-q", "--bare", remote]);
	GitFixture.run(root, ["clone", "-q", remote, repo]);
	commit(repo, "README.md", "# fixture\n");
	GitFixture.run(repo, ["push", "-q", "-u", "origin", "main"]);
	GitFixture.run(root, ["clone", "-q", remote, teammate]);
	ghCalls = [];
	openPr = undefined;
	ghFails = undefined;
	await Planner.init(home);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const parentIssue = async (): Promise<Task> => {
	const created = await Planner.addTask(home, {
		title: "Make the thing",
		kind: "issue",
		state: "in_progress",
		description: "The brief.",
	});
	if (!created.ok) throw created.error;
	return created.value;
};

// A completed run on `parent` as `Loop.start` writes it, with the work a session committed in
// its worktree.
const completedRun = async (
	parent: Task,
	config: LoopConfig.Input = {},
): Promise<RunStore.Run> => {
	const parsed = LoopConfig.Schema.safeParse({ land: "pr", ...config });
	if (!parsed.success) throw parsed.error;
	const id = "run-1";
	const dir = Worktree.dirFor(RunStore.paths(home, id).dir);
	const run: RunStore.Run = {
		version: 1,
		id,
		parentId: parent.id,
		parentShortId: parent.shortId ?? parent.id,
		projectDir: repo,
		worktree: dir,
		worktreePrefix: "",
		branch: BRANCH,
		base: { branch: "main", sha: head(repo) },
		config: parsed.data,
		status: "running",
		createdAt: new Date().toISOString(),
		claims: [],
		usage: {},
		continuationsUsed: 0,
		inboxRead: 0,
		steering: Steering.INITIAL,
		gateRuns: [],
	};
	const created = RunStore.create(home, run);
	if (!created.ok) throw created.error;
	const added = await Worktree.add(repo, dir, BRANCH, git);
	if (!added.ok) throw added.error;
	commit(dir, "work.txt");
	return run;
};

const ctxFor = (run: RunStore.Run): RunState.Ctx => {
	const log = RunStore.eventLog(home, run.id);
	if (!log.ok) throw log.error;
	return {
		deps: {
			home,
			basePath: home,
			kabaneBin: "/nonexistent/kabane",
			pid: process.pid,
			git,
			gh,
		},
		now: () => new Date(),
		tree: async (cwd) => head(cwd),
		log: log.value,
		run,
		live: new Map(),
		settled: [],
		wake: () => {},
		stopRequested: false,
		stopping: new AbortController(),
		gating: Promise.resolve(),
	};
};

const landed = async (ctx: RunState.Ctx): Promise<RunStore.Landing> => {
	const plan = await LoopPlan.load(home, ctx.run.parentId);
	if (!plan.ok) throw plan.error;
	return Land.land(ctx, plan.value);
};

describe("Land.land onto the base", () => {
	it("leaves a branch already on the base's latest commit as it is, and runs no gate", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(
			await completedRun(parent, { gates: { test: "exit 1" } }),
		);
		const tip = head(ctx.run.worktree ?? "");

		const landing = await landed(ctx);

		expect(landing.ok).toBe(true);
		expect(landing.summary).toContain("The branch is on origin/main");
		expect(landing.rebased).toBeUndefined();
		expect(head(ctx.run.worktree ?? "")).toBe(tip);
		expect(ctx.run.gateRuns).toEqual([]);
		const saved = RunStore.read(home, ctx.run.id);
		expect(saved.ok && saved.value.landing).toEqual(landing);
	});

	it("rebases onto a base that moved during the run and gates the rebased branch", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(
			await completedRun(parent, {
				gates: { both: "test -f work.txt && test -f teammate.txt" },
			}),
		);
		const dir = ctx.run.worktree ?? "";
		const before = head(dir);
		const checkout = head(repo);
		baseMoves("teammate.txt");

		const landing = await landed(ctx);

		expect(landing.ok).toBe(true);
		expect(landing.summary).toContain("Rebased onto origin/main");
		expect(landing.rebased).toEqual({ from: before, to: head(dir) });
		expect(existsSync(join(dir, "teammate.txt"))).toBe(true);
		// The gate ran on the rebased branch, and passed.
		expect(ctx.run.gateRuns.map((g) => [g.ok, g.tree])).toEqual([
			[true, head(dir)],
		]);
		// The user's own checkout is not touched.
		expect(head(repo)).toBe(checkout);
	});

	it("does not land a rebase that conflicts, and leaves the branch as the run left it", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(await completedRun(parent));
		const dir = ctx.run.worktree ?? "";
		commit(dir, "README.md", "# ours\n");
		const before = head(dir);
		baseMoves("README.md", "# theirs\n");

		const landing = await landed(ctx);

		expect(landing.ok).toBe(false);
		expect(landing.summary).toContain("conflicts in README.md");
		expect(head(dir)).toBe(before);
		expect(GitFixture.run(dir, ["status", "--porcelain"]).trim()).toBe("");
		const events = RunStore.readEvents(home, ctx.run.id);
		expect(
			events.ok && events.value.map((e) => [e.type, e.summary]).at(-1),
		).toEqual(["warning", landing.summary]);
	});

	it("does not land a rebased branch whose gates are red, and puts the branch back", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(
			await completedRun(parent, {
				gates: { alone: "test ! -f teammate.txt" },
			}),
		);
		const dir = ctx.run.worktree ?? "";
		const before = head(dir);
		baseMoves("teammate.txt");

		const landing = await landed(ctx);

		expect(landing.ok).toBe(false);
		expect(landing.summary).toContain("the gate alone failed (exit 1)");
		expect(landing.summary).toContain(`back at ${before.slice(0, 12)}`);
		expect(landing.rebased?.from).toBe(before);
		expect(head(dir)).toBe(before);
	});

	it("changes and publishes nothing when the worktree is on a branch that is not the run's", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(await completedRun(parent));
		const dir = ctx.run.worktree ?? "";
		GitFixture.run(dir, ["switch", "-q", "-c", "elsewhere"]);
		commit(dir, "elsewhere.txt");
		const before = head(dir);
		baseMoves("teammate.txt");

		const landing = await landed(ctx);

		expect(landing.ok).toBe(false);
		expect(landing.summary).toContain(
			`the worktree is on branch elsewhere, not the run's branch ${BRANCH}; nothing was changed`,
		);
		expect(head(dir)).toBe(before);
		expect(
			GitFixture.run(remote, ["for-each-ref", "refs/heads"]).trim().split("\n"),
		).toHaveLength(1);
		expect(ghCalls).toEqual([]);
	});

	it("does not push when the run is stopped while it fetches, and puts the rebased branch back", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(await completedRun(parent, { gates: { test: "true" } }));
		const dir = ctx.run.worktree ?? "";
		const before = head(dir);
		baseMoves("teammate.txt");
		// The stop arrives while git fetches, as `kabane loop stop` aborts a landing runner.
		ctx.deps.git = async (cwd, args) => {
			if (args[0] === "fetch") {
				ctx.stopRequested = true;
				ctx.stopping.abort();
			}
			return git(cwd, args);
		};

		const landing = await landed(ctx);

		expect(landing.ok).toBe(false);
		expect(landing.summary).toContain(
			"the run was stopped before its gates passed again",
		);
		expect(head(dir)).toBe(before);
		expect(
			GitFixture.run(remote, ["for-each-ref", "refs/heads"]).trim().split("\n"),
		).toHaveLength(1);
		expect(ghCalls).toEqual([]);
	});

	it("opens no pull request when the run is stopped while it pushes", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(await completedRun(parent));
		ctx.deps.git = async (cwd, args) => {
			const ran = await git(cwd, args);
			if (args[0] === "push") ctx.stopping.abort();
			return ran;
		};

		const landing = await landed(ctx);

		expect(landing.ok).toBe(false);
		expect(landing.summary).toContain(
			"stopped once branch jcab-1-make-the-thing was pushed, before a pull request was opened",
		);
		expect(ctx.run.pushed).toBe(remoteTip());
		expect(ghCalls).toEqual([]);
	});

	it("does not land a run that started from a detached HEAD", async () => {
		const parent = await parentIssue();
		const run = await completedRun(parent);
		const ctx = ctxFor({ ...run, base: { sha: run.base?.sha ?? "" } });

		const landing = await landed(ctx);

		expect(landing).toMatchObject({ ok: false });
		expect(landing.summary).toContain("detached HEAD");
	});
});

describe("Land.land to a pull request", () => {
	it("pushes the branch to the base's remote and opens a pull request against the base", async () => {
		const parent = await parentIssue();
		const finding = await Planner.addTask(home, {
			title: "Name the flag",
			kind: "issue",
			state: "done",
			parentTaskId: parent.id,
			tags: ["finding", "p2", "quality"],
		});
		if (!finding.ok) throw finding.error;
		const ctx = ctxFor(
			await completedRun(parent, {
				gates: { test: "true" },
				lenses: ["quality"],
			}),
		);
		ctx.run = {
			...ctx.run,
			gateRuns: [
				{
					at: new Date().toISOString(),
					results: [
						{
							name: "test",
							command: "true",
							ok: true,
							exit: 0,
							ms: 1200,
							tail: "",
						},
					],
					ok: true,
					tree: "tree",
				},
			],
		};

		const landing = await landed(ctx);

		expect(landing.ok).toBe(true);
		expect(landing.summary).toContain(`pull request ${PR_URL} is open`);
		expect(remoteTip()).toBe(head(ctx.run.worktree ?? ""));
		expect(ctx.run.pushed).toBe(remoteTip());
		expect(ctx.run.pr).toBe(PR_URL);
		const saved = RunStore.read(home, ctx.run.id);
		expect(saved.ok && saved.value.pr).toBe(PR_URL);
		const [view, create] = ghCalls;
		expect(view).toEqual(["pr", "view", BRANCH, "--json", "url,state"]);
		expect(create?.slice(0, 8)).toEqual([
			"pr",
			"create",
			"--base",
			"main",
			"--head",
			BRANCH,
			"--title",
			"Make the thing",
		]);
		const body = create?.[9] ?? "";
		expect(body).toStartWith("The brief.\n\n## Gates\n\n- test passed in");
		expect(body).toContain(
			`## Lens findings\n\n- ${finding.value.shortId} (p2, quality): Name the flag [done]`,
		);
		expect(body).toContain("kabane loop run `run-1`");
	});

	it("pushes a branch rebased again to the pull request already open for it, opening none", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(await completedRun(parent));
		expect((await landed(ctx)).ok).toBe(true);
		const first = remoteTip();
		// A later run's work, on a base that moved meanwhile: the branch's history is rewritten.
		commit(ctx.run.worktree ?? "", "review-fix.txt");
		baseMoves("teammate.txt");
		ghCalls = [];

		const again = await landed(ctx);

		expect(again.ok).toBe(true);
		expect(again.rebased).toBeDefined();
		expect(remoteTip()).toBe(head(ctx.run.worktree ?? ""));
		expect(remoteTip()).not.toBe(first);
		expect(ghCalls).toEqual([["pr", "view", BRANCH, "--json", "url,state"]]);
	});

	it("does not overwrite a commit someone else pushed to the branch", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(await completedRun(parent));
		expect((await landed(ctx)).ok).toBe(true);
		// A reviewer pushes a commit of their own to the pull request's branch.
		GitFixture.run(teammate, ["fetch", "-q", "origin", BRANCH]);
		GitFixture.run(teammate, ["checkout", "-q", "-b", BRANCH, "FETCH_HEAD"]);
		commit(teammate, "reviewer.txt");
		GitFixture.run(teammate, ["push", "-q", "origin", BRANCH]);
		const theirs = remoteTip();
		const ours = ctx.run.pushed;
		// The run's work goes on without it, and a fetch in the user's checkout, which shares the
		// worktree's refs, moves the remote-tracking branch onto the reviewer's commit: a lease on
		// that ref would now let the push through.
		commit(ctx.run.worktree ?? "", "review-fix.txt");
		GitFixture.run(repo, ["fetch", "-q", "origin"]);
		expect(head(repo, `refs/remotes/origin/${BRANCH}`)).toBe(theirs);

		const again = await landed(ctx);

		expect(again.ok).toBe(false);
		expect(again.summary).toContain("git push");
		expect(again.summary).toContain(
			`the run last pushed ${ours?.slice(0, 12)}`,
		);
		expect(remoteTip()).toBe(theirs);
		expect(ctx.run.pushed).toBe(ours);
	});

	it("does not overwrite a branch of the same name it never pushed", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(await completedRun(parent));
		GitFixture.run(teammate, ["checkout", "-q", "-b", BRANCH]);
		commit(teammate, "someone-else.txt");
		GitFixture.run(teammate, ["push", "-q", "origin", BRANCH]);
		const theirs = remoteTip();
		GitFixture.run(repo, ["fetch", "-q", "origin"]);

		const landing = await landed(ctx);

		expect(landing.ok).toBe(false);
		expect(remoteTip()).toBe(theirs);
		expect(ghCalls).toEqual([]);
	});

	it("reports a push that fails, and opens no pull request", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(await completedRun(parent));
		rmSync(remote, { recursive: true, force: true });

		const landing = await landed(ctx);

		expect(landing.ok).toBe(false);
		expect(landing.summary).toStartWith("Not landed: git fetch");
		expect(ghCalls).toEqual([]);
		expect(ctx.run.pr).toBeUndefined();
	});

	it("reports a gh that fails once the branch is pushed", async () => {
		const parent = await parentIssue();
		const ctx = ctxFor(await completedRun(parent));
		ghFails = "gh: To get started with GitHub CLI, please run: gh auth login";

		const landing = await landed(ctx);

		expect(landing.ok).toBe(false);
		expect(landing.summary).toContain(
			`branch ${BRANCH} is pushed, but no pull request was opened: gh: To get started`,
		);
		expect(remoteTip()).toBe(head(ctx.run.worktree ?? ""));
		expect(ctx.run.pr).toBeUndefined();
	});
});

describe("a run with land: pr, through the real runner", () => {
	it("completes on its gates, lands its branch, and leaves its parent waiting on the pull request", async () => {
		const parent = await parentIssue();
		const child = await Planner.addTask(home, {
			title: "the work",
			kind: "issue",
			state: "done",
			parentTaskId: parent.id,
		});
		if (!child.ok) throw child.error;
		const run = await completedRun(parent, { gates: { test: "true" } });
		const pending = RunStore.write(home, { ...run, status: "pending" });
		if (!pending.ok) throw pending.error;
		baseMoves("teammate.txt");

		const ran = await Runner.run(run.id, {
			home,
			basePath: home,
			kabaneBin: "/nonexistent/kabane",
			pid: process.pid,
			git,
			gh,
			tickMs: 10,
		});

		if (!ran.ok) throw ran.error;
		expect(ran.value).toMatchObject({ status: "completed", pr: PR_URL });
		expect(ran.value.landing?.rebased).toBeDefined();
		expect(remoteTip()).toBe(head(run.worktree ?? ""));
		const after = await Planner.getTask(home, parent.id);
		expect(after.ok && after.value).toMatchObject({
			state: "waiting",
			needsReview: true,
		});
		const comments = await Planner.getComments(home, parent.id);
		expect(comments.ok && comments.value.at(-1)?.content).toContain(
			`pull request ${PR_URL} is open. ${parent.shortId} waits on its review.`,
		);
		const links = await Planner.getUpstreamLinksForTask(home, parent.id);
		expect(links.ok && links.value).toMatchObject([
			{ provider: "github", identifier: "acme/widget#7", url: PR_URL },
		]);
	});

	it("completes with the landing's failure on its parent when the push fails", async () => {
		const parent = await parentIssue();
		const child = await Planner.addTask(home, {
			title: "the work",
			kind: "issue",
			state: "done",
			parentTaskId: parent.id,
		});
		if (!child.ok) throw child.error;
		const run = await completedRun(parent, { gates: { test: "true" } });
		const pending = RunStore.write(home, { ...run, status: "pending" });
		if (!pending.ok) throw pending.error;
		rmSync(remote, { recursive: true, force: true });

		const ran = await Runner.run(run.id, {
			home,
			basePath: home,
			kabaneBin: "/nonexistent/kabane",
			pid: process.pid,
			git,
			gh,
			tickMs: 10,
		});

		if (!ran.ok) throw ran.error;
		expect(ran.value.status).toBe("completed");
		expect(ran.value.landing?.ok).toBe(false);
		const after = await Planner.getTask(home, parent.id);
		expect(after.ok && after.value?.state).toBe("in_progress");
		const comments = await Planner.getComments(home, parent.id);
		const said = comments.ok ? (comments.value.at(-1)?.content ?? "") : "";
		expect(said).toContain("Not landed: git fetch");
		expect(said).toContain(`Merge branch \`${BRANCH}\``);
	});
});

describe("Loop.land", () => {
	const landDeps = () => ({
		home,
		basePath: home,
		kabaneBin: "/nonexistent/kabane",
		git,
		gh,
	});

	const completed = async (
		parent: Task,
		config: LoopConfig.Input = {},
	): Promise<RunStore.Run> => {
		const run = await completedRun(parent, config);
		const written = RunStore.write(home, {
			...run,
			status: "completed",
			exit: { reason: "plan-done" },
		});
		if (!written.ok) throw written.error;
		return written.value;
	};

	it("lands a run whose landing failed once the cause is fixed, and its parent waits on the pull request", async () => {
		const parent = await parentIssue();
		const run = await completed(parent);
		ghFails = "gh: To get started with GitHub CLI, please run: gh auth login";
		const first = await Loop.land(landDeps(), run.id);
		expect(first.ok && first.value.landing?.ok).toBe(false);
		ghFails = undefined;

		const again = await Loop.land(landDeps(), run.id);

		if (!again.ok) throw again.error;
		expect(again.value).toMatchObject({ pr: PR_URL, landing: { ok: true } });
		const saved = RunStore.read(home, run.id);
		expect(saved.ok && saved.value.pr).toBe(PR_URL);
		const after = await Planner.getTask(home, parent.id);
		expect(after.ok && after.value).toMatchObject({
			state: "waiting",
			needsReview: true,
		});
		const comments = await Planner.getComments(home, parent.id);
		const said = comments.ok ? comments.value.map((c) => c.content) : [];
		expect(said[0]).toContain("gh auth login");
		expect(said[0]).toContain("`kabane loop land run-1` tries again");
		expect(said[1]).toStartWith("`kabane loop land run-1`:");
		expect(said[1]).toContain(`pull request ${PR_URL} is open`);
		const links = await Planner.getUpstreamLinksForTask(home, parent.id);
		expect(links.ok && links.value.map((l) => l.url)).toEqual([PR_URL]);
	});

	it("lands a run whose setting does not land it, by hand", async () => {
		const parent = await parentIssue();
		const run = await completed(parent, { land: "none" });

		const landed = await Loop.land(landDeps(), run.id);

		expect(landed.ok && landed.value.landing?.ok).toBe(true);
		expect(remoteTip()).toBe(head(run.worktree ?? ""));
	});

	it("refuses a run that is not completed, and one with no worktree of its own", async () => {
		const parent = await parentIssue();
		const run = await completedRun(parent);
		const stopped = RunStore.write(home, {
			...run,
			status: "stopped",
			exit: { reason: "gates-red" },
		});
		if (!stopped.ok) throw stopped.error;
		const refused = await Loop.land(landDeps(), run.id);
		expect(!refused.ok && refused.error.message).toBe(
			"Run run-1 is stopped: only a completed run, whose work its gates passed, lands",
		);
		const inPlace = RunStore.write(home, {
			...run,
			status: "completed",
			worktree: undefined,
		});
		if (!inPlace.ok) throw inPlace.error;
		const none = await Loop.land(landDeps(), run.id);
		expect(!none.ok && none.error.message).toContain(
			"no branch of its own to land",
		);
		expect(ghCalls).toEqual([]);
	});
});
