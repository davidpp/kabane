// Whether a parent's next run goes on in its last run's worktree, and what `kabane loop prune`
// removes, with real git: the project's remote is a bare repository on disk, and a squash merge
// is made on it as GitHub makes one, so git calls the merged branch unmerged. What GitHub says of
// the pull request is the one thing not real: `gh` is the start's port, here a recorder.
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
import { detectScope } from "@cabane/core/scope";
import { Settings } from "@cabane/extension";
import { Loop } from "./commands";
import type { Land } from "./land";
import { RunStore } from "./store";
import { Worktree } from "./worktree";

let root = "";
let home = "";
let remote = "";
let repo = "";

const git: Worktree.Git = async (cwd, args) =>
	trySync(() => GitFixture.run(cwd, args));
const head = (dir: string, rev = "HEAD"): string =>
	GitFixture.run(dir, ["rev-parse", rev]).trim();

const PR = "https://github.com/acme/widget/pull/7";

// What GitHub says of the pull request, and what gh was asked.
let prSays: { state: string; headRefOid: string } | undefined;
let ghCalls: string[][] = [];
const gh: Land.Gh = async (_cwd, args) => {
	ghCalls.push(args);
	return prSays
		? ok(JSON.stringify(prSays))
		: err(new Error("gh: could not resolve to a PullRequest"));
};

const commit = (dir: string, file: string): void => {
	writeFileSync(join(dir, file), `${file}\n`);
	GitFixture.run(dir, ["add", "-A"]);
	GitFixture.run(dir, ["commit", "-q", "-m", file]);
};

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "loop-prune-"));
	home = join(root, "home");
	remote = join(root, "remote.git");
	repo = join(root, "repo");
	mkdirSync(home);
	GitFixture.run(root, ["init", "-q", "--bare", remote]);
	GitFixture.run(root, ["clone", "-q", remote, repo]);
	commit(repo, "README.md");
	GitFixture.run(repo, ["push", "-q", "-u", "origin", "main"]);
	prSays = undefined;
	ghCalls = [];
	await Planner.init(home);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const deps = () => ({
	home,
	basePath: home,
	kabaneBin: "/nonexistent/kabane",
	cwd: repo,
	// Never reached: each start below stops at the (nonexistent) runner.
	runner: () => ["/nonexistent/runner"],
	git,
	gh,
	settings: Settings.port(async () => ok([])),
});

const parentWithChild = async (): Promise<Task> => {
	const scope = await detectScope(repo, { home, detectExtensions: false });
	if (!scope) throw new Error("the fixture repo has no scope");
	const add = async (title: string, extra: Record<string, unknown> = {}) => {
		const created = await Planner.addTask(home, {
			title,
			kind: "issue",
			state: "next",
			scopeUri: scope.scopeUri,
			...extra,
		});
		if (!created.ok) throw created.error;
		return created.value;
	};
	const parent = await add("parent");
	await add("child", { parentTaskId: parent.id });
	return parent;
};

let tick = 0;
// A run on `parentId` as `Loop.start` writes it, up to the runner it cannot spawn.
const startOn = async (parentId: string): Promise<RunStore.Run> => {
	tick += 1;
	const at = new Date(Date.UTC(2026, 10, 4, 12, 0, 0, tick));
	await Loop.start({ ...deps(), now: () => at }, { parent: parentId });
	const runs = RunStore.list(home);
	const run = runs.ok ? runs.value[0] : undefined;
	if (!run?.worktree) throw new Error("no worktree run was written");
	return run;
};

// The run's work, committed in its worktree, and the pull request its landing opened for it.
const landed = (run: RunStore.Run, pr = PR): string => {
	const dir = run.worktree ?? "";
	commit(dir, `${run.id}.txt`);
	GitFixture.run(dir, ["push", "-q", "origin", "HEAD"]);
	const written = RunStore.write(home, { ...run, pr });
	if (!written.ok) throw written.error;
	return head(dir);
};

// The pull request squash-merged on the remote, as GitHub merges one, and pulled into the checkout.
const squashMerge = (branch: string): void => {
	GitFixture.run(repo, ["fetch", "-q", "origin", branch]);
	GitFixture.run(repo, ["merge", "-q", "--squash", "FETCH_HEAD"]);
	GitFixture.run(repo, ["commit", "-q", "-m", "squashed"]);
	GitFixture.run(repo, ["push", "-q", "origin", "main"]);
};

const branchExists = (branch: string): boolean =>
	GitFixture.run(repo, ["branch", "--list", branch]).trim() !== "";

