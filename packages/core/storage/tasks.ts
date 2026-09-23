/**
 * Planner Storage — Tasks & ID Resolution
 */

import { Events, PLANNER_EVENTS } from "../events";
import { err, ok, type Result } from "../result";
import { Runtime, withDb } from "../runtime";
import {
	type Task,
	type TaskDraft,
	TaskDraftSchema,
	type TaskQuery,
	type TaskUpdate,
	TaskUpdateSchema,
} from "../schemas";
import {
	buildScopeFamilyMatch,
	derivePrefix,
	generateId,
	generateShortId,
	normalizeOptionalScopeUri,
	rowToTask,
	SHORT_ID_PATTERN,
	TABLES,
	ULID_LENGTH,
} from "./helpers";
import { Oplog } from "./oplog";

export namespace Planner {
	// ----------------------------------------------------------
	// ID Resolution
	// ----------------------------------------------------------

	/**
	 * Resolve a task identifier to a full ULID.
	 *
	 * Supports multiple formats:
	 * - Full 26-char ULID: pass through unchanged
	 * - Short ID (JDES-123): lookup by short_id column
	 * - ULID prefix (01KED): prefix match on id column
	 * - Ambiguous matches return error with candidates
	 */
	export const resolveTaskId = async (
		basePath: string,
		input: string,
	): Promise<Result<string>> => {
		// Full ULID - return as-is
		if (input.length === ULID_LENGTH) {
			return ok(input);
		}

		// Short ID format (e.g., JDES-123) + legacy formats
		if (SHORT_ID_PATTERN.test(input)) {
			const result = await withDb(basePath, (db) => {
				const row = db
					.query(
						`SELECT id FROM ${TABLES.tasks} WHERE short_id = ? COLLATE NOCASE`,
					)
					.get(input.toUpperCase()) as { id: string } | null;
				return row;
			});

			if (!result.ok) return result;

			if (!result.value) {
				return err(new Error(`No task found with ID: ${input}`));
			}

			return ok(result.value.id);
		}

		// ULID prefix match (fallback for legacy/debugging)
		const result = await withDb(basePath, (db) => {
			const rows = db
				.query(
					`SELECT id, short_id, title FROM ${TABLES.tasks} WHERE id LIKE ?`,
				)
				.all(`${input}%`) as {
				id: string;
				short_id: string | null;
				title: string;
			}[];
			return rows;
		});

		if (!result.ok) return result;

		const matches = result.value;
		if (matches.length === 0) {
			return err(new Error(`No task found with ID prefix: ${input}`));
		}
		if (matches.length > 1) {
			const candidates = matches
				.map(
					(t) =>
						`  ${t.short_id || t.id.slice(0, 8)}  ${t.title.slice(0, 40)}${t.title.length > 40 ? "..." : ""}`,
				)
				.join("\n");
			return err(
				new Error(
					`Ambiguous ID prefix "${input}" matches ${matches.length} tasks:\n${candidates}`,
				),
			);
		}

		return ok(matches[0].id);
	};

	// ----------------------------------------------------------
	// Tasks
	// ----------------------------------------------------------

