import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	detectScope,
	findProjectRoot,
	normalizeGitUrl,
	resolveProjectName,
	resolveScopeId,
	SCOPE_FILE,
} from "./detect";

const run = promisify(execFile);

/** A home far from the fixtures, so the home guard never fires accidentally. */
let home: string;
let workspace: string;

const dir = (...segments: string[]): string => {
	const path = join(workspace, ...segments);
	mkdirSync(path, { recursive: true });
	return path;
};

const pin = (root: string, scope: string): void => {
	mkdirSync(join(root, ".cabane"), { recursive: true });
	writeFileSync(join(root, SCOPE_FILE), `${scope}\n`);
};

const gitInit = async (
	root: string,
	opts: { remote?: string; commit?: boolean } = {},
): Promise<void> => {
	await run("git", ["-C", root, "init", "-q", "-b", "main"]);
	await run("git", ["-C", root, "config", "user.email", "t@example.com"]);
	await run("git", ["-C", root, "config", "user.name", "Test"]);
	if (opts.remote) {
		await run("git", ["-C", root, "remote", "add", "origin", opts.remote]);
	}
	if (opts.commit !== false) {
		writeFileSync(join(root, "README.md"), "fixture\n");
		await run("git", ["-C", root, "add", "."]);
		await run("git", ["-C", root, "commit", "-qm", "init"]);
	}
};

beforeEach(() => {
	// realpath so fixture paths match what git and the detector report: on macOS
	// the temp dir is a symlink (/var -> /private/var).
	workspace = realpathSync(mkdtempSync(join(tmpdir(), "cabane-detect-")));
	home = join(
		realpathSync(mkdtempSync(join(tmpdir(), "cabane-home-"))),
		".cabane",
	);
	mkdirSync(home, { recursive: true });
});

afterEach(() => {
	rmSync(workspace, { recursive: true, force: true });
	rmSync(join(home, ".."), { recursive: true, force: true });
});

describe("normalizeGitUrl", () => {
	it.each([
		["scp-style ssh", "git@github.com:davidpp/cabane.git"],
		["ssh URL", "ssh://git@github.com/davidpp/cabane.git"],
		["ssh URL without a user", "ssh://github.com/davidpp/cabane"],
		["https", "https://github.com/davidpp/cabane.git"],
		["http", "http://github.com/davidpp/cabane"],
		["https with a token", "https://token@github.com/davidpp/cabane.git"],
		["surrounding whitespace", "  git@github.com:davidpp/cabane.git  "],
	])("normalizes %s to host/owner/repo", (_label, url) => {
		expect(normalizeGitUrl(url)).toBe("github.com/davidpp/cabane");
	});

	it("leaves a form it does not recognize alone", () => {
		expect(normalizeGitUrl("/srv/git/bare-repo")).toBe("/srv/git/bare-repo");
	});
});

describe("findProjectRoot", () => {
	it("walks up to the nearest marker directory", async () => {
		const root = dir("repo");
		pin(root, "demo");
		const nested = dir("repo", "packages", "core");

		expect(await findProjectRoot(nested, home)).toBe(root);
	});

	it("falls back to the git toplevel when no marker exists", async () => {
		const root = dir("bare");
		await gitInit(root);
		const nested = dir("bare", "packages", "cli");

		expect(await findProjectRoot(nested, home)).toBe(root);
	});

	it("resolves a worktree to the main checkout", async () => {
		const root = dir("main");
		await gitInit(root);
		const tree = join(workspace, "main.feature");
		await run("git", ["-C", root, "worktree", "add", "-q", "-b", "feat", tree]);

		expect(await findProjectRoot(tree, home)).toBe(root);
	});

	// ~/.cabane is the home, not a project. Without the guard every directory
	// under ~ that is outside a repo collapses into one "home" scope.
	it("never returns the home directory as a project root", async () => {
		const homeParent = join(home, "..");
		const loose = dir("..", "loose");

		expect(await findProjectRoot(homeParent, home)).toBeNull();
		expect(await findProjectRoot(loose, home)).not.toBe(homeParent);
	});

	it("returns null outside any project", async () => {
		expect(await findProjectRoot(dir("nowhere"), home)).toBeNull();
	});
});

