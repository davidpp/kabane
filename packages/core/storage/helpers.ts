/**
 * Planner Storage Helpers
 *
 * Shared constants, ID generation, row converters, and schema introspection
 * used across all domain files. The migration list is in `migrations.ts`.
 */

import { ulid } from "ulid";
import { z } from "zod";
import type { Db } from "../db/port";
import { TABLES } from "../db/tables";
import { err, ok, type Result } from "../result";
import type {
	AgentActivity,
	AgentSession,
	Project,
	Task,
	TaskComment,
	TaskContextRef,
	TaskLink,
	TaskWorkLog,
	UpstreamLink,
	WorkRef,
} from "../schemas";
import { UpstreamLinkSchema } from "../schemas";
import { ScopeUri } from "../scope/uri";

export { TABLES };

// ============================================================
// Db Helpers
// ============================================================

export const generateId = (): string => ulid();

/** ULID length for full ID detection */
export const ULID_LENGTH = 26;

/**
 * Short ID pattern with legacy compatibility.
 * Accepts both new JXXX-N format and older 2-4 char prefixes.
 */
export const SHORT_ID_PATTERN = /^[A-Z0-9]{2,4}-\d+$/i;

// ============================================================
// Scope Normalization
// ============================================================

/** Short-ID prefix for tasks with no scope at all. */
export const UNSCOPED_PREFIX = "JALL";

/**
 * Canonical form of a scope ID: no surrounding whitespace, no trailing slashes.
 * A LEADING slash is kept — nine live scopes are absolute filesystem paths from
 * the ADR-009 path fallback, and "/Users/x" is not the same scope as "Users/x".
 */
const canonicalScopeId = (rawScopeId: string): string =>
	rawScopeId.trim().replace(/\/+$/, "");

/**
 * Extra tidying for a scope ID typed as a bare identifier: collapse repeated
 * slashes. NOT applied to a parsed URI's scope ID — a stored scope ID may
 * legitimately contain "://" (five live tasks sit under "project://desk"), and
 * collapsing there rewrites it to "project:/desk", silently moving those rows
 * to a scope nothing queries.
 */
const collapseSlashes = (scopeId: string): string =>
	scopeId.replace(/\/{2,}/g, "/");

/**
 * Case-fold a scope ID that arrived as a bare identifier.
 *
 * Bare ids are typed by humans and LLMs — the add tool documents them as valid
 * input — so "jake", "JAKE" and "Jake" are one scope spelled three ways and
 * have to converge. Ids carrying a separator are exempt: those come from the
 * ADR-009 cascade (a filesystem path, or host/owner/repo off a git remote)
 * where the case on disk or on the remote is authoritative, and folding would
 * orphan what the cascade already wrote — 248 memories sit under
 * /Users/davidpaquet/Projects/botpress alone.
 */
const foldBareScopeId = (scopeId: string): string =>
	scopeId.includes("/") ? scopeId : scopeId.toLowerCase();

/**
 * Normalize a scope value to its canonical scope URI.
 *
 * - Bare identifiers like "jake" become "jake://scope/jake", case-folded
 *   unless path-shaped (see foldBareScopeId)
 * - A full jake://scope/... URI keeps its case verbatim: it comes from
 *   `Scope.resolve` or an explicit `project.id`, both authoritative
 * - Parseable input is re-formatted, not merely accepted: " jake",
 *   "jake://scope/jake/" and "jake://scope/jake" all land on the same string,
 *   so a near-miss can't hide from a canonical filter the way a JALL misfile
 *   used to. Non-canonical input is corrected silently; only input with no
 *   usable scope ID is rejected.
 * - Idempotent: normalize(normalize(x)) === normalize(x)
 */
export const normalizeScopeUri = (scope: string): Result<string> => {
	const parsed = ScopeUri.parse(scope.trim());

	// A value carrying a scheme is a URI attempt, not a bare scope ID —
	// wrapping it would bury the malformed URI inside a valid-looking one.
	if (!parsed.ok && scope.includes("://")) {
		return err(
			new Error(
				`Invalid scope URI: "${scope}". Expected jake://scope/<scopeId>.`,
			),
		);
	}

	const scopeId = parsed.ok
		? canonicalScopeId(parsed.value.scopeId)
		: foldBareScopeId(collapseSlashes(canonicalScopeId(scope)));
	if (!scopeId) {
		return err(
			new Error(
				`Invalid scope: "${scope}". Expected a scope URI (jake://scope/<scopeId>) or a bare scope ID.`,
			),
		);
	}

	return ok(
		ScopeUri.format({
			scopeId,
			extensions: parsed.ok ? parsed.value.extensions : undefined,
		}),
	);
};