	export const addTask = async (
		basePath: string,
		draft: TaskDraft,
	): Promise<Result<Task>> => {
		const parseResult = TaskDraftSchema.safeParse(draft);
		if (!parseResult.success) {
			return err(new Error(`Invalid draft: ${parseResult.error.message}`));
		}

		// Normalized here, not at the caller: every surface (tRPC, MCP, CLI,
		// recipes, workflows) writes through this function, so a bare "jake" can
		// neither be stored raw nor fall through to the JALL prefix.
		const scopeResult = normalizeOptionalScopeUri(draft.scopeUri);
		if (!scopeResult.ok) return scopeResult;
		const scopeUri = scopeResult.value;

		const prefixResult = derivePrefix(scopeUri);
		if (!prefixResult.ok) return prefixResult;

		const result = await withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const id = generateId();
			const shortId = generateShortId(db, prefixResult.value, scopeUri);

			db.run(
				`INSERT INTO ${TABLES.tasks} (
          id, short_id, title, description, kind, state, priority,
          scope_uri, scope_refs,
          deadline, defer_until,
          source, source_id, source_url, discovered_at, discovered_by,
          confidence, assignee,
          parent_task_id, project_id, needs_review, reviewed_at, reviewed_by,
          verification,
          tags, context,
          updated_by,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					shortId,
					draft.title,
					draft.description ?? null,
					draft.kind ?? "task",
					draft.state ?? "inbox",
					draft.priority ?? "normal",
					scopeUri ?? null,
					draft.scopeRefs ? JSON.stringify(draft.scopeRefs) : null,
					draft.deadline ?? null,
					draft.deferUntil ?? null,
					draft.provenance?.source ?? "human",
					draft.provenance?.sourceId ?? null,
					draft.provenance?.sourceUrl ?? null,
					draft.provenance?.discoveredAt ?? now,
					draft.provenance?.discoveredBy ?? null,
					draft.confidence ?? null,
					draft.assignee ?? null,
					draft.parentTaskId ?? null,
					draft.projectId ?? null,
					draft.needsReview ? 1 : 0,
					null, // reviewedAt
					null, // reviewedBy
					draft.verification ? JSON.stringify(draft.verification) : null,
					JSON.stringify(draft.tags ?? []),
					draft.context ?? null,
					Runtime.actor(),
					now,
					now,
				],
			);
			Oplog.afterWrite(db, "tasks", "insert", id);

			return {
				id,
				shortId,
				title: draft.title,
				description: draft.description,
				kind: draft.kind ?? "task",
				state: draft.state ?? "inbox",
				priority: draft.priority ?? "normal",
				scopeUri,
				scopeRefs: draft.scopeRefs,
				deadline: draft.deadline,
				deferUntil: draft.deferUntil,
				completedAt: undefined,
				provenance: {
					source: draft.provenance?.source ?? "human",
					sourceId: draft.provenance?.sourceId,
					sourceUrl: draft.provenance?.sourceUrl,
					discoveredAt: draft.provenance?.discoveredAt ?? now,
					discoveredBy: draft.provenance?.discoveredBy,
				},
				confidence: draft.confidence,
				assignee: draft.assignee,
				parentTaskId: draft.parentTaskId,
				projectId: draft.projectId,
				needsReview: draft.needsReview ?? false,
				reviewedAt: undefined,
				reviewedBy: undefined,
				verification: draft.verification
					? { status: "pending" as const, ...draft.verification }
					: undefined,
				tags: draft.tags ?? [],
				context: draft.context,
				updatedBy: Runtime.actor(),
				version: 1,
				createdAt: now,
				updatedAt: now,
			};
		});

		// Emit event for SSE subscribers
		if (result.ok) {
			await Events.emit(PLANNER_EVENTS.TASK_CREATED, result.value);
		}

		return result;
	};

	export const getTask = async (
		basePath: string,
		id: string,
	): Promise<Result<Task | null>> => {
		return withDb(basePath, (db) => {
			// Try by ULID first, then by shortId for flexibility
			// This allows both "01ABC..." and "JDES-40" to work
			const row = db
				.query(`SELECT * FROM ${TABLES.tasks} WHERE id = ? OR short_id = ?`)
				.get(id, id) as Record<string, unknown> | null;

			return row ? rowToTask(row) : null;
		});
	};

	/**
	 * Find a task by its source ID (provenance.sourceId).
	 * Useful for finding linked tasks from emails, calendar events, etc.
	 */
	export const findBySourceId = async (
		basePath: string,
		sourceId: string,
	): Promise<Result<Task | null>> => {
		return withDb(basePath, (db) => {
			const row = db
				.query(`SELECT * FROM ${TABLES.tasks} WHERE source_id = ? LIMIT 1`)
				.get(sourceId) as Record<string, unknown> | null;

			return row ? rowToTask(row) : null;
		});
	};

	/**
	 * Find a task by external reference (source + sourceId).
	 * Use this for source-safe lookups when source IDs may overlap across systems.
	 */
	export const findByExternalRef = async (
		basePath: string,
		input: { source: Task["provenance"]["source"]; sourceId: string },
	): Promise<Result<Task | null>> => {
		return withDb(basePath, (db) => {
			const row = db
				.query(
					`SELECT * FROM ${TABLES.tasks} WHERE source = ? AND source_id = ? LIMIT 1`,
				)
				.get(input.source, input.sourceId) as Record<string, unknown> | null;

			return row ? rowToTask(row) : null;
		});
	};

	/**
	 * Find duplicate tasks sharing the same (source, source_id).
	 * Returns groups of tasks that have the same external reference.
	 */
	export const findDuplicatesBySourceId = async (
		basePath: string,
	): Promise<
		Result<Array<{ source: string; sourceId: string; tasks: Task[] }>>
	> => {
		return withDb(basePath, (db) => {
			// Find source_id values that appear more than once
			const dupeRows = db
				.query(
					`SELECT source, source_id, COUNT(*) as cnt
					 FROM ${TABLES.tasks}
					 WHERE source_id IS NOT NULL AND source_id != ''
					 GROUP BY source, source_id
					 HAVING cnt > 1
					 ORDER BY cnt DESC`,
				)
				.all() as Array<{ source: string; source_id: string; cnt: number }>;

			const groups = dupeRows.map((dupe) => {
				const taskRows = db
					.query(
						`SELECT * FROM ${TABLES.tasks}
						 WHERE source = ? AND source_id = ?
						 ORDER BY created_at ASC`,
					)
					.all(dupe.source, dupe.source_id) as Record<string, unknown>[];

				return {
					source: dupe.source,
					sourceId: dupe.source_id,
					tasks: taskRows.map(rowToTask),
				};
			});

			return groups;
		});
	};

	/**
	 * Get multiple tasks by ID.
	 */
	export const getTasks = async (
		basePath: string,
		ids: string[],
	): Promise<Result<Task[]>> => {
		if (ids.length === 0) return ok([]);

		return withDb(basePath, (db) => {
			const placeholders = ids.map(() => "?").join(", ");
			const rows = db
				.query(`SELECT * FROM ${TABLES.tasks} WHERE id IN (${placeholders})`)
				.all(...ids) as Record<string, unknown>[];

			// Convert rows and maintain order based on input ids
			const taskMap = new Map<string, Task>();
			for (const row of rows) {
				const task = rowToTask(row);
				taskMap.set(task.id, task);
			}

			// Return in same order as input ids (skip missing)
			const orderedTasks: Task[] = [];
			for (const id of ids) {
				const task = taskMap.get(id);
				if (task) orderedTasks.push(task);
			}

			return orderedTasks;
		});
	};

	export const updateTask = async (
		basePath: string,
		id: string,
		updates: TaskUpdate,
	): Promise<Result<Task | null>> => {
		const parseResult = TaskUpdateSchema.safeParse(updates);
		if (!parseResult.success) {
			return err(new Error(`Invalid updates: ${parseResult.error.message}`));
		}

		// Normalized and derived before the write so an unusable scope rejects the
		// update instead of silently re-prefixing the task as JALL.
		const scopeResult = normalizeOptionalScopeUri(updates.scopeUri);
		if (!scopeResult.ok) return scopeResult;
		const scopeUri = scopeResult.value;

		const prefixResult = derivePrefix(scopeUri);
		if (!prefixResult.ok) return prefixResult;

		const updateResult = await withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const sets: string[] = [
				"updated_at = ?",
				"version = version + 1",
				"updated_by = ?",
			];
			const params: (string | number | null)[] = [now, Runtime.actor()];

			if (updates.title !== undefined) {
				sets.push("title = ?");
				params.push(updates.title);
			}
			if (updates.description !== undefined) {
				sets.push("description = ?");
				params.push(updates.description);
			}
			if (updates.kind !== undefined) {
				sets.push("kind = ?");
				params.push(updates.kind);
			}
			if (updates.state !== undefined) {
				sets.push("state = ?");
				params.push(updates.state);
				// Set completed_at when transitioning to done
				if (updates.state === "done") {
					sets.push("completed_at = ?");
					params.push(now);
				}
			}
			if (updates.priority !== undefined) {
				sets.push("priority = ?");
				params.push(updates.priority);
			}
			if (updates.scopeUri !== undefined) {
				sets.push("scope_uri = ?");
				params.push(scopeUri ?? null);
				// Regenerate shortId when scope changes (J + 3-char ID like JDES-123)
				const newShortId = generateShortId(db, prefixResult.value, scopeUri);
				sets.push("short_id = ?");
				params.push(newShortId);
			}
			if (updates.scopeRefs !== undefined) {
				sets.push("scope_refs = ?");
				params.push(JSON.stringify(updates.scopeRefs));
			}
			if (updates.deadline !== undefined) {
				sets.push("deadline = ?");
				params.push(updates.deadline);
			}
			if (updates.deferUntil !== undefined) {
				sets.push("defer_until = ?");
				params.push(updates.deferUntil);
			}
			if (updates.tags !== undefined) {
				sets.push("tags = ?");
				params.push(JSON.stringify(updates.tags));
			}
			if (updates.context !== undefined) {
				sets.push("context = ?");
				params.push(updates.context);
			}
			if (updates.confidence !== undefined) {
				sets.push("confidence = ?");
				params.push(updates.confidence);
			}
			if (updates.assignee !== undefined) {
				sets.push("assignee = ?");
				params.push(updates.assignee);
			}
			if (updates.parentTaskId !== undefined) {
				sets.push("parent_task_id = ?");
				params.push(updates.parentTaskId);
			}
			if (updates.projectId !== undefined) {
				sets.push("project_id = ?");
				params.push(updates.projectId);
			}
			if (updates.needsReview !== undefined) {
				sets.push("needs_review = ?");
				params.push(updates.needsReview ? 1 : 0);
			}
			if (updates.verification !== undefined) {
				sets.push("verification = ?");
				params.push(JSON.stringify(updates.verification));
			}
			if (updates.provenance !== undefined) {
				if (updates.provenance.source !== undefined) {
					sets.push("source = ?");
					params.push(updates.provenance.source);
				}
				if (updates.provenance.sourceId !== undefined) {
					sets.push("source_id = ?");
					params.push(updates.provenance.sourceId ?? null);
				}
				if (updates.provenance.sourceUrl !== undefined) {
					sets.push("source_url = ?");
					params.push(updates.provenance.sourceUrl ?? null);
				}
			}

			params.push(id);

			db.run(
				`UPDATE ${TABLES.tasks} SET ${sets.join(", ")} WHERE id = ?`,
				params,
			);
			Oplog.afterWrite(db, "tasks", "update", id);
		});

		if (!updateResult.ok) return updateResult;

		const result = await getTask(basePath, id);

		// Emit event for SSE subscribers
		if (result.ok && result.value) {
			await Events.emit(PLANNER_EVENTS.TASK_UPDATED, result.value);
		}

		return result;
	};

	export const deleteTask = async (
		basePath: string,
		id: string,
	): Promise<Result<void>> => {
		const result = await withDb(basePath, (db) => {
			// Snapshot what the FK cascade is about to remove, children first, so
			// the log replays FK-safely on every other device.
			const cascade = Oplog.cascadeOf(db, id);
			if (!cascade.ok) throw cascade.error;
			db.transaction(() => {
				db.run(`DELETE FROM ${TABLES.tasks} WHERE id = ?`, [id]);
				Oplog.afterDelete(db, cascade.value);
			})();
		});

		// Emit event for SSE subscribers
		if (result.ok) {
			await Events.emit(PLANNER_EVENTS.TASK_DELETED, { id });
		}

		return result;
	};

	export const queryTasks = async (
		basePath: string,
		query: Partial<TaskQuery> = {},
	): Promise<Result<Task[]>> => {
		return withDb(basePath, (db) => {
			const conditions: string[] = [];
			const params: (string | number | null)[] = [];

			// State filter
			if (query.states && query.states.length > 0) {
				conditions.push(`state IN (${query.states.map(() => "?").join(", ")})`);
				params.push(...query.states);
			} else if (query.state) {
				conditions.push("state = ?");
				params.push(query.state);
			}

			// Exclude closed unless requested
			if (!query.includeClosed) {
				conditions.push("state NOT IN ('done', 'cancelled')");
			}

			// Exclude deferred unless requested
			if (!query.includeDeferred) {
				conditions.push("(defer_until IS NULL OR defer_until <= ?)");
				params.push(new Date().toISOString());
			}

			// Filter by kind (task vs issue)
			if (query.kind) {
				conditions.push("kind = ?");
				params.push(query.kind);
			}

			if (query.priority) {
				conditions.push("priority = ?");
				params.push(query.priority);
			}

			if (query.scopeUri) {
				const scopeFamily = buildScopeFamilyMatch(query.scopeUri);
				if (scopeFamily) {
					conditions.push("(scope_uri = ? OR scope_uri LIKE ?)");
					params.push(scopeFamily.baseScopeUri, scopeFamily.queryPattern);
				} else {
					conditions.push("scope_uri = ?");
					params.push(query.scopeUri);
				}
			}

			if (query.scopeUriPattern) {
				conditions.push("scope_uri LIKE ?");
				params.push(query.scopeUriPattern);
			}

			if (query.source) {
				conditions.push("source = ?");
				params.push(query.source);
			}

			if (query.sourceId) {
				conditions.push("source_id = ?");
				params.push(query.sourceId);
			}

			if (query.tag) {
				conditions.push("tags LIKE ?");
				params.push(`%"${query.tag}"%`);
			}

			if (query.context) {
				conditions.push("context = ?");
				params.push(query.context);
			}

			if (query.assignee) {
				conditions.push("assignee = ?");
				params.push(query.assignee);
			}

			if (query.parentTaskId) {
				conditions.push("parent_task_id = ?");
				params.push(query.parentTaskId);
			}

			if (query.topLevelOnly) {
				conditions.push("parent_task_id IS NULL");
			}

			if (query.projectId) {
				conditions.push("project_id = ?");
				params.push(query.projectId);
			}

			if (query.needsReview !== undefined) {
				conditions.push("needs_review = ?");
				params.push(query.needsReview ? 1 : 0);
			}

			if (query.dueBefore) {
				conditions.push("deadline <= ?");
				params.push(query.dueBefore);
			}

			if (query.dueAfter) {
				conditions.push("deadline >= ?");
				params.push(query.dueAfter);
			}

			const whereClause =
				conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

			const orderBy = query.orderBy ?? "createdAt";
			const orderDir = query.orderDir ?? "desc";
			const orderColumn = {
				createdAt: "created_at",
				updatedAt: "updated_at",
				deadline: "deadline",
				priority: "priority",
			}[orderBy];

			const limit = query.limit ?? 100;
			const offset = query.offset ?? 0;

			const sql = `
        SELECT * FROM ${TABLES.tasks}
        ${whereClause}
        ORDER BY ${orderColumn} ${orderDir.toUpperCase()}
        LIMIT ? OFFSET ?
      `;

			const rows = db.query(sql).all(...params, limit, offset) as Record<
				string,
				unknown
			>[];

			return rows.map(rowToTask);
		});
	};

	export const searchTasks = async (
		basePath: string,
		searchQuery: string,
		opts: { state?: Task["state"]; scopeUri?: string; limit?: number } = {},
	): Promise<Result<Task[]>> => {
		return withDb(basePath, (db) => {
			// FTS5 treats '-', ':', '*', etc. as operators, so a raw term like
			// "jdel-9" parses as `jdel NOT 9` and throws ("no such column: 9").
			// Wrap each whitespace-separated term in double quotes (FTS5 string
			// literals) so the query matches literal text; escape embedded quotes
			// by doubling them.
			const ftsQuery = searchQuery
				.trim()
				.split(/\s+/)
				.filter(Boolean)
				.map((term) => `"${term.replace(/"/g, '""')}"`)
				.join(" ");
			if (!ftsQuery) {
				return [];
			}

