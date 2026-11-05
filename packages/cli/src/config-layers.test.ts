import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitFixture } from "@cabane/core/git-fixture";
import { LoopConfig } from "@cabane/loop";
import { configPath } from "./config";
import { projectAt, settingsPort } from "./context";

// The port an extension resolves its settings through, as the CLI wires it: config.json, a real
// checkout's `.kabane/loop.json`, and the user's settings for the scope that checkout detects.
let root = "";
let home = "";
let repo = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "kabane-layers-"));
	home = join(root, "home");
	repo = join(root, "repo");
	mkdirSync(home);
	mkdirSync(repo);
	GitFixture.run(repo, ["init", "-q"]);
	GitFixture.run(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const loopAt = (projectDir: string, overrides?: Record<string, unknown>) =>
	settingsPort(home)(LoopConfig.NAMESPACE, LoopConfig.SettingsSchema, {
		projectDir,
		...(overrides ? { overrides } : {}),
	});

it("layers the user's config, the project file, the user's scope settings and the caller", async () => {
	const scope = await projectAt(repo, home);
	const scopeId = scope.ok ? scope.value?.scopeId : undefined;
	if (scopeId === undefined) throw new Error("the fixture repo has no scope");
	writeFileSync(
		configPath(home),
		JSON.stringify({
			actor: "cabane://actor/human/tester",
			deviceId: "test",
			loop: { stallAfter: 4, gates: { lint: "user lint" } },
			scopes: {
				[scopeId]: { loop: { gates: { test: "scope test" }, worktree: false } },
				other: { loop: { implementer: "codex" } },
			},
		}),
	);
	mkdirSync(join(repo, ".kabane"), { recursive: true });
	writeFileSync(
		join(repo, ".kabane", "loop.json"),
		JSON.stringify({
			gates: { test: "project test", check: "project check" },
			worktree: true,
			stallAfter: 2,
		}),
	);
	const resolved = await loopAt(repo, { gates: { check: "flag check" } });
	expect(resolved.ok).toBe(true);
	if (!resolved.ok) return;
	expect(resolved.value).toMatchObject({
		implementer: "claude",
		stallAfter: 2,
		worktree: false,
		gates: { lint: "user lint", test: "scope test", check: "flag check" },
	});

	// A worktree of the project detects the same scope, so the user's settings for it still hold.
	const tree = join(root, "tree");
	GitFixture.run(repo, ["worktree", "add", "-q", "--detach", tree]);
	const inTree = await loopAt(tree);
	expect(inTree.ok && inTree.value.gates).toEqual({
		lint: "user lint",
		test: "scope test",
	});
});

it("resolves before kabane init, and names the layer an error is in", async () => {
	const bare = await loopAt(repo);
	expect(bare.ok && bare.value.gates).toEqual({});
	mkdirSync(join(repo, ".kabane"), { recursive: true });
	writeFileSync(join(repo, ".kabane", "loop.json"), "{ nope");
	const broken = await loopAt(repo);
	expect(!broken.ok && broken.error.message).toStartWith(
		join(repo, ".kabane", "loop.json"),
	);
	writeFileSync(join(repo, ".kabane", "loop.json"), "{}");
	writeFileSync(
		configPath(home),
		JSON.stringify({
			actor: "cabane://actor/human/tester",
			deviceId: "test",
			scopes: [],
		}),
	);
	const scopes = await loopAt(repo);
	expect(!scopes.ok && scopes.error.message).toStartWith(
		`Invalid scopes in ${configPath(home)}`,
	);
});
