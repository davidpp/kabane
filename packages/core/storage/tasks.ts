/**
 * Planner Storage — Tasks & ID Resolution
 */

import type { z } from "zod";
import type { Db } from "../db/port";
import { Events, PLANNER_EVENTS } from "../events";
import { Modules } from "../module";
import { err, NotFoundError, ok, quoted, type Result } from "../result";
import { atomic, Runtime, withDb } from "../runtime";
import {
	initialStateOf,
	type ItemKind,
	KEYED_ID_PATTERN,
	type Task,
	type TaskDraft,
	TaskDraftSchema,
	type TaskQuery,
	type TaskState,
	type TaskUpdate,
	TaskUpdateSchema,
} from "../schemas";
import { taskReceipt } from "../task-output";
import { declaredKeyOf } from "./custom-attribute";
import { CLAIM_KIND, RELEASE_KIND } from "./families";
import {
	derivePrefix,
	generateId,
	generateShortId,
	normalizeOptionalScopeUri,
	notAnIdMessage,
	rowToTask,
	SHORT_ID_PATTERN,
	TABLES,
	ULID_LENGTH,
	ULID_PREFIX_PATTERN,
} from "./helpers";
import { RecordRead } from "./record";
import { RecordWrite, type ThreadClaim, type ThreadText } from "./record-write";
import { TaskRows } from "./task-rows";
import {
	selectTaskQuery,
	selectTaskSearch,
	selectTodayBucket,
} from "./task-selection";

/** Compare normalized scopes from task rows or decoded tasks. */
export const taskScopeChanged = (
	scopeUri: string | undefined,
	currentScopeUri: string | null | undefined,
): boolean => (scopeUri ?? null) !== (currentScopeUri ?? null);

/** Each `TaskUpdate` field that is an attribute now, under its old column's name. */
const attributeUpdates = (updates: TaskUpdate) =>
	[
		["priority", updates.priority],
		["deadline", updates.deadline],
		["defer_until", updates.deferUntil],
		["context", updates.context],
		["confidence", updates.confidence],
		["project_id", updates.projectId],
		["source", updates.provenance?.source],
		["source_id", updates.provenance?.sourceId],
		["source_url", updates.provenance?.sourceUrl],
		[
			"scope_refs",
			updates.scopeRefs === undefined
				? undefined
				: JSON.stringify(updates.scopeRefs),
		],
		[
			"tags",
			updates.tags === undefined ? undefined : JSON.stringify(updates.tags),
		],
		[
			"needs_review",
			updates.needsReview === undefined
				? undefined
				: updates.needsReview
					? 1
					: 0,
		],
		[
			"verification",
			updates.verification === undefined
				? undefined
				: JSON.stringify(updates.verification),
		],
	] as const;

/** The thread's text register, as far as `updates` names it; the scope is the caller's. */
const textUpdates = (updates: TaskUpdate): ThreadText => {
	const text: ThreadText = {};
	if (updates.title !== undefined) text.title = updates.title;
	if (updates.description !== undefined) text.body = updates.description;
	if (updates.kind !== undefined) text.kind = updates.kind;
	if (updates.parentTaskId !== undefined) text.parent_id = updates.parentTaskId;
	return text;
};

/** The thread's claim register, as far as `updates` names it. */
const claimUpdates = (updates: TaskUpdate): ThreadClaim => {
	const claim: ThreadClaim = {};
	if (updates.state !== undefined) claim.state = updates.state;
	if (updates.assignee !== undefined) claim.assignee = updates.assignee;
	return claim;
};

/** A new task's attributes: every field the old row stored, absent ones left out. */
const draftAttributes = (
	draft: TaskDraft,
	now: string,
	completedAt: string | null,
) =>
	[
		["priority", draft.priority ?? "normal"],
		["scope_refs", draft.scopeRefs ? JSON.stringify(draft.scopeRefs) : null],
		["deadline", draft.deadline ?? null],
		["defer_until", draft.deferUntil ?? null],
		["completed_at", completedAt],
		["source", draft.provenance?.source ?? "human"],
		["source_id", draft.provenance?.sourceId ?? null],
		["source_url", draft.provenance?.sourceUrl ?? null],
		["discovered_at", draft.provenance?.discoveredAt ?? now],
		["confidence", draft.confidence ?? null],
		["project_id", draft.projectId ?? null],
		["needs_review", draft.needsReview ? 1 : 0],
		[
			"verification",
			draft.verification ? JSON.stringify(draft.verification) : null,
		],
		["tags", JSON.stringify(draft.tags ?? [])],
		["context", draft.context ?? null],
	] as const;