			const limit = opts.limit ?? 20;
			const conditions: string[] = [];
			const params: (string | number | null)[] = [ftsQuery];

			if (opts.state) {
				conditions.push("t.state = ?");
				params.push(opts.state);
			}

			if (opts.scopeUri) {
				const scopeFamily = buildScopeFamilyMatch(opts.scopeUri);
				if (scopeFamily) {
					conditions.push("(t.scope_uri = ? OR t.scope_uri LIKE ?)");
					params.push(scopeFamily.baseScopeUri, scopeFamily.queryPattern);
				} else {
					conditions.push("t.scope_uri = ?");
					params.push(opts.scopeUri);
				}
			}

			const whereExtra =
				conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

			const rows = db
				.query(
					`SELECT t.* FROM ${TABLES.tasks} t
           JOIN ${TABLES.tasks_fts} fts ON t.rowid = fts.rowid
           WHERE ${TABLES.tasks_fts} MATCH ?
           ${whereExtra}
           ORDER BY bm25(${TABLES.tasks_fts}) ASC
           LIMIT ?`,
				)
				.all(...params, limit) as Record<string, unknown>[];

			return rows.map(rowToTask);
		});
	};

	/**
	 * Get subtask counts for a list of parent task IDs.
	 * Returns a map of parentId -> count (only non-zero counts included).
	 */
	export const getSubtaskCounts = async (
		basePath: string,
		parentIds: string[],
	): Promise<Result<Record<string, number>>> => {
		if (parentIds.length === 0) {
			return ok({});
		}

		return withDb(basePath, (db) => {
			const placeholders = parentIds.map(() => "?").join(", ");
			const rows = db
				.query(
					`SELECT parent_task_id, COUNT(*) as count
           FROM ${TABLES.tasks}
           WHERE parent_task_id IN (${placeholders})
           GROUP BY parent_task_id`,
				)
				.all(...parentIds) as Array<{
				parent_task_id: string;
				count: number;
			}>;

			const counts: Record<string, number> = {};
			for (const row of rows) {
				counts[row.parent_task_id] = row.count;
			}
			return counts;
		});
	};

	/**
	 * Get tasks for "today" view: next + due today + overdue
	 */
	export const getToday = async (
		basePath: string,
		opts: {
			scopeUri?: string;
			includeDone?: boolean;
			kind?: "task" | "issue";
		} = {},
	): Promise<Result<{ overdue: Task[]; dueToday: Task[]; next: Task[] }>> => {
		return withDb(basePath, (db) => {
			const today = new Date().toISOString().split("T")[0];
			const todayStart = `${today}T00:00:00.000Z`;
			const todayEnd = `${today}T23:59:59.999Z`;

			const scopeFamily = opts.scopeUri
				? buildScopeFamilyMatch(opts.scopeUri)
				: undefined;
			const scopeFilter = opts.scopeUri
				? scopeFamily
					? "AND (scope_uri = ? OR scope_uri LIKE ?)"
					: "AND scope_uri = ?"
				: "";
			const scopeParam = opts.scopeUri
				? scopeFamily
					? [scopeFamily.baseScopeUri, scopeFamily.queryPattern]
					: [opts.scopeUri]
				: [];
			const doneFilter = opts.includeDone
				? ""
				: "AND state NOT IN ('done', 'cancelled')";
			const kindFilter = opts.kind ? "AND kind = ?" : "";
			const kindParam = opts.kind ? [opts.kind] : [];

			// Overdue
			const overdueRows = db
				.query(
					`SELECT * FROM ${TABLES.tasks}
           WHERE deadline < ? ${doneFilter} ${scopeFilter} ${kindFilter}
           ORDER BY deadline ASC`,
				)
				.all(todayStart, ...scopeParam, ...kindParam) as Record<
				string,
				unknown
			>[];

			// Due today
			const dueTodayRows = db
				.query(
					`SELECT * FROM ${TABLES.tasks}
           WHERE deadline >= ? AND deadline <= ? ${doneFilter} ${scopeFilter} ${kindFilter}
           ORDER BY deadline ASC`,
				)
				.all(todayStart, todayEnd, ...scopeParam, ...kindParam) as Record<
				string,
				unknown
			>[];

			// Next actions (state = next, no deadline or future deadline)
			const nextRows = db
				.query(
					`SELECT * FROM ${TABLES.tasks}
           WHERE state = 'next' AND (deadline IS NULL OR deadline > ?)
           ${doneFilter} ${scopeFilter} ${kindFilter}
           ORDER BY priority ASC, created_at ASC
           LIMIT 20`,
				)
				.all(todayEnd, ...scopeParam, ...kindParam) as Record<
				string,
				unknown
			>[];

			return {
				overdue: overdueRows.map(rowToTask),
				dueToday: dueTodayRows.map(rowToTask),
				next: nextRows.map(rowToTask),
			};
		});
	};
}
