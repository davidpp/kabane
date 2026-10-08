/** SQL selections shared by legacy records and opt-in concise pages. */
import type { Db, SqlValue } from "../db/port";
import { Runtime } from "../runtime";
import type { Task, TaskQuery } from "../schemas";
import { DeadlineSql } from "./deadline-sql";
import { buildScopeFamilyMatch, TABLES } from "./helpers";

export type TaskSelection = { sql: string; params: SqlValue[] };
export type SearchOptions = {
	state?: Task["state"];
	scopeUri?: string;
	limit?: number;
};
export type TodayOptions = {
	scopeUri?: string;
	includeDone?: boolean;
	kind?: "task" | "issue";
	now?: number;
	zone?: string;
};
export type TodayBucket = "overdue" | "dueToday" | "next";

const scopeClause = (scope: string, column: string): TaskSelection => {
	const family = buildScopeFamilyMatch(scope);
	return family
		? {
				sql: `(${column} = ? OR ${column} LIKE ?)`,
				params: [family.baseScopeUri, family.queryPattern],
			}
		: { sql: `${column} = ?`, params: [scope] };
};

const taskOrder = (
	db: Db,
	query: Partial<TaskQuery>,
	zone: string,
	stable: boolean,
): string => {
	const order = query.orderBy ?? "createdAt";
	const direction = (query.orderDir ?? "desc").toUpperCase();
	const column =
		order === "deadline"
			? DeadlineSql.dueAtKey(db, TABLES.tasks, zone)
			: {
					createdAt: "created_at",
					updatedAt: "updated_at",
					priority: "priority",
				}[order];
	return `ORDER BY ${column} ${direction}${stable ? ", id ASC" : ""}`;
};

export const selectTaskQuery = (
	db: Db,
	query: Partial<TaskQuery>,
	stable = false,
	now = new Date().toISOString(),
): TaskSelection => {
	const conditions: string[] = [];
	const params: SqlValue[] = [];
	if (query.states && query.states.length > 0) {
		conditions.push(`state IN (${query.states.map(() => "?").join(", ")})`);
		params.push(...query.states);
	} else if (query.state) {
		conditions.push("state = ?");
		params.push(query.state);
	}
	if (!query.includeClosed)
		conditions.push("state NOT IN ('done', 'cancelled')");
	if (!query.includeDeferred) {
		conditions.push("(defer_until IS NULL OR defer_until <= ?)");
		params.push(now);
	}
	if (query.scopeUri) {
		const scope = scopeClause(query.scopeUri, "scope_uri");
		conditions.push(scope.sql);
		params.push(...scope.params);
	}
	if (query.scopeUriPattern) {
		conditions.push("scope_uri LIKE ?");
		params.push(query.scopeUriPattern);
	}
	const equalities = [
		["kind", query.kind],
		["priority", query.priority],
		["source", query.source],
		["source_id", query.sourceId],
		["context", query.context],
		["assignee", query.assignee],
		["parent_task_id", query.parentTaskId],
		["project_id", query.projectId],
	] as const;
	for (const [column, value] of equalities)
		if (value) {
			conditions.push(`${column} = ?`);
			params.push(value);
		}
	if (query.tag) {
		conditions.push("tags LIKE ?");
		params.push(`%"${query.tag}"%`);
	}
	if (query.topLevelOnly) conditions.push("parent_task_id IS NULL");
	if (query.needsReview !== undefined) {
		conditions.push("needs_review = ?");
		params.push(query.needsReview ? 1 : 0);
	}
	const zone = Runtime.timezone();
	if (query.dueBefore) {
		const due = DeadlineSql.dueBefore(query.dueBefore, zone);
		conditions.push(due.sql);
		params.push(...due.params);
	}
	if (query.dueAfter) {
		const due = DeadlineSql.dueAfter(query.dueAfter, zone);
		conditions.push(due.sql);
		params.push(...due.params);
	}
	return {
		sql: `FROM ${TABLES.tasks} ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ${taskOrder(db, query, zone, stable)}`,
		params,
	};
};

export const selectTaskSearch = (
	query: string,
	opts: SearchOptions,
	stable = false,
): TaskSelection | undefined => {
	const fts = query
		.trim()
		.split(/\s+/)
		.filter(Boolean)
		.map((term) => `"${term.replace(/"/g, '""')}"`)
		.join(" ");
	if (!fts) return undefined;
	const conditions: string[] = [`${TABLES.tasks_fts} MATCH ?`];
	const params: SqlValue[] = [fts];
	if (opts.state) {
		conditions.push("t.state = ?");
		params.push(opts.state);
	}
	if (opts.scopeUri) {
		const scope = scopeClause(opts.scopeUri, "t.scope_uri");
		conditions.push(scope.sql);
		params.push(...scope.params);
	}
	return {
		sql: `FROM ${TABLES.tasks} t JOIN ${TABLES.tasks_fts} fts ON t.rowid = fts.rowid WHERE ${conditions.join(" AND ")} ORDER BY bm25(${TABLES.tasks_fts}) ASC${stable ? ", t.id ASC" : ""}`,
		params,
	};
};

export const selectTodayBucket = (
	db: Db,
	bucket: TodayBucket,
	opts: TodayOptions,
	stable = false,
): TaskSelection => {
	const zone = opts.zone ?? Runtime.timezone();
	const today = DeadlineSql.today(opts.now ?? Date.now(), zone);
	const due = {
		overdue: () => DeadlineSql.overdue(today),
		dueToday: () => DeadlineSql.dueToday(today),
		next: () => DeadlineSql.noneOrLater(today),
	}[bucket]();
	const conditions = [
		bucket === "next" ? "state = 'next'" : "deadline IS NOT NULL",
		due.sql,
	];
	const params: SqlValue[] = [...due.params];
	if (!opts.includeDone) conditions.push("state NOT IN ('done', 'cancelled')");
	if (opts.scopeUri) {
		const scope = scopeClause(opts.scopeUri, "scope_uri");
		conditions.push(scope.sql);
		params.push(...scope.params);
	}
	if (opts.kind) {
		conditions.push("kind = ?");
		params.push(opts.kind);
	}
	const order =
		bucket === "next"
			? "priority ASC, created_at ASC"
			: `${DeadlineSql.dueAtKey(db, TABLES.tasks, zone)} ASC`;
	return {
		sql: `FROM ${TABLES.tasks} WHERE ${conditions.join(" AND ")} ORDER BY ${order}${stable ? ", id ASC" : ""}`,
		params,
	};
};
