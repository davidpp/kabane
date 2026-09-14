/**
 * Planner Storage — Linked Issues
 *
 * Stores which external issue a task points at. Identity only: this module
 * never fetches a provider, never writes back to one, and never caches what
 * the external issue says.
 *
 * Writes are captured into the oplog like any other replicated table, so a
 * link made on one device reaches the others.
 */

import { z } from "zod";
import { err, ok, type Result } from "../result";
import { Runtime, withDb } from "../runtime";
import type {
	UpsertUpstreamLinkInput,
	UpstreamLink,
	UpstreamSummary,
} from "../schemas";
import {
	UpsertUpstreamLinkInputSchema,
	UpstreamSummarySchema,
} from "../schemas";
import { generateId, rowToUpstreamLink, TABLES } from "./helpers";
import { Oplog } from "./oplog";

const convertRows = (rows: readonly unknown[]): Result<UpstreamLink[]> => {
	const links: UpstreamLink[] = [];
	for (const row of rows) {
		const result = rowToUpstreamLink(row);
		if (!result.ok) return result;
		links.push(result.value);
	}

	return ok(links);
};

const convertSummaryRows = (
	rows: readonly unknown[],
): Result<UpstreamSummary[]> => {
	const summaries: UpstreamSummary[] = [];
	for (const row of rows) {
		const recordResult = z.record(z.unknown()).safeParse(row);
		if (!recordResult.success) {
			return err(
				new Error(
					`Invalid upstream-summary row: ${recordResult.error.message}`,
				),
			);
		}

		const record = recordResult.data;
		const summaryResult = UpstreamSummarySchema.safeParse({
			taskId: record.task_id,
			provider: record.provider,
			identifier: record.identifier ?? undefined,
		});
		if (!summaryResult.success) {
			return err(
				new Error(
					`Invalid upstream-summary row: ${summaryResult.error.message}`,
				),
			);
		}
		summaries.push(summaryResult.data);
	}

	return ok(summaries);
};

export namespace Planner {
	/**
	 * Link a task to an external issue, or correct an existing link's
	 * identifier, url or title. The link id and createdAt stay stable.
	 */
	export const upsertUpstreamLink = async (
		basePath: string,
		input: UpsertUpstreamLinkInput,
	): Promise<Result<UpstreamLink>> => {
		const inputResult = UpsertUpstreamLinkInputSchema.safeParse(input);
		if (!inputResult.success) {
			return err(
				new Error(`Invalid upstream link: ${inputResult.error.message}`),
			);
		}

		const link = inputResult.data;
		const rowResult = await withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const id = generateId();

			// Insert or update is decided by what was there, so the captured op
			// kind matches what the row went through.
			const existed =
				db
					.query<{ id: string }, [string, string, string]>(
						`SELECT id FROM ${TABLES.upstream_links}
						 WHERE task_id = ? AND provider = ? AND external_id = ?`,
					)
					.get(link.taskId, link.provider, link.externalId) !== null;

			// `visibility` is written rather than defaulted: applySchema is
			// IF NOT EXISTS and SQLite cannot ALTER a column default, so a
			// database created before these rows replicated still carries
			// DEFAULT 'private' and would silently keep every new link home.
			db.run(
				`INSERT INTO ${TABLES.upstream_links}
				   (id, task_id, provider, external_id, identifier, url, title,
				    created_at, updated_at, updated_by, visibility)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'shared')
				 ON CONFLICT(task_id, provider, external_id) DO UPDATE SET
				   identifier = excluded.identifier,
				   url = excluded.url,
				   title = excluded.title,
				   updated_at = excluded.updated_at,
				   updated_by = excluded.updated_by,
				   visibility = 'shared',
				   version = version + 1`,
				[
					id,
					link.taskId,
					link.provider,
					link.externalId,
					link.identifier ?? null,
					link.url,
					link.title,
					now,
					now,
					Runtime.actor(),
				],
			);

			const row = db
				.query(
					`SELECT * FROM ${TABLES.upstream_links}
					 WHERE task_id = ? AND provider = ? AND external_id = ?`,
				)
				.get(link.taskId, link.provider, link.externalId) as Record<
				string,
				unknown
			>;
			Oplog.afterWrite(
				db,
				"upstream_links",
				existed ? "update" : "insert",
				row.id as string,
			);

			return row;
		});
		if (!rowResult.ok) return rowResult;

		return rowToUpstreamLink(rowResult.value);
	};

	/** Every external issue linked to one task. */
	export const getUpstreamLinksForTask = async (
		basePath: string,
		taskId: string,
	): Promise<Result<UpstreamLink[]>> => {
		const rowsResult = await withDb(basePath, (db) =>
			db
				.query(
					`SELECT * FROM ${TABLES.upstream_links}
					 WHERE task_id = ? ORDER BY created_at ASC, id ASC`,
				)
				.all(taskId),
		);
		if (!rowsResult.ok) return rowsResult;

		return convertRows(rowsResult.value);
	};

	/** Compact link metadata for a bounded task set. One query, never N. */
	export const getUpstreamSummariesForTasks = async (
		basePath: string,
		taskIds: string[],
	): Promise<Result<UpstreamSummary[]>> => {
		if (taskIds.length === 0) return ok([]);

		const placeholders = taskIds.map(() => "?").join(", ");
		const rowsResult = await withDb(basePath, (db) =>
			db
				.query(
					`SELECT task_id, provider, identifier
					 FROM ${TABLES.upstream_links}
					 WHERE task_id IN (${placeholders})
					 ORDER BY created_at ASC, id ASC`,
				)
				.all(...taskIds),
		);
		if (!rowsResult.ok) return rowsResult;

		return convertSummaryRows(rowsResult.value);
	};

	/**
	 * Resolve an external issue to every task linked to it. One team item may
	 * intentionally map to tasks in multiple scopes/repos.
	 */
	export const getUpstreamLinksByExternalRef = async (
		basePath: string,
		provider: string,
		externalId: string,
	): Promise<Result<UpstreamLink[]>> => {
		const rowsResult = await withDb(basePath, (db) =>
			db
				.query(
					`SELECT * FROM ${TABLES.upstream_links}
					 WHERE provider = ? AND external_id = ?
					 ORDER BY created_at ASC, id ASC`,
				)
				.all(provider, externalId),
		);
		if (!rowsResult.ok) return rowsResult;

		return convertRows(rowsResult.value);
	};

	/** Remove one link by its id. */
	export const deleteUpstreamLink = async (
		basePath: string,
		id: string,
	): Promise<Result<void>> => {
		return withDb(basePath, (db) => {
			const row = Oplog.snapshot(db, "upstream_links", id);
			if (!row.ok) throw row.error;
			db.run(`DELETE FROM ${TABLES.upstream_links} WHERE id = ?`, [id]);
			if (row.value !== undefined) {
				Oplog.afterDelete(db, [{ tbl: "upstream_links", row: row.value }]);
			}
		});
	};
}
