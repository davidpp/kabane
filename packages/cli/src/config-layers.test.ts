import { afterEach, beforeEach, expect, it } from "bun:test";
import {
	mkdirSync,
	symlinkSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitFixture } from "@cabane/core/git-fixture";
import { configPath } from "./config";
import { ConfigLayers } from "./config-layers";
import { projectAt, settingsPort } from "./context";
import { Extensions } from "./extensions";
import { ProjectDirs } from "./scope/detect";

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
	mkdirSync(join(home, "extensions"), { recursive: true });
	symlinkSync(
		join(import.meta.dir, "../../../extensions/loop"),
		join(home, "extensions/loop"),
	);
	writeFileSync(
		configPath(home),
		JSON.stringify({ actor: "test", deviceId: "test", extensions: ["loop"] }),
	);
	mkdirSync(repo);
	GitFixture.run(repo, ["init", "-q"]);
	GitFixture.run(repo, ["commit", "-q", "--allow-empty", "-m", "first"]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const loopAt = async (
	projectDir: string,
	overrides?: Record<string, unknown>,
) => {
	const namespaces = await Extensions.namespaces(home);
	if (!namespaces.ok) throw namespaces.error;
	const loop = namespaces.value.find((namespace) => namespace.name === "loop");
	if (!loop) throw new Error("the real loop settings schema was not loaded");
	return settingsPort(home)("loop", loop.schema, {
		projectDir,
		...(overrides ? { overrides } : {}),
	});
};

it("layers global, shared, the legacy scopes block, the local file and the caller", async () => {
	const scope = await projectAt(repo, home);
	const scopeId = scope.ok ? scope.value?.scopeId : undefined;
	if (scopeId === undefined) throw new Error("the fixture repo has no scope");
	writeFileSync(
		configPath(home),
		JSON.stringify({
			actor: "cabane://actor/human/tester",
			deviceId: "test",
			extensions: ["loop"],
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
	// The project's root as detected: its real path, /private/var for /var on macOS.
	expect(!broken.ok && broken.error.message).toStartWith(
		join(realpathSync(repo), ".kabane", "loop.json"),
	);
	writeFileSync(join(repo, ".kabane", "loop.json"), "{}");
	writeFileSync(
		configPath(home),
		JSON.stringify({
			actor: "cabane://actor/human/tester",
			deviceId: "test",
			extensions: ["loop"],
			scopes: [],
		}),
	);
	const scopes = await loopAt(repo);
	expect(!scopes.ok && scopes.error.message).toStartWith(
		`Invalid scopes in ${configPath(home)}`,
	);
});

it("a write under a path whose parent is a file returns its error instead of throwing", () => {
	const file = join(root, "plain");
	writeFileSync(file, "");
	const written = ConfigLayers.writeJson(join(file, "loop.json"), {});
	expect(written.ok).toBe(false);
	if (!written.ok) expect(written.error.message).toContain("plain");
});
