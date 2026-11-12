/**
 * Resolve a working directory to the scope its project files under.
 *
 * Lifted from Jake's `@jake/core/scope/resolver.ts` (ADR-009) so Cabane owns
 * the rule outright — a host that has no scope opinion of its own gets the same
 * answer `jake plan` gives, and `kabane board` opens where `jake board` does.
 *
 * NOT exported from the package barrel, and deliberately so: this module spawns
 * `git` and reads the filesystem, neither of which exists on Workers. The hub
 * imports `@cabane/core`; only Bun hosts import `@cabane/core/scope`.
 */

import { execFile } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { DetectedScopes } from "./detected";
import { ProjectDirs } from "./projects";
import { ScopeUri } from "./uri";

export { ProjectDirs } from "./projects";

const run = promisify(execFile);

/** The directory that marks a project root and holds its pinned scope. */
export const MARKER_DIR = ".kabane";

/**
 * The shared pin, checked in for everyone who clones the repo. Only `kabane init --scope --shared`
 * writes it; detection reads it and never writes it.
 */
export const SCOPE_FILE = join(MARKER_DIR, "scope");

/**
 * A resolved project scope.
 *
 * `scopeUri` is what a query filters on and a new task records; `name` is what
 * a UI shows. `extensions` are already folded into `scopeUri` — they ride along
 * for provenance and never narrow a filter, since a scope-family match covers
 * the base URI plus every extension-carrying variant.
 */
export type ProjectScope = {
	root: string;
	scopeId: string;
	name: string;
	extensions: Record<string, string>;
	scopeUri: string;
};

export type DetectOptions = {
	/**
	 * KABANE_HOME. Guards the walk from mistaking `~/.kabane` for a project, and
	 * holds the ids detection resolved (`DetectedScopes`).
	 */
	home: string;
	/** Skip `branch`/`package` detection. Default: detect. */
	detectExtensions?: boolean;
};

const isDirectory = async (path: string): Promise<boolean> => {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
};

const git = async (dir: string, args: string[]): Promise<string | null> => {
	try {
		const { stdout } = await run("git", ["-C", dir, ...args]);
		const text = stdout.trim();
		return text.length > 0 ? text : null;
	} catch {
		return null;
	}
};

/**
 * Symlinks have to be followed before any two paths are compared: git always
 * answers with a real path (on macOS `/var/...` comes back as `/private/var/...`),
 * so a marker walk that stopped at the symlinked spelling would hand back a
 * different root than the git fallback for the same directory — and a root is
 * the scope id when the cascade runs out of better answers.
 */
const canonical = async (path: string): Promise<string> => {
	try {
		return await realpath(path);
	} catch {
		return resolve(path);
	}
};

/**
 * `~/.kabane` is the home, not a project marker, so the home's parent — the
 * user's home directory — must never win the walk. Without this guard every
 * directory under `~` that is outside a repo resolves to one giant "home"
 * scope.
 */
const isHomeParent = (dir: string, homeParent: string): boolean =>
	dir === homeParent;

const hasMarker = async (dir: string): Promise<boolean> =>
	isDirectory(join(dir, MARKER_DIR));

/**
 * The git checkout `dir` is in: its toplevel, and the main checkout's root. A worktree reports its
 * own toplevel; `--git-common-dir` leads back to the checkout it branched from.
 */
const checkoutOf = async (
	dir: string,
): Promise<{ toplevel: string; main: string } | null> => {
	const toplevel = await git(dir, ["rev-parse", "--show-toplevel"]);
	if (!toplevel) return null;
	const commonDir = await git(dir, ["rev-parse", "--git-common-dir"]);
	// A relative common dir (".git") is the main checkout; an absolute one means
	// this is a worktree pointing back at the main repo's git dir.
	if (!commonDir || !isAbsolute(commonDir)) return { toplevel, main: toplevel };
	const mainGitDir = commonDir.includes("/worktrees/")
		? (commonDir.split("/worktrees/")[0] as string)
		: commonDir;
	return { toplevel, main: await canonical(dirname(mainGitDir)) };
};