const CLOSED = ["done", "cancelled"];

/** The states a claim lasts through: the work, and a wait on someone. */
const HELD = ["in_progress", "waiting"];

/**
 * The claim entries a state change writes (ADR 0006). Setting a thread in
 * progress with an assignee claims it for the writer, unless the writer's
 * claim already stands. Moving it to any state but in progress or waiting
 * releases every standing claim, each in its claimant's name, since only the
 * claimant's own release clears a claim (`RecordRead.openClaims`); `re` names
 * the claim. Taking the state away (`null`) releases them too. Who holds it
 * is then the read's to say.
 */
const writeClaim = (db: Db, id: string, state: string | null): void => {
	const standing = RecordRead.openClaims(db, id);
	if (!standing.ok) throw standing.error;
	const now = new Date().toISOString();
	/** Now, or just past `after` when that clock is ahead of ours: entries order by time. */
	const past = (after: string | null | undefined) =>
		after == null || after < now
			? now
			: new Date(Date.parse(after) + 1).toISOString();
	const entry = (kind: string, author: string, at: string, re?: string) =>
		RecordWrite.addEntry(db, {
			id: generateId(),
			threadId: id,
			kind,
			author,
			body: null,
			data: null,
			createdAt: at,
			re,
		});
	if (state === "in_progress") {
		const actor = Runtime.actor();
		const assignee = db
			.query<{ assignee: string | null }, [string]>(
				`SELECT assignee FROM ${TABLES.threads} WHERE id = ?`,
			)
			.get(id)?.assignee;
		if (!assignee || standing.value.some((claim) => claim.author === actor))
			return;
		// A claim counts only after the claimant's own last release.
		const released = db
			.query<{ at: string | null }, [string, string]>(
				`SELECT MAX(created_at) AS at FROM ${TABLES.entries}
				  WHERE thread_id = ? AND kind = '${RELEASE_KIND}' AND author = ?`,
			)
			.get(id, actor)?.at;
		entry(CLAIM_KIND, actor, past(released));
		return;
	}
	if (state !== null && HELD.includes(state)) return;
	for (const claim of standing.value)
		entry(
			RELEASE_KIND,
			claim.author,
			// A release counts only after its claim, whose clock may be ahead of ours.
			past(claim.created_at),
			claim.id,
		);
};

/**
 * `completed_at` after a state change: kept when a closed task closes again,
 * set when it closes, removed when it opens.
 */
const completedAtAfter = (
	db: Db,
	id: string,
	from: string | null,
	to: string | null,
): string | null | undefined => {
	if (to === null || !CLOSED.includes(to)) return null;
	if (from !== null && CLOSED.includes(from)) {
		const held = db
			.query<{ value: string | null }, [string]>(
				`SELECT value FROM ${TABLES.attributes}
				  WHERE thread_id = ? AND key = 'completed_at' AND removed_at IS NULL`,
			)
			.get(id)?.value;
		if (held) return undefined;
	}
	return new Date().toISOString();
};

/** What a state change writes besides the state: its claim entries and `completed_at`. */
const writeStateChange = (
	db: Db,
	id: string,
	from: string | null,
	to: string | null,
): void => {
	writeClaim(db, id, to);
	const completedAt = completedAtAfter(db, id, from, to);
	if (completedAt !== undefined)
		RecordWrite.setAttribute(db, id, "completed_at", completedAt);
};

/** A parse error on one line, each issue as `field: message`, as a CLI prints it. */
const issuesLine = (error: z.ZodError): string =>
	error.issues
		.map((issue) =>
			issue.path.length
				? `${issue.path.join(".")}: ${issue.message}`
				: issue.message,
		)
		.join("; ");

/**
 * The update as written: `state: null` on a kind whose workflow starts it in a
 * state is refused, and a kind change that would leave such a kind with no
 * state gives it that kind's initial state, so a signal promoted to an issue
 * lands in `inbox` and a work queue picks it up.
 */
const stateKept = (
	updates: TaskUpdate,
	stored: { kind: string; state: TaskState | null },
): Result<TaskUpdate> => {
	const kind = updates.kind ?? stored.kind;
	const initial = initialStateOf(kind);
	if (initial === undefined) return ok(updates);
	if (updates.state === null)
		return err(
			new Error(
				`A ${kind} keeps a state: only a kind with no workflow can have it taken away`,
			),
		);
	return updates.state === undefined && stored.state === null
		? ok({ ...updates, state: initial })
		: ok(updates);
};

