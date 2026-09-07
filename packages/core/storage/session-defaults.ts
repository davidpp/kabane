/**
 * Planner Storage — Session Defaults
 *
 * Per-key JSON file store for planner defaults (default project / parent task)
 * that new tasks inherit. Keyed by the current Claude Code session id, falling
 * back to the resolved project scope. Mirrors the StatusLine file-state pattern
 * (packages/core/statusline/namespace.ts).
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { traced } from "../observability";
import { err, ok, type Result } from "../result";
import { Runtime } from "../runtime";

import type { Project, ProjectState, Task, TaskState } from "../schemas";
import {
	type SessionDefaults,
	SessionDefaultsSchema,
} from "../schemas/session-defaults";
import { Planner as Projects } from "./projects";
import { Planner as Tasks } from "./tasks";

/** Patch accepted by setDefaults — only the inheritable fields. */
export type SessionDefaultsPatch = Partial<
	Pick<SessionDefaults, "projectId" | "parentTaskId">
>;

// ----------------------------------------------------------
// Inheritance (shared apply point — consulted by CLI `add`
// and the tRPC `add` path so both surfaces inherit identically)
// ----------------------------------------------------------

/** Resolved placement for a new task after applying session defaults. */
export type ResolvedPlacement = {
	projectId?: string;
	parentTaskId?: string;
	inheritedProject: boolean;
	inheritedParent: boolean;
};

/** Explicit placement flags parsed from `add` options. */
export type ExplicitPlacement = {
	/** True when --project was passed at all (including "none"). */
	project: boolean;
	projectId?: string;
	/** True when --parent was passed at all (including "none"). */
	parent: boolean;
	parentTaskId?: string;
};

/**
 * Apply session defaults to explicit placement flags. Pure — the inheritance
 * matrix lives here so it can be tested without the CLI's process.exit paths.
 *
 * Rules: an explicit flag always wins (including a "none" sentinel, which
 * arrives as `project: true` / `parent: true` with an undefined id). A default
 * is only inherited when the flag was absent entirely.
 */
export const applyDefaults = (
	explicit: ExplicitPlacement,
	defaults: { projectId?: string; parentTaskId?: string } | null,
): ResolvedPlacement => {
	const placement: ResolvedPlacement = {
		projectId: explicit.projectId,
		parentTaskId: explicit.parentTaskId,
		inheritedProject: false,
		inheritedParent: false,
	};

	if (!explicit.project && defaults?.projectId) {
		placement.projectId = defaults.projectId;
		placement.inheritedProject = true;
	}
	if (!explicit.parent && defaults?.parentTaskId) {
		placement.parentTaskId = defaults.parentTaskId;
		placement.inheritedParent = true;
	}

	return placement;
};

/** Project states that must not be silently inherited as a default. */
const DEAD_PROJECT_STATES = new Set<ProjectState>(["done", "archived"]);
/** Task states that must not be silently inherited as a default parent. */
const DEAD_TASK_STATES = new Set<TaskState>(["done", "cancelled"]);

/** Outcome of re-validating stored defaults against current DB liveness. */
export type InheritedDefaultsValidation = {
	/** Only the fields that resolve to a live project/parent. */
	live: { projectId?: string; parentTaskId?: string };
	/** One warning line per stale field that was dropped. */
	warnings: string[];
	/** Fields dropped as stale — cleared from storage so the warning stops. */
	clearedFields: Array<"projectId" | "parentTaskId">;
};

/**
 * Re-validate stored defaults at inherit time. Pure — lookups are passed in as
 * their Results so the decision matrix (live / stale / not-found / lookup-error)
 * is testable without a DB. A missing record, a dead state, or a failed lookup
 * all drop the field (skip inheritance) rather than block `add`.
 */
