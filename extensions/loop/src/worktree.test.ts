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