/** A new thread's state: the draft's, else the one its kind's declaration starts it in. */
const initialState = (draft: TaskDraft): TaskState | undefined =>
	draft.state ?? initialStateOf(draft.kind ?? "task");

const taskFromDraft = (
	draft: TaskDraft,
	scopeUri: string | undefined,
	{
		id,
		shortId,
		now,
		completedAt,
	}: { id: string; shortId: string; now: string; completedAt: string | null },
): Task => {
	return {
		id,
		shortId,
		title: draft.title,
		description: draft.description,
		kind: draft.kind ?? "task",
		state: initialState(draft),
		priority: draft.priority ?? "normal",
		scopeUri,
		scopeRefs: draft.scopeRefs,
		deadline: draft.deadline,
		deferUntil: draft.deferUntil,
		completedAt: completedAt ?? undefined,
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
};

/**
 * Whether keyed id `id` is taken: true when its thread shows. A deleted one
 * keeps its id for good, so a key that named it is refused.
 */
export const existingKeyed = (db: Db, id: string): boolean => {
	const row = db
		.query<{ id: string }, [string]>(
			`SELECT id FROM ${TABLES.threads} WHERE id = ?`,
		)
		.get(id);
	if (row === null) return false;
	if (!RecordRead.isVisible(db, id))
		throw new Error(
			`${id} names a deleted task; a key names one task for good, so pick another.`,
		);
	return true;
};

export const taskOf = (db: Db, id: string): Task => {
	const row = TaskRows.byIdOrShortId(db, id);
	if (!row) throw new NotFoundError(`No task found with ID: ${id}`);
	return rowToTask(row);
};

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
		// An id taken from a key (`<plan>/<thread>`): the thread it names, as is,
		// whatever its length, so a 26-character key is never taken for a ULID.
		if (input.includes("/")) {
			if (!KEYED_ID_PATTERN.test(input))
				return err(new NotFoundError(notAnIdMessage("task", input)));
			const found = await withDb(
				basePath,
				(db) =>
					TaskRows.where(db, `SELECT id FROM ${TABLES.threads} WHERE id = ?`, [
						input,
					]).length > 0,
			);
			if (!found.ok) return found;
			return found.value
				? ok(input)
				: err(new NotFoundError(`No task found with ID: ${input}`));
		}

		// Full ULID - return as-is
		if (input.length === ULID_LENGTH) {
			return ok(input);
		}

		// Short ID format (e.g., JDES-123) + legacy formats
		if (SHORT_ID_PATTERN.test(input)) {
			const result = await withDb(basePath, (db) => {
				const [row] = TaskRows.where(
					db,
					`SELECT id FROM ${TABLES.threads} WHERE short_id = ? COLLATE NOCASE`,
					[input.toUpperCase()],
				);
				return row ? { id: row.id as string } : null;
			});

			if (!result.ok) return result;

			if (!result.value) {
				return err(new NotFoundError(`No task found with ID: ${input}`));
			}

			return ok(result.value.id);
		}

		if (!ULID_PREFIX_PATTERN.test(input))
			return err(new NotFoundError(notAnIdMessage("task", input)));

		// ULID prefix match (fallback for legacy/debugging)
		const result = await withDb(basePath, (db) => {
			const rows = TaskRows.where(
				db,
				`SELECT id FROM ${TABLES.threads} WHERE id LIKE ?`,
				[`${input}%`],
			) as {
				id: string;
				short_id: string | null;
				title: string;
			}[];
			return rows;
		});

		if (!result.ok) return result;

		const matches = result.value;
		const [match] = matches;
		if (match === undefined) {
			return err(new NotFoundError(`No task found with ID prefix: ${input}`));
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

		return ok(match.id);
	};

	// ----------------------------------------------------------
	// Tasks
	// ----------------------------------------------------------

	/**
	 * Create a task. With `key` (`<plan key>/<thread key>`) the key is its id,
	 * so a second add with that key writes nothing and returns the task the
	 * first one made, marked `existed`.
	 */
	export const addTask = async (
		basePath: string,
		draft: TaskDraft,
		{ key, concise }: { key?: string; concise?: boolean } = {},
	): Promise<Result<Task & { existed?: true }>> => {
		const parseResult = TaskDraftSchema.safeParse(draft);
		if (!parseResult.success) {
			return err(new Error(`Invalid draft: ${issuesLine(parseResult.error)}`));
		}
		if (key !== undefined && !KEYED_ID_PATTERN.test(key))
			return err(
				new Error(
					`Key ${quoted(key)} is not a key: use "<plan>/<name>", lowercase letters, digits, dots, dashes and underscores.`,
				),
			);

		// Normalized here, not at the caller: every surface (MCP, CLI, the board)
		// writes through this function, so a bare "myapp" can
		// neither be stored raw nor fall through to the JALL prefix.
		const scopeResult = normalizeOptionalScopeUri(draft.scopeUri);
		if (!scopeResult.ok) return scopeResult;
		const scopeUri = scopeResult.value;

		const prefixResult = derivePrefix(scopeUri);
		if (!prefixResult.ok) return prefixResult;

		// One transaction: the thread and its attributes land together.
		const result = await atomic(basePath, (db) => {
			const task =
				key !== undefined && existingKeyed(db, key)
					? { ...taskOf(db, key), existed: true as const }
					: createTaskIn(db, draft, scopeUri, prefixResult.value, key);
			if (concise) {
				const receipt = taskReceipt(task);
				if (!receipt.ok) throw receipt.error;
			}
			return task;
		});

		// Emit event for SSE subscribers
		if (result.ok && !("existed" in result.value)) {
			await Events.emit(PLANNER_EVENTS.TASK_CREATED, result.value);
		}

		return result;
	};

	/**
	 * Create a task in the caller's transaction, under `id` when given (a
	 * keyed id the caller checked is free). The scope is normalized and its
	 * prefix derived by the caller.
	 */
	export const createTaskIn = (
		db: Db,
		draft: TaskDraft,
		scopeUri: string | undefined,
		prefix: string,
		id: string = generateId(),
	): Task => {
		const now = new Date().toISOString();
		const completedAt =
			draft.state === "done" || draft.state === "cancelled" ? now : null;
		const shortId = generateShortId(db, prefix, scopeUri);

		RecordWrite.createThread(db, {
			id,
			shortId,
			kind: draft.kind ?? "task",
			title: draft.title,
			body: draft.description ?? null,
			scope: scopeUri ?? null,
			parentId: draft.parentTaskId ?? null,
			createdBy: draft.provenance?.discoveredBy ?? null,
			state: initialState(draft) ?? null,
			assignee: draft.assignee ?? null,
			now,
		});
		for (const [key, value] of draftAttributes(draft, now, completedAt))
			if (value !== null) RecordWrite.setAttribute(db, id, key, value, now);
		// Filed in progress with an assignee is claimed, as an edit to it would be.
		if (draft.state === "in_progress") writeClaim(db, id, "in_progress");

		return taskFromDraft(draft, scopeUri, { id, shortId, now, completedAt });
	};

	export const getTask = async (
		basePath: string,
		id: string,
	): Promise<Result<Task | null>> => {
		return withDb(basePath, (db) => {
			// Try by ULID first, then by shortId for flexibility
			// This allows both "01ABC..." and "JDES-40" to work
			const row = TaskRows.byIdOrShortId(db, id);
			return row ? rowToTask(row) : null;
		});
	};

	/**
	 * The declared attributes set on a thread (`kabane_registrySet`), by their
	 * declared key, values as stored. A key no declaration covers any more is
	 * here all the same: the record holds it.
	 */
	export const getCustomAttributes = async (
		basePath: string,
		id: string,
	): Promise<Result<Record<string, string>>> =>
		withDb(basePath, (db) => {
			const rows = RecordRead.attributes(db, id);
			if (!rows.ok) throw rows.error;
			const attributes: Record<string, string> = {};
			for (const row of rows.value) {
				const key = declaredKeyOf(row.key);
				if (key !== undefined && row.value !== null)
					attributes[key] = row.value;
			}
			return attributes;
		});

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
			const rows = TaskRows.byIds(db, ids);

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

	/**
	 * Update through the caller's transaction; emit TASK_UPDATED only after it
	 * commits. A state change runs every module's `onTaskStateChange` here, so
	 * an `err` leaves a partial write behind unless the caller rolls it back.
	 */
	export const updateTaskIn = (
		db: Db,
		id: string,
		updates: TaskUpdate,
	): Result<Task | null> => {
		const parseResult = TaskUpdateSchema.safeParse(updates);
		if (!parseResult.success) {
			return err(
				new Error(`Invalid updates: ${issuesLine(parseResult.error)}`),
			);
		}

		// Normalized and derived before the write so an unusable scope rejects the
		// update instead of silently re-prefixing the task as JALL.
		const scopeResult = normalizeOptionalScopeUri(updates.scopeUri);
		if (!scopeResult.ok) return scopeResult;
		const scopeUri = scopeResult.value;

		const prefixResult = derivePrefix(scopeUri);
		if (!prefixResult.ok) return prefixResult;

		const current = db
			.query<{ kind: string; state: TaskState | null; scope: string | null }>(
				`SELECT kind, state, scope FROM ${TABLES.threads} WHERE id = ?`,
			)
			.get(id);
		if (!current || !RecordRead.isVisible(db, id)) return ok(null);
		const kept = stateKept(updates, current);
		if (!kept.ok) return kept;
		updates = kept.value;

		const text = textUpdates(updates);
		if (
			updates.scopeUri !== undefined &&
			taskScopeChanged(scopeUri, current.scope)
		) {
			text.scope = scopeUri ?? null;
			// Regenerate shortId when scope changes (J + 3-char ID like JDES-123)
			text.short_id = generateShortId(db, prefixResult.value, scopeUri);
		}
		RecordWrite.updateText(db, id, text);
		RecordWrite.updateClaim(db, id, claimUpdates(updates));
		if (updates.state !== undefined)
			writeStateChange(db, id, current.state, updates.state);

		for (const [key, value] of attributeUpdates(updates))
			if (value !== undefined) RecordWrite.setAttribute(db, id, key, value);

		const row = TaskRows.byIdOrShortId(db, id);
		if (!row) return ok(null);
		const task = rowToTask(row);
		if (
			task.state !== undefined &&
			(current.state ?? undefined) !== task.state
		) {
			const hooked = Modules.taskStateChanged(
				db,
				task,
				current.state ?? undefined,
				task.state,
			);
			if (!hooked.ok) return hooked;
		}
		return ok(task);
	};

	export const updateTask = async (
		basePath: string,
		id: string,
		updates: TaskUpdate,
	): Promise<Result<Task | null>> => {
		// One transaction, so a module hook's err rolls the state change back.
		const result = await atomic(basePath, (db) => {
			const updated = updateTaskIn(db, id, updates);
			if (!updated.ok) throw updated.error;
			return updated.value;
		});
		if (result.ok && result.value) {
			await Events.emit(PLANNER_EVENTS.TASK_UPDATED, result.value);
		}
		return result;
	};

	export const deleteTask = async (
		basePath: string,
		id: string,
	): Promise<Result<void>> => {
		const result = await atomic(basePath, (db) => {
			RecordWrite.deleteThread(db, id);
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
			const selection = selectTaskQuery(db, query);
			const rows = db
				.query(`SELECT * ${selection.sql} LIMIT ? OFFSET ?`)
				.all(
					...selection.params,
					query.limit ?? 100,
					query.offset ?? 0,
				) as Record<string, unknown>[];

			return rows.map(rowToTask);
		});
	};

	export const searchTasks = async (
		basePath: string,
		searchQuery: string,
		opts: { state?: Task["state"]; scopeUri?: string; limit?: number } = {},
	): Promise<Result<Task[]>> => {
		return withDb(basePath, (db) => {
			// Quote FTS terms in the shared selection, retaining literal operator handling.
			const selection = selectTaskSearch(searchQuery, opts);
			if (!selection) return [];
			const rows = db
				.query(`SELECT t.* ${selection.sql} LIMIT ?`)
				.all(...selection.params, opts.limit ?? 20) as Record<
				string,
				unknown
			>[];

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
	 * Get tasks for "today" view: next + due today + overdue. Today is the
	 * owner's local day (`Runtime.timezone()`, or `opts.zone`) at `opts.now`.
	 */
	export const getToday = async (
		basePath: string,
		opts: {
			scopeUri?: string;
			includeDone?: boolean;
			kind?: ItemKind;
			/** Epoch ms to take today at. Default: now. */
			now?: number;
			/** IANA zone whose day is today. Default: `Runtime.timezone()`. */
			zone?: string;
		} = {},
	): Promise<Result<{ overdue: Task[]; dueToday: Task[]; next: Task[] }>> => {
		return withDb(basePath, (db) => {
			const resolved = {
				...opts,
				now: opts.now ?? Date.now(),
				zone: opts.zone ?? Runtime.timezone(),
			};
			const read = (bucket: "overdue" | "dueToday" | "next"): Task[] => {
				const selection = selectTodayBucket(db, bucket, resolved);
				const rows = db
					.query(
						`SELECT * ${selection.sql}${bucket === "next" ? " LIMIT 20" : ""}`,
					)
					.all(...selection.params) as Record<string, unknown>[];
				return rows.map(rowToTask);
			};
			return {
				overdue: read("overdue"),
				dueToday: read("dueToday"),
				next: read("next"),
			};
		});
	};
}
