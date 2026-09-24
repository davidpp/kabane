/**
 * Planner Storage — Projects
 *
 * CRUD operations for the Project entity (flat grouping layer).
 */

import { err, ok, type Result } from "../result";
import { Runtime, withDb } from "../runtime";
import type {
	Project,
	ProjectDraft,
	ProjectQuery,
	ProjectUpdate,
} from "../schemas";
import { ProjectDraftSchema } from "../schemas";
import {
	buildScopeFamilyMatch,
	derivePrefix,
	generateId,
	generateShortId,
	normalizeOptionalScopeUri,
	rowToProject,
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
	 * Resolve a project identifier to a full ULID.
	 *
	 * Supports: full ULID, short ID (JPRJ-1), ULID prefix.
	 */
	export const resolveProjectId = async (
		basePath: string,
		input: string,
	): Promise<Result<string>> => {
		if (input.length === ULID_LENGTH) {
			return ok(input);
		}

		if (SHORT_ID_PATTERN.test(input)) {
			const result = await withDb(basePath, (db) => {
				const row = db
					.query(
						`SELECT id FROM ${TABLES.projects} WHERE short_id = ? COLLATE NOCASE`,
					)
					.get(input.toUpperCase()) as { id: string } | null;
				return row;
			});

			if (!result.ok) return result;
			if (!result.value) {
				return err(new Error(`No project found with ID: ${input}`));
			}
			return ok(result.value.id);
		}

		// ULID prefix match
		const result = await withDb(basePath, (db) => {
			const rows = db
				.query(
					`SELECT id, short_id, title FROM ${TABLES.projects} WHERE id LIKE ?`,
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
		const [match] = matches;
		if (match === undefined) {
			return err(new Error(`No project found with ID prefix: ${input}`));
		}
		if (matches.length > 1) {
			const candidates = matches
				.map(
					(p) =>
						`  ${p.short_id || p.id.slice(0, 8)}  ${p.title.slice(0, 40)}${p.title.length > 40 ? "..." : ""}`,
				)
				.join("\n");
			return err(
				new Error(
					`Ambiguous ID prefix "${input}" matches ${matches.length} projects:\n${candidates}`,
				),
			);
		}

		return ok(match.id);
	};

	// ----------------------------------------------------------
	// CRUD
	// ----------------------------------------------------------

	export const addProject = async (
		basePath: string,
		draft: ProjectDraft,
	): Promise<Result<Project>> => {
		const parseResult = ProjectDraftSchema.safeParse(draft);
		if (!parseResult.success) {
			return err(new Error(`Invalid draft: ${parseResult.error.message}`));
		}

		// Normalized here so every caller of addProject — not just the router —
		// writes a canonical scope (see addTask).
		const scopeResult = normalizeOptionalScopeUri(draft.scopeUri);
		if (!scopeResult.ok) return scopeResult;
		const scopeUri = scopeResult.value;

		const prefixResult = derivePrefix(scopeUri);
		if (!prefixResult.ok) return prefixResult;

		return withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const id = generateId();
			const shortId = generateShortId(db, prefixResult.value, scopeUri);

			db.run(
				`INSERT INTO ${TABLES.projects} (
          id, short_id, title, description, state, scope_uri,
          updated_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					shortId,
					draft.title,
					draft.description ?? null,
					draft.state ?? "active",
					scopeUri ?? null,
					Runtime.actor(),
					now,
					now,
				],
			);
			Oplog.afterWrite(db, "projects", "insert", id);

			return {
				id,
				shortId,
				title: draft.title,
				description: draft.description,
				state: draft.state ?? "active",
				scopeUri,
				createdAt: now,
				updatedAt: now,
			};
		});
	};

	export const getProject = async (
		basePath: string,
		id: string,
	): Promise<Result<Project | null>> => {
		return withDb(basePath, (db) => {
			const row = db
				.query(`SELECT * FROM ${TABLES.projects} WHERE id = ? OR short_id = ?`)
				.get(id, id) as Record<string, unknown> | null;
			return row ? rowToProject(row) : null;
		});
	};

	export const updateProject = async (
		basePath: string,
		id: string,
		updates: ProjectUpdate,
	): Promise<Result<Project | null>> => {
		const scopeResult = normalizeOptionalScopeUri(updates.scopeUri);
		if (!scopeResult.ok) return scopeResult;

		const updateResult = await withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const sets: string[] = [
				"updated_at = ?",
				"version = version + 1",
				"updated_by = ?",
			];
			const params: (string | null)[] = [now, Runtime.actor()];

			if (updates.title !== undefined) {
				sets.push("title = ?");
				params.push(updates.title);
			}
			if (updates.description !== undefined) {
				sets.push("description = ?");
				params.push(updates.description ?? null);
			}
			if (updates.state !== undefined) {
				sets.push("state = ?");
				params.push(updates.state);
			}
			if (updates.scopeUri !== undefined) {
				sets.push("scope_uri = ?");
				params.push(scopeResult.value ?? null);
			}

			params.push(id);
			db.run(
				`UPDATE ${TABLES.projects} SET ${sets.join(", ")} WHERE id = ?`,
				params,
			);
			Oplog.afterWrite(db, "projects", "update", id);
		});

		if (!updateResult.ok) return updateResult;
		return getProject(basePath, id);
	};

	export const deleteProject = async (
		basePath: string,
		id: string,
	): Promise<Result<void>> => {
		return withDb(basePath, (db) => {
			const project = Oplog.snapshot(db, "projects", id);
			if (!project.ok) throw project.error;
			const orphaned = db
				.query<{ id: string }, [string]>(
					`SELECT id FROM ${TABLES.tasks} WHERE project_id = ?`,
				)
				.all(id)
				.map((row) => row.id);

			db.transaction(() => {
				// Clearing project_id is a task write like any other: clocked,
				// versioned, and captured per task, so the other devices see the
				// same clear instead of an FK they cannot satisfy.
				db.run(
					`UPDATE ${TABLES.tasks}
              SET project_id = NULL, updated_at = ?, version = version + 1, updated_by = ?
            WHERE project_id = ?`,
					[new Date().toISOString(), Runtime.actor(), id],
				);
				for (const taskId of orphaned) {
					Oplog.afterWrite(db, "tasks", "update", taskId);
				}
				db.run(`DELETE FROM ${TABLES.projects} WHERE id = ?`, [id]);
				if (project.value !== undefined) {
					Oplog.afterDelete(db, [{ tbl: "projects", row: project.value }]);
				}
			})();
		});
	};

	export const queryProjects = async (
		basePath: string,
		query: Partial<ProjectQuery> = {},
	): Promise<Result<Project[]>> => {
		return withDb(basePath, (db) => {
			const conditions: string[] = [];
			const params: (string | number | null)[] = [];

			if (query.states && query.states.length > 0) {
				conditions.push(`state IN (${query.states.map(() => "?").join(", ")})`);
				params.push(...query.states);
			} else if (query.state) {
				conditions.push("state = ?");
				params.push(query.state);
			}

			if (!query.includeClosed) {
				conditions.push("state NOT IN ('done', 'archived')");
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

			if (query.query) {
				conditions.push("(title LIKE ? OR description LIKE ?)");
				const pattern = `%${query.query}%`;
				params.push(pattern, pattern);
			}

			const whereClause =
				conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

			const orderBy = query.orderBy ?? "createdAt";
			const orderColumn = {
				createdAt: "created_at",
				updatedAt: "updated_at",
				title: "title",
			}[orderBy];

			const orderDir = query.orderDir ?? "desc";
			const limit = query.limit ?? 100;
			const offset = query.offset ?? 0;

			const rows = db
				.query(
					`SELECT * FROM ${TABLES.projects}
           ${whereClause}
           ORDER BY ${orderColumn} ${orderDir}
           LIMIT ? OFFSET ?`,
				)
				.all(...params, limit, offset) as Record<string, unknown>[];

			return rows.map(rowToProject);
		});
	};
}