/** Normalize a scope that may be absent; absent (or empty) stays absent. */
export const normalizeOptionalScopeUri = (
	scope?: string | null,
): Result<string | undefined> =>
	scope ? normalizeScopeUri(scope) : ok(undefined);

// ============================================================
// Short ID Generation (Linear-style IDs)
// ============================================================

/**
 * Derive a J + 3-char prefix from a scope URI.
 *
 * No scope at all is legitimate and yields JALL. A scope that cannot be parsed
 * is an error rather than a silent JALL — a misfiled task is worse than a
 * rejected one.
 */
export const derivePrefix = (scopeUri?: string): Result<string> => {
	if (!scopeUri) {
		return ok(UNSCOPED_PREFIX);
	}

	const scopeIdResult = ScopeUri.getScopeId(scopeUri);
	if (!scopeIdResult.ok) {
		return err(
			new Error(
				`Cannot derive a short-ID prefix from scope "${scopeUri}": ${scopeIdResult.error.message}`,
			),
		);
	}

	const segments = scopeIdResult.value.split("/").filter(Boolean);
	const rawSegment = segments[segments.length - 1] ?? scopeIdResult.value;
	const normalized = rawSegment.toUpperCase().replace(/[^A-Z0-9]/g, "");
	if (!normalized) {
		return err(
			new Error(
				`Cannot derive a short-ID prefix from scope "${scopeUri}": scope ID has no alphanumeric characters`,
			),
		);
	}

	return ok(`J${normalized.slice(0, 3).padEnd(3, "X")}`);
};

/**
 * Get next sequence number for a prefix (atomic increment).
 * Creates the sequence entry if it doesn't exist.
 */
export const nextSequence = (
	db: Db,
	prefix: string,
	scopeUri?: string,
): number => {
	const now = new Date().toISOString();

	// Try to insert new sequence (will fail if exists)
	try {
		db.run(
			`INSERT INTO ${TABLES.sequences} (prefix, next_number, scope_uri, created_at) VALUES (?, 1, ?, ?)`,
			[prefix, scopeUri ?? null, now],
		);
	} catch {
		// Sequence exists, increment it
		db.run(
			`UPDATE ${TABLES.sequences} SET next_number = next_number + 1 WHERE prefix = ?`,
			[prefix],
		);
	}

	const row = db
		.query(`SELECT next_number FROM ${TABLES.sequences} WHERE prefix = ?`)
		.get(prefix) as { next_number: number };

	return row.next_number;
};

/**
 * Generate a human-friendly short ID (e.g., JDES-1, JJAK-42).
 * Takes an already-derived prefix so callers surface `derivePrefix` failures
 * before opening a write.
 */
export const generateShortId = (
	db: Db,
	prefix: string,
	scopeUri?: string,
): string => {
	const num = nextSequence(db, prefix, scopeUri);
	return `${prefix}-${num}`;
};

/**
 * Family match for a scope filter: the canonical base URI plus its
 * extension-carrying variants. Normalizes first, so a bare "jake" filters the
 * same rows as "jake://scope/jake". An unusable filter returns undefined and
 * the caller falls back to an exact match on the raw value.
 */
export const buildScopeFamilyMatch = (
	scopeUri: string,
): { baseScopeUri: string; queryPattern: string } | undefined => {
	const normalized = normalizeScopeUri(scopeUri);
	if (!normalized.ok) return undefined;

	const scopeIdResult = ScopeUri.getScopeId(normalized.value);
	if (!scopeIdResult.ok) return undefined;

	const baseScopeUri = ScopeUri.fromScopeId(scopeIdResult.value);
	return {
		baseScopeUri,
		queryPattern: `${baseScopeUri}?%`,
	};
};

// ============================================================
// Row Converters
// ============================================================

export const rowToTask = (row: Record<string, unknown>): Task => ({
	id: row.id as string,
	shortId: (row.short_id as string) || undefined,
	title: row.title as string,
	description: (row.description as string) || undefined,
	kind: (row.kind as Task["kind"]) || "task",
	state: row.state as Task["state"],
	priority: row.priority as Task["priority"],
	scopeUri: (row.scope_uri as string) || undefined,
	scopeRefs: row.scope_refs ? JSON.parse(row.scope_refs as string) : undefined,
	deadline: (row.deadline as string) || undefined,
	deferUntil: (row.defer_until as string) || undefined,
	completedAt: (row.completed_at as string) || undefined,
	provenance: {
		source: row.source as Task["provenance"]["source"],
		sourceId: (row.source_id as string) || undefined,
		sourceUrl: (row.source_url as string) || undefined,
		discoveredAt: row.discovered_at as string,
		discoveredBy: (row.discovered_by as string) || undefined,
	},
	confidence: row.confidence != null ? (row.confidence as number) : undefined,
	assignee: (row.assignee as string) || undefined,
	parentTaskId: (row.parent_task_id as string) || undefined,
	projectId: (row.project_id as string) || undefined,
	needsReview: Boolean(row.needs_review),
	reviewedAt: (row.reviewed_at as string) || undefined,
	reviewedBy: (row.reviewed_by as string) || undefined,
	verification: row.verification
		? JSON.parse(row.verification as string)
		: undefined,
	tags: row.tags ? JSON.parse(row.tags as string) : [],
	context: (row.context as string) || undefined,
	updatedBy: (row.updated_by as string) || undefined,
	version: typeof row.version === "number" ? row.version : 1,
	createdAt: row.created_at as string,
	updatedAt: row.updated_at as string,
});

