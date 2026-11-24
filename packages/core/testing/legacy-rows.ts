/**
 * Rows as a build before migration 14 wrote them, for tests that stamp a
 * database at an older version and seed it: today's storage writes the record,
 * which an old schema does not have. Each helper mirrors the `Planner` call it
 * stands in for, inserts with raw SQL, and captures nothing.
 */

import { monotonicFactory } from "ulid";
import type { Db } from "../db/port";
import type { Result } from "../result";
import { withDb } from "../runtime";
import type { WorkRef } from "../schemas";
import {
	columnExists,
	derivePrefix,
	normalizeOptionalScopeUri,
} from "../storage/helpers";
import { Oplog } from "../storage/oplog";

/** Ids rise within one process, as the old storage minted them, so `ORDER BY id` is write order. */
const ulid = monotonicFactory();

const now = () => new Date().toISOString();

const prefixOf = (scopeUri: string | undefined): string => {
	const prefix = derivePrefix(scopeUri);
	if (!prefix.ok) throw prefix.error;
	return prefix.value;
};

const nextLabel = (
	db: Db,
	prefix: string,
	scopeUri: string | undefined,
): string => {
	db.run(
		`INSERT INTO sequences (prefix, next_number, scope_uri, created_at) VALUES (?, 1, ?, ?)
		 ON CONFLICT(prefix) DO UPDATE SET next_number = next_number + 1`,
		[prefix, scopeUri ?? null, now()],
	);
	const row = db
		.query<{ n: number }, [string]>(
			"SELECT next_number AS n FROM sequences WHERE prefix = ?",
		)
		.get(prefix);
	return `${prefix}-${row?.n ?? 1}`;
};

const run = <T>(base: string, fn: (db: Db) => T): Promise<Result<T>> =>
	withDb(base, fn);

/** What the old build's capture did: an insert op with the row, once sync is armed. */
const capture = (db: Db, tbl: string, id: string): void => {
	const state = Oplog.getState(db);
	if (!state.ok) throw state.error;
	if (state.value === undefined) return;
	const row = db
		.query<Record<string, unknown>, [string]>(
			`SELECT * FROM ${tbl} WHERE id = ?`,
		)
		.get(id);
	if (!row) return;
	const recorded = Oplog.record(
		db,
		Oplog.snapshotOp({
			deviceId: state.value.deviceId,
			tbl,
			op: "insert",
			row,
			capturedAt: now(),
		}),
	);
	if (!recorded.ok) throw recorded.error;
};

export namespace Legacy {
	export const addTask = (
		base: string,
		draft: {
			title: string;
			description?: string;
			kind?: string;
			state?: string;
			scopeUri?: string;
			scopeRefs?: { scopeUri: string; role: string }[];
			assignee?: string;
			parentTaskId?: string;
			projectId?: string;
			verification?: Record<string, unknown>;
			provenance?: { discoveredBy?: string };
		},
	) =>
		run(base, (db) => {
			const id = ulid();
			const scope = normalizeOptionalScopeUri(draft.scopeUri);
			if (!scope.ok) throw scope.error;
			const scopeUri = scope.value;
			const shortId = nextLabel(db, prefixOf(scopeUri), scopeUri);
			const at = now();
			db.run(
				`INSERT INTO tasks
				   (id, short_id, title, description, kind, state, scope_uri, scope_refs, assignee,
				    parent_task_id, project_id, verification, discovered_at, discovered_by, tags,
				    updated_by, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`,
				[
					id,
					shortId,
					draft.title,
					draft.description ?? null,
					draft.kind ?? "task",
					draft.state ?? "inbox",
					scopeUri ?? null,
					draft.scopeRefs ? JSON.stringify(draft.scopeRefs) : null,
					draft.assignee ?? null,
					draft.parentTaskId ?? null,
					draft.projectId ?? null,
					draft.verification ? JSON.stringify(draft.verification) : null,
					at,
					draft.provenance?.discoveredBy ?? null,
					"kabane://actor/unknown",
					at,
					at,
				],
			);
			capture(db, "tasks", id);
			return { id, shortId, title: draft.title, scopeUri };
		});

	export const addComment = (
		base: string,
		draft: {
			taskId: string;
			author: string;
			authorType: string;
			content: string;
			kind?: string;
		},
	) =>
		run(base, (db) => {
			const id = ulid();
			const kinded = columnExists(db, "task_comments", "kind");
			db.run(
				`INSERT INTO task_comments
				   (id, task_id, author, author_type, content, updated_by, created_at${kinded ? ", kind" : ""})
				 VALUES (?, ?, ?, ?, ?, ?, ?${kinded ? ", ?" : ""})`,
				[
					id,
					draft.taskId,
					draft.author,
					draft.authorType,
					draft.content,
					draft.author,
					now(),
					...(kinded ? [draft.kind ?? "comment"] : []),
				],
			);
			capture(db, "task_comments", id);
			return { id };
		});

	export const addWorkLog = (
		base: string,
		input: {
			taskId: string;
			refs: { uri: string; label?: string }[];
			note?: string;
			addedBy?: string;
			addedByType?: "human" | "ai";
		},
	) =>
		run(base, (db) => {
			const id = ulid();
			const at = now();
			const refs: WorkRef[] = input.refs.map((r) => ({
				uri: r.uri,
				label: r.label,
				addedAt: at,
				addedBy: input.addedBy,
				addedByType: input.addedByType,
			}));
			db.run(
				`INSERT INTO task_work_log (id, task_id, refs, note, updated_by, created_at)
				 VALUES (?, ?, ?, ?, ?, ?)`,
				[
					id,
					input.taskId,
					JSON.stringify(refs),
					input.note ?? null,
					"kabane://actor/unknown",
					at,
				],
			);
			capture(db, "task_work_log", id);
			return { id, refs };
		});

	export const addContextRef = (
		base: string,
		input: {
			taskId: string;
			uri: string;
			kind: string;
			label?: string;
			note?: string;
			addedBy?: string;
			addedByType?: string;
		},
	) =>
		run(base, (db) => {
			const id = ulid();
			db.run(
				`INSERT INTO task_context_refs
				   (id, task_id, uri, kind, label, note, added_by, added_by_type, added_at, updated_by)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					input.taskId,
					input.uri,
					input.kind,
					input.label ?? null,
					input.note ?? null,
					input.addedBy ?? null,
					input.addedByType ?? null,
					now(),
					"kabane://actor/unknown",
				],
			);
			capture(db, "task_context_refs", id);
			return { id };
		});

	export const addLink = (
		base: string,
		draft: { sourceId: string; targetId: string; type: string; note?: string },
	) =>
		run(base, (db) => {
			const id = ulid();
			db.run(
				`INSERT INTO task_links (id, source_id, target_id, type, note, updated_by, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					draft.sourceId,
					draft.targetId,
					draft.type,
					draft.note ?? null,
					"kabane://actor/unknown",
					now(),
				],
			);
			capture(db, "task_links", id);
			return { id };
		});
}
