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
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { promisify } from "node:util";
import { ScopeUri } from "./uri";

const run = promisify(execFile);

/** The directory that marks a project root and holds its pinned scope. */
export const MARKER_DIR = ".kabane";

/** The pin `kabane init --scope` writes, and the detector's cache. */
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
	/** KABANE_HOME. Guards the walk from mistaking `~/.kabane` for a project. */
	home: string;
	/** Skip `branch`/`package` detection. Default: detect. */
	detectExtensions?: boolean;
	/**
	 * A pin written by another tracker over the same database, consulted after
	 * Cabane's own pin and before git. A host that shares a database has to
	 * honour the id already filed there: resolving the same repo to its remote
	 * id instead would be a different scope, and every existing task would
	 * vanish from the filter.
	 */
	legacyPin?: (root: string) => Promise<string | null>;
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
 * Git fallback for repos with no marker directory yet.
 *
 * A worktree reports its own toplevel, which would give each worktree a scope
 * of its own; following `--git-common-dir` back to the main checkout keeps a
 * worktree filing under the project it branched from.
 */
const findGitRoot = async (
	startDir: string,
	homeParent: string,
): Promise<string | null> => {
	const toplevel = await git(startDir, ["rev-parse", "--show-toplevel"]);
	if (!toplevel || isHomeParent(toplevel, homeParent)) return null;

	const commonDir = await git(startDir, ["rev-parse", "--git-common-dir"]);
	// A relative common dir (".git") is the main checkout; an absolute one means
	// this is a worktree pointing back at the main repo's git dir.
	if (!commonDir || !isAbsolute(commonDir)) return toplevel;

	const mainGitDir = commonDir.includes("/worktrees/")
		? (commonDir.split("/worktrees/")[0] as string)
		: commonDir;
	const mainRoot = await canonical(dirname(mainGitDir));
	return isHomeParent(mainRoot, homeParent) ? null : mainRoot;
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

const scopePinPath = (root: string): string => join(root, SCOPE_FILE);

const readScopePin = async (root: string): Promise<string | null> => {
	try {
		const value = (await readFile(scopePinPath(root), "utf8")).trim();
		return value.length > 0 ? value : null;
	} catch {
		return null;
	}
};

/**
 * Cache a resolved id as the project's pin so later runs skip the git probes.
 *
 * One-way: a `git:` id is a placeholder for a repo that had no remote when it
 * was first seen, so a real remote id may replace it — never the reverse, which
 * would orphan everything already filed under the remote id. Best-effort; a
 * read-only checkout still resolves, it just re-probes each time.
 */
const writeScopePin = async (root: string, scopeId: string): Promise<void> => {
	const current = await readScopePin(root);
	if (current && !current.startsWith("git:")) return;
	if (current === scopeId) return;

	try {
		await mkdir(join(root, MARKER_DIR), { recursive: true });
		await writeFile(scopePinPath(root), `${scopeId}\n`);
	} catch {
		// Caching is optional.
	}
};

/**
 * Resolve the stable scope id for a project root (ADR-009 cascade):
 * pin → legacy pin → git remote → first commit → path.
 *
 * A `git:` pin does not short-circuit: it is the cascade's own fallback, and
 * skipping it lets a repo that has since gained a remote upgrade to it. The
 * legacy pin is read but never cached — nothing should rewrite another tool's
 * answer into Cabane's file behind the user's back.
 */
export const resolveScopeId = async (
	root: string,
	legacyPin?: DetectOptions["legacyPin"],
): Promise<string> => {
	const pinned = await readScopePin(root);
	if (pinned && !pinned.startsWith("git:")) return pinned;

	const legacy = await legacyPin?.(root);
	if (legacy && !legacy.startsWith("git:")) return legacy;

	const remote = await remoteUrl(root);
	if (remote) {
		const normalized = normalizeGitUrl(remote);
		await writeScopePin(root, normalized);
		return normalized;
	}

	const firstCommit = (
		await git(root, ["rev-list", "--max-parents=0", "HEAD"])
	)?.split("\n")[0];
	if (firstCommit) {
		const id = `git:${firstCommit.slice(0, 12)}`;
		await writeScopePin(root, id);
		return id;
	}

	return pinned ?? legacy ?? root;
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

	const scopeId = await resolveScopeId(root, opts.legacyPin);
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