/**
 * Git fallback for repos with no marker directory yet. A worktree files under
 * the main checkout, so it does not get a scope of its own.
 */
const findGitRoot = async (
	startDir: string,
	homeParent: string,
): Promise<string | null> => {
	const checkout = await checkoutOf(startDir);
	if (!checkout || isHomeParent(checkout.toplevel, homeParent)) return null;
	return isHomeParent(checkout.main, homeParent) ? null : checkout.main;
};

/**
 * The same place as the project root `root` in the main checkout, when `root` is in a linked
 * worktree; `root` otherwise. A repo that checks in `.kabane/` has that marker in every
 * worktree, so what is keyed by a project's path would otherwise differ per worktree.
 */
export const mainCheckoutRoot = async (root: string): Promise<string> => {
	const checkout = await checkoutOf(root);
	if (!checkout || checkout.main === checkout.toplevel) return root;
	const inside = relative(await canonical(checkout.toplevel), root);
	return inside.startsWith("..") || isAbsolute(inside)
		? root
		: join(checkout.main, inside);
};

/**
 * Two-phase root detection: walk up for a `.kabane/` marker, then fall back to
 * git. The marker wins so a repo can pin a root that is not its git toplevel
 * (a package inside a monorepo that tracks its own issues).
 */
export const findProjectRoot = async (
	cwd: string,
	home: string,
): Promise<string | null> => {
	const homeParent = await canonical(dirname(home));
	let dir = await canonical(cwd);
	const { root } = parse(dir);

	for (;;) {
		if ((await hasMarker(dir)) && !isHomeParent(dir, homeParent)) return dir;
		if (dir === root) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return findGitRoot(cwd, homeParent);
};

/**
 * Normalize a git remote URL to a stable `host/owner/repo` identifier, so the
 * same project resolves identically however it was cloned.
 */
export const normalizeGitUrl = (url: string): string => {
	const trimmed = url.trim().replace(/\.git$/, "");

	const ssh = trimmed.match(/^git@([^:]+):(.+)$/);
	if (ssh) return `${ssh[1]}/${ssh[2]}`;

	const sshUrl = trimmed.match(/^ssh:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
	if (sshUrl) return `${sshUrl[1]}/${sshUrl[2]}`;

	const https = trimmed.match(/^https?:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/);
	if (https) return `${https[1]}/${https[2]}`;

	return trimmed;
};

/** `origin` first, then whatever remote is listed first. */
const remoteUrl = async (root: string): Promise<string | null> => {
	const origin = await git(root, ["remote", "get-url", "origin"]);
	if (origin) return origin;

	const first = (await git(root, ["remote"]))?.split("\n")[0];
	return first ? git(root, ["remote", "get-url", first]) : null;
};

/**
 * The local pin: yours for this project, on this device, in the project's directory under
 * KABANE_HOME. Keyed by the main checkout's path, so every worktree of a repo reads the same one.
 * Only `kabane init --scope` writes it.
 */
export const localPinPath = async (
	home: string,
	root: string,
): Promise<string> =>
	join(ProjectDirs.of(home, await mainCheckoutRoot(root)), "scope");

const readScopePin = async (path: string): Promise<string | null> => {
	try {
		const value = (await readFile(path, "utf8")).trim();
		return value.length > 0 ? value : null;
	} catch {
		return null;
	}
};

/**
 * Resolve the stable scope id for a project root (ADR-009 cascade):
 * local pin → shared pin → the id detection stored → git remote → first commit →
 * path. Your own pin wins over the repo's, as a local setting wins over a shared one.
 *
 * Nothing here writes into the repo: it may be a checkout the user does not
 * own. What the remote resolves to is stored under KABANE_HOME instead, keyed
 * by the checkout's root and checked against its first commit, so a renamed
 * remote keeps the scope it had while a fork or another clone resolves by its
 * own remote.
 *
 * One-way: a `git:` id is a placeholder for a repo that had no remote when it
 * was first seen, so a `git:` pin, local or shared, does not short-circuit and a
 * remote id may replace it; nothing replaces a remote id with a `git:` one, which would
 * orphan everything already filed under it, and an id stored before the
 * repo's first commit still holds once it has one. A `git:` id is never
 * stored: the commit it derives from is always there to derive it again.
 */
export const resolveScopeId = async (
	root: string,
	opts: Pick<DetectOptions, "home">,
): Promise<string> => {
	const local = await readScopePin(await localPinPath(opts.home, root));
	if (local && !local.startsWith("git:")) return local;

	const pinned = await readScopePin(join(root, SCOPE_FILE));
	if (pinned && !pinned.startsWith("git:")) return pinned;

	const firstCommit = (
		await git(root, ["rev-list", "--max-parents=0", "HEAD"])
	)?.split("\n")[0];
	const stored = await DetectedScopes.read(opts.home, root);
	// A different first commit is another repo cloned where this one was.
	if (
		stored &&
		(stored.firstCommit === undefined || stored.firstCommit === firstCommit)
	) {
		// Stored before the repo's first commit: from now on, that commit is the repo.
		if (stored.firstCommit === undefined && firstCommit) {
			await DetectedScopes.write(opts.home, root, { ...stored, firstCommit });
		}
		return stored.scopeId;
	}

	const remote = await remoteUrl(root);
	if (remote) {
		const scopeId = normalizeGitUrl(remote);
		await DetectedScopes.write(opts.home, root, { scopeId, firstCommit });
		return scopeId;
	}

	if (firstCommit) return `git:${firstCommit.slice(0, 12)}`;

	return local ?? pinned ?? root;
};

/**
 * Friendly display name: the last segment of a separator-bearing id — the repo
 * half of `host/owner/repo`, the folder of a path fallback — and otherwise the
 * bare id itself, which is what someone pinning a scope typed and expects back.
 */
export const resolveProjectName = (scopeId: string): string =>
	scopeId.split("/").pop() || scopeId;

/** The name of the nearest enclosing package, walking up to the project root. */
const nearestPackageName = async (
	cwd: string,
	root: string,
): Promise<string | null> => {
	// Both sides canonical, or the stop check never fires on a symlinked path and
	// the walk escapes the project to whatever package.json sits above it.
	let dir = await canonical(cwd);
	const stop = await canonical(root);

	for (;;) {
		try {
			const raw = await readFile(join(dir, "package.json"), "utf8");
			const name = (JSON.parse(raw) as { name?: unknown }).name;
			if (typeof name === "string" && name.length > 0) return name;
		} catch {
			// Keep walking.
		}
		if (dir === stop) return null;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
};

/**
 * Extensions become query params on the scope URI. They record where a task was
 * filed from; a scope-family match ignores them, so they never hide a task.
 */
const detectExtensions = async (
	cwd: string,
	root: string,
): Promise<Record<string, string>> => {
	const extensions: Record<string, string> = {};

	const pkg = await nearestPackageName(cwd, root);
	if (pkg) extensions.package = pkg;

	const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	// Detached HEAD reports the literal "HEAD" — not a branch anyone named.
	if (branch && branch !== "HEAD") extensions.branch = branch;

	return extensions;
};

/**
 * Resolve `cwd` to its project scope, or null when it sits in no project.
 *
 * Everything below the `--scope` flag lives here: a host runs this and filters
 * on `scopeUri`, and the answer is the same from the repo root, from a nested
 * package, or from a worktree.
 */
export const detectScope = async (
	cwd: string,
	opts: DetectOptions,
): Promise<ProjectScope | null> => {
	const root = await findProjectRoot(cwd, opts.home);
	if (!root) return null;

	const scopeId = await resolveScopeId(root, opts);
	const extensions =
		opts.detectExtensions === false ? {} : await detectExtensions(cwd, root);

	return {
		root,
		scopeId,
		name: resolveProjectName(scopeId),
		extensions,
		scopeUri: ScopeUri.format({
			scopeId,
			extensions: Object.keys(extensions).length > 0 ? extensions : undefined,
		}),
	};
};
