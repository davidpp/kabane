import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	detectScope,
	findProjectRoot,
	mainCheckoutRoot,
	normalizeGitUrl,
	ProjectDirs,
	resolveProjectName,
	resolveScopeId,
	SCOPE_FILE,
} from "./detect";
import { DetectedScopes } from "./detected";
import { GitFixture } from "./git-fixture";

const git = GitFixture.run;

/** A home far from the fixtures, so the home guard never fires accidentally. */
let home: string;
let workspace: string;

const dir = (...segments: string[]): string => {
	const path = join(workspace, ...segments);
	mkdirSync(path, { recursive: true });
	return path;
};

const pin = (root: string, scope: string): void => {
	mkdirSync(join(root, ".kabane"), { recursive: true });
	writeFileSync(join(root, SCOPE_FILE), `${scope}\n`);
};

const gitInit = async (
	root: string,
	opts: { remote?: string; commit?: boolean } = {},
): Promise<void> => {
	git(root, ["init", "-q"]);
	if (opts.remote) {
		git(root, ["remote", "add", "origin", opts.remote]);
	}
	if (opts.commit !== false) {
		writeFileSync(join(root, "README.md"), "fixture\n");
		git(root, ["add", "."]);
		git(root, ["commit", "-qm", "init"]);
	}
};

/** Everything git sees in the checkout beyond its commits, ignored files included. */
const untracked = (root: string): string =>
	git(root, ["status", "--porcelain", "--ignored"]);

const stored = (): string[] => {
	const store = join(home, DetectedScopes.DIR);
	return existsSync(store) ? readdirSync(store) : [];
};

/** The one entry detection stored, parsed. */
const entry = (): unknown => {
	const [only] = stored();
	return only === undefined
		? null
		: JSON.parse(readFileSync(join(home, DetectedScopes.DIR, only), "utf8"));
};

const RENAMED = "git@github.com:davidpp/kabane.git";