describe("a parent's next run, after a run that opened a pull request", () => {
	it("goes on in the worktree while the pull request is open, and takes the pull request over", async () => {
		const parent = await parentWithChild();
		const first = await startOn(parent.id);
		prSays = { state: "OPEN", headRefOid: landed(first) };

		const second = await startOn(parent.id);

		expect(second.worktree).toBe(first.worktree);
		expect(second.worktreeReused?.runId).toBe(first.id);
		expect(second.pr).toBe(PR);
		expect(Loop.placement(second)).toContain(
			`its pull request ${PR} is not merged, so this run goes on with it`,
		);
		expect(ghCalls).toEqual([["pr", "view", PR, "--json", "state,headRefOid"]]);
	});

	it("gets a fresh worktree once the pull request is squash-merged, and the old one and its branch are removed", async () => {
		const parent = await parentWithChild();
		const first = await startOn(parent.id);
		const tip = landed(first);
		const branch = first.branch ?? "";
		squashMerge(branch);
		// git alone calls a squash-merged branch unmerged.
		const merged = await Worktree.merged(repo, branch, git);
		expect(merged.ok && merged.value).toBe(false);
		prSays = { state: "MERGED", headRefOid: tip };

		const second = await startOn(parent.id);

		expect(second.worktreeReused).toBeUndefined();
		expect(second.worktree).not.toBe(first.worktree);
		expect(second.pr).toBeUndefined();
		expect(existsSync(first.worktree ?? "")).toBe(false);
		expect(branchExists(branch)).toBe(false);
		const events = RunStore.readEvents(home, first.id);
		expect(events.ok && events.value.at(-1)?.summary).toContain(
			`pull request ${PR} is merged`,
		);
	});

	it("keeps a branch that gained a commit after its pull request merged, and goes on in it", async () => {
		const parent = await parentWithChild();
		const first = await startOn(parent.id);
		const tip = landed(first);
		squashMerge(first.branch ?? "");
		commit(first.worktree ?? "", "after-merge.txt");
		prSays = { state: "MERGED", headRefOid: tip };

		const second = await startOn(parent.id);

		expect(second.worktree).toBe(first.worktree);
	});

	it("starts afresh after a pull request closed without merging, and leaves its worktree for you", async () => {
		const parent = await parentWithChild();
		const first = await startOn(parent.id);
		prSays = { state: "CLOSED", headRefOid: landed(first) };

		const second = await startOn(parent.id);

		expect(second.worktree).not.toBe(first.worktree);
		expect(existsSync(first.worktree ?? "")).toBe(true);
		expect(branchExists(first.branch ?? "")).toBe(true);
	});

	it("asks git when gh cannot say, and goes on in a branch git calls unmerged", async () => {
		const parent = await parentWithChild();
		const first = await startOn(parent.id);
		landed(first);

		const second = await startOn(parent.id);

		expect(second.worktree).toBe(first.worktree);
		expect(ghCalls).toHaveLength(1);
	});
});

describe("Loop.prune", () => {
	it("removes the worktrees whose work is merged, with their branches, and keeps the rest", async () => {
		const merging = await parentWithChild();
		const open = await parentWithChild();
		const local = await parentWithChild();
		const squashed = await startOn(merging.id);
		const reviewed = await startOn(open.id);
		const plain = await startOn(local.id);
		const openPr = "https://github.com/acme/widget/pull/8";
		const answers = new Map([
			[PR, { state: "MERGED", headRefOid: landed(squashed) }],
			[openPr, { state: "OPEN", headRefOid: landed(reviewed, openPr) }],
		]);
		squashMerge(squashed.branch ?? "");
		// A run with no pull request, merged into the checkout as git sees it.
		commit(plain.worktree ?? "", "plain.txt");
		GitFixture.run(repo, ["merge", "-q", plain.branch ?? ""]);
		const ghByPr: Land.Gh = async (_cwd, args) => {
			const said = answers.get(args[2] ?? "");
			return said ? ok(JSON.stringify(said)) : err(new Error("not found"));
		};

		const pruned = await Loop.prune({ home, git, gh: ghByPr });

		if (!pruned.ok) throw pruned.error;
		const by = new Map(pruned.value.map((p) => [p.runId, p]));
		expect(by.get(squashed.id)).toMatchObject({ removed: true });
		expect(by.get(plain.id)).toMatchObject({
			removed: true,
			why: `branch ${plain.branch ?? ""} is merged into HEAD`,
		});
		expect(by.get(reviewed.id)).toMatchObject({
			removed: false,
			why: `pull request ${openPr} is open`,
		});
		expect(existsSync(squashed.worktree ?? "")).toBe(false);
		expect(existsSync(plain.worktree ?? "")).toBe(false);
		expect(existsSync(reviewed.worktree ?? "")).toBe(true);
		expect(branchExists(squashed.branch ?? "")).toBe(false);
		expect(branchExists(plain.branch ?? "")).toBe(false);
		expect(branchExists(reviewed.branch ?? "")).toBe(true);
	});

	it("keeps a merged worktree with changes not committed, saying git's reason", async () => {
		const parent = await parentWithChild();
		const run = await startOn(parent.id);
		writeFileSync(join(run.worktree ?? "", "draft.txt"), "unsaved\n");

		const pruned = await Loop.prune({ home, git, gh });

		if (!pruned.ok) throw pruned.error;
		expect(pruned.value).toMatchObject([{ runId: run.id, removed: false }]);
		expect(pruned.value[0]?.why).toContain("worktree remove");
		expect(existsSync(join(run.worktree ?? "", "draft.txt"))).toBe(true);
	});

	it("never removes a worktree the loop did not make", async () => {
		const parent = await parentWithChild();
		const run = await startOn(parent.id);
		const mine = join(root, "my-worktree");
		GitFixture.run(repo, ["worktree", "add", "-q", "-b", "mine", mine]);
		const written = RunStore.write(home, { ...run, worktree: mine });
		if (!written.ok) throw written.error;

		const pruned = await Loop.prune({ home, git, gh });

		if (!pruned.ok) throw pruned.error;
		expect(pruned.value).toMatchObject([{ runId: run.id, removed: false }]);
		expect(pruned.value[0]?.why).toContain("not a worktree the loop made");
		expect(existsSync(mine)).toBe(true);
	});
});
