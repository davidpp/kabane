// A checkpoint through the user's own git, the runner's default, in a real worktree. The fixture
// repository's local config sets what the machine's could otherwise change: an identity, no
// signing, and the hooks directory.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, trySync } from "@cabane/core";
import { GitFixture } from "@cabane/core/git-fixture";
import { Worktree } from "./worktree";

let root = "";
let repo = "";
let worktree = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "loop-worktree-"));
	repo = join(root, "repo");
	worktree = join(root, "worktree");
	const hooks = join(root, "hooks");
	mkdirSync(repo);
	mkdirSync(hooks);
	GitFixture.run(repo, ["init", "-q"]);
	const local: Record<string, string> = {
		"user.name": "Test",
		"user.email": "test@example.com",
		"commit.gpgsign": "false",
		"core.hooksPath": hooks,
	};
	for (const [key, value] of Object.entries(local))
		GitFixture.run(repo, ["config", key, value]);
	writeFileSync(join(repo, "README.md"), "# fixture\n");
	GitFixture.run(repo, ["add", "-A"]);
	GitFixture.run(repo, ["commit", "-q", "-m", "first"]);
	GitFixture.run(repo, ["worktree", "add", "-q", "-b", "loop", worktree]);
	// The user's own hook, which a checkpoint runs like any commit of theirs.
	const hook = join(hooks, "pre-commit");
	writeFileSync(hook, "#!/bin/sh\nsleep 1\n");
	chmodSync(hook, 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Worktree.checkpoint", () => {
	it("leaves the runner's event loop running while the user's commit hooks run", async () => {
		writeFileSync(join(worktree, "work.txt"), "made by a session\n");
		let ticks = 0;
		const timer = setInterval(() => {
			ticks += 1;
		}, 50);
		const made = await Worktree.checkpoint(worktree, "checkpoint");
		clearInterval(timer);

		expect(made.ok && made.value).toBe(
			GitFixture.run(worktree, ["rev-parse", "HEAD"]).trim(),
		);
		// A second of hook is twenty ticks; a synchronous spawn allows none.
		expect(ticks).toBeGreaterThanOrEqual(10);
	});
});

describe("Worktree.branchFor", () => {
	it("names the branch for the issue and the first words of its title", () => {
		expect(
			Worktree.branchFor(
				"JCAB-91",
				"A completed loop run lands its branch as the project says: open a PR, or leave it",
			),
		).toBe("jcab-91-a-completed-loop-run-lands-its-branch-as");
		expect(Worktree.branchFor("JCAB-7", "Café: déjà vu!")).toBe(
			"jcab-7-cafe-deja-vu",
		);
	});
});

describe("Worktree.unused", () => {
	it("numbers a name a branch already has, locally or on a remote", async () => {
		const git: Worktree.Git = async (cwd, args) =>
			trySync(() => GitFixture.run(cwd, args));
		expect(await Worktree.unused(repo, "jcab-1-fix", git)).toEqual(
			ok("jcab-1-fix"),
		);
		GitFixture.run(repo, ["branch", "jcab-1-fix"]);
		GitFixture.run(repo, [
			"update-ref",
			"refs/remotes/origin/jcab-1-fix-2",
			"HEAD",
		]);
		expect(await Worktree.unused(repo, "jcab-1-fix", git)).toEqual(
			ok("jcab-1-fix-3"),
		);
	});
});