beforeEach(() => {
	// realpath so fixture paths match what git and the detector report: on macOS
	// the temp dir is a symlink (/var -> /private/var).
	workspace = realpathSync(mkdtempSync(join(tmpdir(), "cabane-detect-")));
	home = join(
		realpathSync(mkdtempSync(join(tmpdir(), "cabane-home-"))),
		".kabane",
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
		git(root, ["worktree", "add", "-q", "-b", "feat", tree]);

		expect(await findProjectRoot(tree, home)).toBe(root);
	});

	// ~/.kabane is the home, not a project. Without the guard every directory
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

describe("mainCheckoutRoot", () => {
	it("maps a marked root in a worktree to the same place in the main checkout", async () => {
		const root = dir("monorepo");
		mkdirSync(join(root, "packages", "app", ".kabane"), { recursive: true });
		writeFileSync(join(root, "packages", "app", ".kabane", "loop.json"), "{}");
		await gitInit(root);
		const tree = join(workspace, "monorepo.feature");
		git(root, ["worktree", "add", "-q", "-b", "feat", tree]);

		const marked = await findProjectRoot(join(tree, "packages", "app"), home);
		expect(marked).toBe(join(tree, "packages", "app"));
		expect(await mainCheckoutRoot(String(marked))).toBe(
			join(root, "packages", "app"),
		);
		// The main checkout, and a root outside git, are their own place.
		expect(await mainCheckoutRoot(join(root, "packages", "app"))).toBe(
			join(root, "packages", "app"),
		);
		const loose = dir("loose");
		expect(await mainCheckoutRoot(loose)).toBe(loose);
	});
});

describe("ProjectDirs", () => {
	it("keys a project's directory by a readable slug of its path and a hash", () => {
		const slug = ProjectDirs.slug("/Users/me/my repo.git");
		expect(slug).toMatch(/^-Users-me-my-repo-git-[0-9a-f]{8}$/);
		expect(ProjectDirs.slug("/Users/me/my_repo.git")).not.toBe(slug);
		expect(ProjectDirs.of("/home/.kabane", "/Users/me/my repo.git")).toBe(
			`/home/.kabane/projects/${slug}`,
		);
	});
});

describe("resolveScopeId", () => {
	it("prefers the pin over the git remote", async () => {
		const root = dir("repo");
		await gitInit(root, { remote: "git@github.com:davidpp/cabane.git" });
		pin(root, "cabane");

		expect(await resolveScopeId(root, { home })).toBe("cabane");
	});

	// The repo may be a client's or an employer's checkout: detection keeps what
	// it resolved under KABANE_HOME, never in the repo.
	it("normalizes the git remote and writes nothing into the repo", async () => {
		const root = dir("repo");
		await gitInit(root, { remote: "git@github.com:davidpp/cabane.git" });

		expect(await resolveScopeId(root, { home })).toBe(
			"github.com/davidpp/cabane",
		);
		expect(untracked(root)).toBe("");
		expect(stored()).toHaveLength(1);
	});

	// A clone made elsewhere after the rename is a checkout of its own, and
	// resolves by the remote it has, as it did before detection stored anything.
	it("keeps a checkout's scope after its remote is renamed", async () => {
		const root = dir("repo");
		await gitInit(root, { remote: "git@github.com:davidpp/cabane.git" });
		expect(await resolveScopeId(root, { home })).toBe(
			"github.com/davidpp/cabane",
		);

		git(root, ["remote", "set-url", "origin", RENAMED]);
		expect(await resolveScopeId(root, { home })).toBe(
			"github.com/davidpp/cabane",
		);

		const fresh = join(workspace, "fresh");
		git(workspace, ["clone", "-q", root, fresh]);
		git(fresh, ["remote", "set-url", "origin", RENAMED]);
		expect(await resolveScopeId(fresh, { home })).toBe(
			"github.com/davidpp/kabane",
		);
	});

	// A fork and its upstream share a root commit; neither takes the other's id,
	// even when both resolve for the first time at once.
	it("resolves clones of one history by their own remotes", async () => {
		const origin = dir("origin");
		await gitInit(origin);
		const [fork, upstream] = ["fork", "upstream"].map((name) => {
			const clone = join(workspace, name);
			git(workspace, ["clone", "-q", origin, clone]);
			git(clone, [
				"remote",
				"set-url",
				"origin",
				`git@github.com:${name}/cabane.git`,
			]);
			return clone;
		});

		const first = await Promise.all(
			[fork, upstream].map((root) => resolveScopeId(String(root), { home })),
		);
		const again = await Promise.all(
			[fork, upstream].map((root) => resolveScopeId(String(root), { home })),
		);

		const expected = ["github.com/fork/cabane", "github.com/upstream/cabane"];
		expect(first).toEqual(expected);
		expect(again).toEqual(expected);
	});

	// Stored while the repo had no commit, so with no first commit beside it.
	// Its first commit then makes it that repo's, and a removed remote is no
	// reason to fall back to a git: id.
	it("keeps an id stored before the first commit", async () => {
		const root = dir("repo");
		await gitInit(root, {
			remote: "git@github.com:davidpp/cabane.git",
			commit: false,
		});
		expect(await resolveScopeId(root, { home })).toBe(
			"github.com/davidpp/cabane",
		);

		git(root, ["remote", "remove", "origin"]);
		writeFileSync(join(root, "README.md"), "fixture\n");
		git(root, ["add", "."]);
		git(root, ["commit", "-qm", "init"]);

		expect(await resolveScopeId(root, { home })).toBe(
			"github.com/davidpp/cabane",
		);
		const firstCommit = git(root, ["rev-parse", "HEAD"]).trim();
		expect(entry()).toEqual({
			scopeId: "github.com/davidpp/cabane",
			firstCommit,
		});
	});

	it("resolves afresh for another repo cloned at the same path", async () => {
		const root = dir("repo");
		await gitInit(root, { remote: "git@github.com:davidpp/cabane.git" });
		expect(await resolveScopeId(root, { home })).toBe(
			"github.com/davidpp/cabane",
		);

		// Other content, or the fixture's commit could hash the same within a second.
		rmSync(root, { recursive: true, force: true });
		mkdirSync(root);
		await gitInit(root, { remote: RENAMED, commit: false });
		writeFileSync(join(root, "OTHER.md"), "another repo\n");
		git(root, ["add", "."]);
		git(root, ["commit", "-qm", "another"]);

		expect(await resolveScopeId(root, { home })).toBe(
			"github.com/davidpp/kabane",
		);
	});

	// MCP, the board and the CLI resolve at once; each write lands whole.
	it("resolves the same id under concurrent first detections", async () => {
		const root = dir("repo");
		await gitInit(root, { remote: "git@github.com:davidpp/cabane.git" });

		const ids = await Promise.all(
			Array.from({ length: 16 }, () => resolveScopeId(root, { home })),
		);

		expect(new Set(ids)).toEqual(new Set(["github.com/davidpp/cabane"]));
		expect(stored()).toHaveLength(1);
		expect(entry()).toMatchObject({ scopeId: "github.com/davidpp/cabane" });
	});

	it("falls back to the first commit when there is no remote", async () => {
		const root = dir("repo");
		await gitInit(root);

		const id = await resolveScopeId(root, { home });
		expect(id).toMatch(/^git:[0-9a-f]{12}$/);
	});

	// A git: id froze because the repo had no remote yet; once it has one the
	// real id has to win, or the repo is stuck on a placeholder forever.
	it("upgrades a cached git: id once a remote exists", async () => {
		const root = dir("repo");
		await gitInit(root);
		const frozen = await resolveScopeId(root, { home });
		expect(frozen).toStartWith("git:");

		git(root, ["remote", "add", "origin", "git@github.com:davidpp/cabane.git"]);

		expect(await resolveScopeId(root, { home })).toBe(
			"github.com/davidpp/cabane",
		);

		git(root, ["remote", "remove", "origin"]);
		expect(await resolveScopeId(root, { home })).toBe(
			"github.com/davidpp/cabane",
		);
	});

	// A pin an earlier kabane's detection wrote is the user's file now: still
	// honoured, still upgradable, never rewritten.
	it("upgrades a git: pin to the remote without touching the pin", async () => {
		const root = dir("repo");
		await gitInit(root);
		const frozen = await resolveScopeId(root, { home });
		pin(root, frozen);
		git(root, ["remote", "add", "origin", "git@github.com:davidpp/cabane.git"]);

		expect(await resolveScopeId(root, { home })).toBe(
			"github.com/davidpp/cabane",
		);
		expect((await readFile(join(root, SCOPE_FILE), "utf8")).trim()).toBe(
			frozen,
		);
	});

	// The reverse would orphan everything already filed under the remote id.
	it("never downgrades a real pin to a git: id", async () => {
		const root = dir("repo");
		await gitInit(root);
		pin(root, "cabane");

		expect(await resolveScopeId(root, { home })).toBe("cabane");
		expect((await readFile(join(root, SCOPE_FILE), "utf8")).trim()).toBe(
			"cabane",
		);
	});

	it("falls back to the root path with no git at all", async () => {
		const root = dir("plain");

		expect(await resolveScopeId(root, { home })).toBe(root);
	});

	it("takes a legacy pin over the remote, and stores nothing", async () => {
		const root = dir("repo");
		await gitInit(root, { remote: "git@github.com:davidpp/cabane.git" });

		expect(
			await resolveScopeId(root, { home, legacyPin: async () => "jake" }),
		).toBe("jake");
		expect(untracked(root)).toBe("");
		expect(stored()).toEqual([]);
	});

	it("skips a git: legacy pin so a remote can still win", async () => {
		const root = dir("repo");
		await gitInit(root, { remote: "git@github.com:davidpp/cabane.git" });

		expect(
			await resolveScopeId(root, {
				home,
				legacyPin: async () => "git:abc123abc123",
			}),
		).toBe("github.com/davidpp/cabane");
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
		git(root, ["worktree", "add", "-q", "-b", "feat", tree]);

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

	it("leaves a fresh clone without a kabane file", async () => {
		const origin = dir("origin");
		await gitInit(origin);
		const clone = join(workspace, "clone");
		git(workspace, ["clone", "-q", origin, clone]);

		const scope = await detectScope(clone, { home });

		expect(scope?.scopeId).toBe(origin);
		expect(untracked(clone)).toBe("");
		expect(existsSync(join(clone, ".kabane"))).toBe(false);
	});

	it("returns null outside any project", async () => {
		expect(await detectScope(dir("nowhere"), { home })).toBeNull();
	});
});