export const rowToProject = (row: Record<string, unknown>): Project => ({
	id: row.id as string,
	shortId: (row.short_id as string) || undefined,
	title: row.title as string,
	description: (row.description as string) || undefined,
	state: row.state as Project["state"],
	scopeUri: (row.scope_uri as string) || undefined,
	createdAt: row.created_at as string,
	updatedAt: row.updated_at as string,
});

export const rowToLink = (row: Record<string, unknown>): TaskLink => ({
	id: row.id as string,
	sourceId: row.source_id as string,
	targetId: row.target_id as string,
	type: row.type as TaskLink["type"],
	note: (row.note as string) || undefined,
	createdAt: row.created_at as string,
});

export const rowToComment = (row: Record<string, unknown>): TaskComment => ({
	id: row.id as string,
	taskId: row.task_id as string,
	author: row.author as string,
	authorType: row.author_type as TaskComment["authorType"],
	content: row.content as string,
	createdAt: row.created_at as string,
	updatedAt: (row.updated_at as string) || undefined,
});

export const rowToWorkLog = (row: Record<string, unknown>): TaskWorkLog => ({
	id: row.id as string,
	taskId: row.task_id as string,
	refs: JSON.parse(row.refs as string) as WorkRef[],
	note: (row.note as string) || undefined,
	createdAt: row.created_at as string,
});

export const rowToContextRef = (
	row: Record<string, unknown>,
): TaskContextRef => ({
	id: row.id as string,
	taskId: row.task_id as string,
	uri: row.uri as string,
	kind: row.kind as string,
	label: (row.label as string) || undefined,
	note: (row.note as string) || undefined,
	addedBy: (row.added_by as string) || undefined,
	addedByType:
		(row.added_by_type as TaskContextRef["addedByType"]) || undefined,
	addedAt: row.added_at as string,
});

/**
 * Validate and convert a SQLite upstream-link row without trusting driver
 * output. This is the persistence boundary for the private snapshot.
 */
export const rowToUpstreamLink = (row: unknown): Result<UpstreamLink> => {
	const recordResult = z.record(z.unknown()).safeParse(row);
	if (!recordResult.success) {
		return err(
			new Error(`Invalid upstream-link row: ${recordResult.error.message}`),
		);
	}

	const record = recordResult.data;
	const linkResult = UpstreamLinkSchema.safeParse({
		id: record.id,
		taskId: record.task_id,
		provider: record.provider,
		externalId: record.external_id,
		identifier: record.identifier ?? undefined,
		url: record.url,
		title: record.title,
		createdAt: record.created_at,
		updatedAt: record.updated_at,
	});
	if (!linkResult.success) {
		return err(
			new Error(`Invalid upstream-link row: ${linkResult.error.message}`),
		);
	}

	return ok(linkResult.data);
};

export const rowToSession = (row: Record<string, unknown>): AgentSession => ({
	id: row.id as string,
	taskId: row.task_id as string,
	agent: row.agent as string,
	state: row.state as string,
	externalRef: (row.external_ref as string) || undefined,
	summary: (row.summary as string) || undefined,
	startedAt: row.started_at as string,
	lastActivityAt: row.last_activity_at as string,
	endedAt: (row.ended_at as string) || undefined,
});

export const rowToAgentActivity = (
	row: Record<string, unknown>,
): AgentActivity => ({
	id: row.id as string,
	sessionId: row.session_id as string,
	type: row.type as string,
	ephemeral: Boolean(row.ephemeral),
	severity: (row.severity as string) || undefined,
	category: (row.category as string) || undefined,
	context: (row.context as string) || undefined,
	body: row.body as string,
	createdAt: row.created_at as string,
});

// ============================================================
// Schema introspection
// ============================================================

/**
 * Check if a column exists in a table (for migrations)
 */
export const columnExists = (
	db: Db,
	table: string,
	column: string,
): boolean => {
	const rows = db.query(`PRAGMA table_info(${table})`).all() as {
		name: string;
	}[];
	return rows.some((r) => r.name === column);
};