export const validateInheritedDefaults = (
	stored: { projectId?: string; parentTaskId?: string },
	lookups: {
		project?: Result<Pick<Project, "id" | "shortId" | "state"> | null>;
		parent?: Result<Pick<Task, "id" | "shortId" | "state"> | null>;
	},
): InheritedDefaultsValidation => {
	const live: { projectId?: string; parentTaskId?: string } = {};
	const warnings: string[] = [];
	const clearedFields: Array<"projectId" | "parentTaskId"> = [];

	if (stored.projectId) {
		const rec = lookups.project?.ok ? lookups.project.value : null;
		if (rec && !DEAD_PROJECT_STATES.has(rec.state)) {
			live.projectId = stored.projectId;
		} else {
			const label = rec
				? (rec.shortId ?? rec.id.slice(0, 8))
				: stored.projectId.slice(0, 8);
			warnings.push(
				`⚠ default project ${label} no longer active — not applied; run 'jake plan use --clear'`,
			);
			clearedFields.push("projectId");
		}
	}

	if (stored.parentTaskId) {
		const rec = lookups.parent?.ok ? lookups.parent.value : null;
		if (rec && !DEAD_TASK_STATES.has(rec.state)) {
			live.parentTaskId = stored.parentTaskId;
		} else {
			const label = rec
				? (rec.shortId ?? rec.id.slice(0, 8))
				: stored.parentTaskId.slice(0, 8);
			warnings.push(
				`⚠ default parent ${label} no longer active — not applied; run 'jake plan use --clear'`,
			);
			clearedFields.push("parentTaskId");
		}
	}

	return { live, warnings, clearedFields };
};

/** Placement resolved from stored defaults, plus any stale-drop warnings. */
export type AppliedSessionDefaults = ResolvedPlacement & { warnings: string[] };

/**
 * Daemon-held "active defaults key" for the MCP surface.
 *
 * SCOPING: per-process, in-memory only. It is stamped by `planner_use` and read
 * by `planner_add`; it lives in the running server (the 8289 process), dies with
 * the daemon, and is DISTINCT from CLI session keys (which are derived per-call
 * from env/scope via {@link Planner.resolveDefaultsKey}). Single-user server:
 * the last `planner_use` wins. Undefined until the first `planner_use`, so a
 * bare `planner_add` inherits nothing.
 */
let mcpDefaultsKey: string | undefined;

/** Sanitize a defaults key into a filesystem-safe filename fragment. */
const sanitizeKey = (key: string): string => key.replace(/[^a-zA-Z0-9]/g, "_");

/** Absolute path to the JSON file backing a defaults key. */
const defaultsFilePath = (basePath: string, key: string): string =>
	join(basePath, "state", `planner-defaults-${sanitizeKey(key)}.json`);

export namespace Planner {
	/**
	 * Resolve the defaults key for the current context.
	 *
	 * Precedence:
	 * 1. Session env — CLAUDE_CODE_SESSION_ID ?? CLAUDE_SESSION_ID → "session:<id>"
	 * 2. Scope fallback — the host's ScopeResolver port → "scope:<projectId>"
	 * 3. null when neither is available.
	 */
	export const resolveDefaultsKey = traced(
		"planner.resolveDefaultsKey",
		async (cwd: string): Promise<Result<string | null>> => {
			try {
				const sessionId =
					process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CLAUDE_SESSION_ID;
				if (sessionId) {
					return ok(`session:${sessionId}`);
				}

				const projectId = await Runtime.scopeResolver()(cwd);
				if (projectId) {
					return ok(`scope:${projectId}`);
				}

				return ok(null);
			} catch (e) {
				return err(e instanceof Error ? e : new Error(String(e)));
			}
		},
	);

	/**
	 * Read the defaults for a key, or null if none are stored.
	 */
	export const getDefaults = traced(
		"planner.getDefaults",
		async (
			basePath: string,
			key: string,
		): Promise<Result<SessionDefaults | null>> => {
			try {
				const content = await readFile(
					defaultsFilePath(basePath, key),
					"utf-8",
				);
				const parsed = SessionDefaultsSchema.safeParse(JSON.parse(content));
				if (!parsed.success) {
					return err(
						new Error(`Invalid session defaults: ${parsed.error.message}`),
					);
				}
				return ok(parsed.data);
			} catch (e) {
				if (e instanceof Error && "code" in e && e.code === "ENOENT") {
					return ok(null);
				}
				return err(e instanceof Error ? e : new Error(String(e)));
			}
		},
	);

