import { afterEach, beforeEach, expect, it } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitFixture } from "@cabane/core/git-fixture";
import { ProjectDirs } from "@cabane/core/scope";
import { LoopConfig } from "@cabane/loop";
import { configPath } from "./config";
import { projectAt, settingsPort } from "./context";

// The port an extension resolves its settings through, as the CLI wires it: config.json, a real
// checkout's `.kabane/loop.json`, the legacy scopes block for the scope it detects, and its local
// file under the home.
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

it("layers global, shared, the legacy scopes block, the local file and the caller", async () => {
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
				[scopeId]: {
					loop: {
						gates: { test: "scope test" },
						worktree: false,
						recheck: false,
					},
				},
				other: { loop: { implementer: "codex" } },
			},
		}),
	);
	const local = ProjectDirs.of(home, realpathSync(repo));
	mkdirSync(local, { recursive: true });
	writeFileSync(join(local, "loop.json"), JSON.stringify({ recheck: true }));
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
		recheck: true,
		gates: { lint: "user lint", test: "scope test", check: "flag check" },
	});

	// A worktree of the project reads the main checkout's local settings and the same scope's.
	const tree = join(root, "tree");
	GitFixture.run(repo, ["worktree", "add", "-q", "--detach", tree]);
	const inTree = await loopAt(tree);
	expect(inTree.ok && inTree.value.gates).toEqual({
		lint: "user lint",
		test: "scope test",
	});
	expect(inTree.ok && inTree.value.recheck).toBe(true);
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