describe("resolveScopeId", () => {
	it("prefers the pin over the git remote", async () => {
		const root = dir("repo");
		await gitInit(root, { remote: "git@github.com:davidpp/cabane.git" });
		pin(root, "cabane");

		expect(await resolveScopeId(root)).toBe("cabane");
	});

	it("normalizes the git remote and caches it as the pin", async () => {
		const root = dir("repo");
		await gitInit(root, { remote: "git@github.com:davidpp/cabane.git" });

		expect(await resolveScopeId(root)).toBe("github.com/davidpp/cabane");
		expect((await readFile(join(root, SCOPE_FILE), "utf8")).trim()).toBe(
			"github.com/davidpp/cabane",
		);
	});

	it("falls back to the first commit when there is no remote", async () => {
		const root = dir("repo");
		await gitInit(root);

		const id = await resolveScopeId(root);
		expect(id).toMatch(/^git:[0-9a-f]{12}$/);
	});

	// A git: id froze because the repo had no remote yet; once it has one the
	// real id has to win, or the repo is stuck on a placeholder forever.
	it("upgrades a cached git: id once a remote exists", async () => {
		const root = dir("repo");
		await gitInit(root);
		const frozen = await resolveScopeId(root);
		expect(frozen).toStartWith("git:");

		await run("git", [
			"-C",
			root,
			"remote",
			"add",
			"origin",
			"git@github.com:davidpp/cabane.git",
		]);

		expect(await resolveScopeId(root)).toBe("github.com/davidpp/cabane");
	});

	// The reverse would orphan everything already filed under the remote id.
	it("never downgrades a real pin to a git: id", async () => {
		const root = dir("repo");
		await gitInit(root);
		pin(root, "cabane");

		expect(await resolveScopeId(root)).toBe("cabane");
		expect((await readFile(join(root, SCOPE_FILE), "utf8")).trim()).toBe(
			"cabane",
		);
	});

	it("falls back to the root path with no git at all", async () => {
		const root = dir("plain");

		expect(await resolveScopeId(root)).toBe(root);
	});

	it("takes a legacy pin over the remote, and does not cache it", async () => {
		const root = dir("repo");
		await gitInit(root, { remote: "git@github.com:davidpp/cabane.git" });

		expect(await resolveScopeId(root, async () => "jake")).toBe("jake");
		expect(
			await readFile(join(root, SCOPE_FILE), "utf8").catch(() => null),
		).toBeNull();
	});

	it("skips a git: legacy pin so a remote can still win", async () => {
		const root = dir("repo");
		await gitInit(root, { remote: "git@github.com:davidpp/cabane.git" });

		expect(await resolveScopeId(root, async () => "git:abc123abc123")).toBe(
			"github.com/davidpp/cabane",
		);
	});
});

describe("resolveProjectName", () => {
	it.each([
		["the repo half of a remote id", "github.com/davidpp/cabane", "cabane"],
		["the folder of a path fallback", "/Users/x/Projects/jake", "jake"],
		["a bare id unchanged", "cabane", "cabane"],
	])("takes %s", (_label, scopeId, expected) => {
		expect(resolveProjectName(scopeId)).toBe(expected);
	});
});

describe("detectScope", () => {
	it("builds a canonical URI with the detected extensions", async () => {
		const root = dir("repo");
		await gitInit(root);
		pin(root, "cabane");
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({ name: "cabane-monorepo" }),
		);
		const nested = dir("repo", "packages", "core");
		writeFileSync(
			join(nested, "package.json"),
			JSON.stringify({ name: "@cabane/core" }),
		);

		const scope = await detectScope(nested, { home });

		expect(scope).not.toBeNull();
		expect(scope?.root).toBe(root);
		expect(scope?.scopeId).toBe("cabane");
		expect(scope?.name).toBe("cabane");
		expect(scope?.extensions).toEqual({
			package: "@cabane/core",
			branch: "main",
		});
		expect(scope?.scopeUri).toBe(
			"jake://scope/cabane?branch=main&package=%40cabane%2Fcore",
		);
	});

	// Extensions vary by cwd and branch; the scope id must not, or the same
	// project files under a different scope from a worktree.
	it("resolves the same scope id from a worktree and a nested directory", async () => {
		const root = dir("main");
		await gitInit(root, { remote: "git@github.com:davidpp/cabane.git" });
		const tree = join(workspace, "main.feature");
		await run("git", ["-C", root, "worktree", "add", "-q", "-b", "feat", tree]);

		const fromRoot = await detectScope(root, { home });
		const fromNested = await detectScope(dir("main", "packages"), { home });
		const fromTree = await detectScope(tree, { home });

		expect(fromRoot?.scopeId).toBe("github.com/davidpp/cabane");
		expect(fromNested?.scopeId).toBe(fromRoot?.scopeId);
		expect(fromTree?.scopeId).toBe(fromRoot?.scopeId);
		expect(fromTree?.extensions.branch).toBe("feat");
	});

	it("omits extensions when asked to", async () => {
		const root = dir("repo");
		await gitInit(root);
		pin(root, "cabane");

		const scope = await detectScope(root, { home, detectExtensions: false });

		expect(scope?.extensions).toEqual({});
		expect(scope?.scopeUri).toBe("jake://scope/cabane");
	});

	it("returns null outside any project", async () => {
		expect(await detectScope(dir("nowhere"), { home })).toBeNull();
	});
});