	/**
	 * Merge a patch into the stored defaults for a key and persist them.
	 */
	export const setDefaults = traced(
		"planner.setDefaults",
		async (
			basePath: string,
			key: string,
			patch: SessionDefaultsPatch,
		): Promise<Result<SessionDefaults>> => {
			try {
				const existing = await getDefaults(basePath, key);
				if (!existing.ok) {
					return existing;
				}

				const next: SessionDefaults = {
					key,
					projectId: patch.projectId ?? existing.value?.projectId,
					parentTaskId: patch.parentTaskId ?? existing.value?.parentTaskId,
					updatedAt: new Date().toISOString(),
				};

				const stateDir = join(basePath, "state");
				await mkdir(stateDir, { recursive: true });
				await writeFile(defaultsFilePath(basePath, key), JSON.stringify(next));
				return ok(next);
			} catch (e) {
				return err(e instanceof Error ? e : new Error(String(e)));
			}
		},
	);

	/**
	 * Remove the stored defaults for a key. No-op if none exist.
	 */
	export const clearDefaults = traced(
		"planner.clearDefaults",
		async (basePath: string, key: string): Promise<Result<void>> => {
			try {
				await unlink(defaultsFilePath(basePath, key));
				return ok(undefined);
			} catch (e) {
				if (e instanceof Error && "code" in e && e.code === "ENOENT") {
					return ok(undefined);
				}
				return err(e instanceof Error ? e : new Error(String(e)));
			}
		},
	);

	/**
	 * Fixed defaults key for the MCP surface.
	 *
	 * The MCP caller has no session env (no CLAUDE_*_SESSION_ID, no per-request
	 * cwd), so `planner_use` writes under this process-level key and `planner_add`
	 * reads it back. See {@link mcpDefaultsKey} for the daemon-held active pointer.
	 */
	export const MCP_DEFAULTS_KEY = "mcp:surface";

	/** Stamp the daemon-held MCP-surface defaults key (set by `planner_use`). */
	export const setMcpDefaultsKey = (key: string): void => {
		mcpDefaultsKey = key;
	};

	/** Read the daemon-held MCP-surface defaults key, or undefined if unset. */
	export const getMcpDefaultsKey = (): string | undefined => mcpDefaultsKey;

	/** Forget the daemon-held MCP-surface key (on `planner_clearDefaults`). */
	export const clearMcpDefaultsKey = (): void => {
		mcpDefaultsKey = undefined;
	};

	/**
	 * Resolve stored defaults for `key` into a placement for a new task.
	 *
	 * The shared inheritance apply point consulted by BOTH `add` surfaces (CLI
	 * handler + tRPC `add`) so they inherit project/parent identically. Loads the
	 * stored defaults, re-validates their liveness (the JJAK-935 stale guard —
	 * dead project/parent is dropped, warned, and cleared from storage so the
	 * hazard doesn't silently misplace the task or repeat), then applies the
	 * survivors under {@link applyDefaults}. Never blocks `add`: a missing file,
	 * a lookup error, or a stale field degrades to skip-inheritance.
	 */
	export const applySessionDefaults = async (
		basePath: string,
		key: string,
		explicit: ExplicitPlacement,
	): Promise<AppliedSessionDefaults> => {
		const stored = await getDefaults(basePath, key);
		if (!stored.ok || !stored.value) {
			return { ...applyDefaults(explicit, null), warnings: [] };
		}

		const validation = validateInheritedDefaults(stored.value, {
			project: stored.value.projectId
				? await Projects.getProject(basePath, stored.value.projectId)
				: undefined,
			parent: stored.value.parentTaskId
				? await Tasks.getTask(basePath, stored.value.parentTaskId)
				: undefined,
		});

		// setDefaults merges (can't null a field), so rewrite from scratch: drop
		// the whole file, then re-persist any survivors. Best-effort — never
		// blocks add.
		if (validation.clearedFields.length > 0) {
			await clearDefaults(basePath, key);
			if (validation.live.projectId || validation.live.parentTaskId) {
				await setDefaults(basePath, key, validation.live);
			}
		}

		return {
			...applyDefaults(explicit, validation.live),
			warnings: validation.warnings,
		};
	};
}
