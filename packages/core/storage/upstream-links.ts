/**
 * Planner Storage — Private Upstream Links
 *
 * Stores an allowlisted external work-item snapshot locally. This module does
 * not fetch providers or write anything back to them.
 */

import { z } from "zod";
import { err, ok, type Result } from "../result";
import { withDb } from "../runtime";
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
			refreshedAt: record.refreshed_at,
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
	 * Create a private upstream relationship or refresh its allowlisted
	 * snapshot. The relationship id and createdAt stay stable across refreshes.
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
		const now = new Date().toISOString();
		const id = generateId();
		const rowResult = await withDb(basePath, (db) => {
			db.run(
				`INSERT INTO ${TABLES.upstream_links}
				   (id, task_id, provider, external_id, identifier, url, title,
				    description, state, external_updated_at, refreshed_at, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(task_id, provider, external_id) DO UPDATE SET
				   identifier = excluded.identifier,
				   url = excluded.url,
				   title = excluded.title,
				   description = excluded.description,
				   state = excluded.state,
				   external_updated_at = excluded.external_updated_at,
				   refreshed_at = excluded.refreshed_at,
				   updated_at = excluded.updated_at`,
				[
					id,
					link.taskId,
					link.provider,
					link.externalId,
					link.identifier ?? null,
					link.url,
					link.title,
					link.description ?? null,
					link.state ?? null,
					link.externalUpdatedAt ?? null,
					now,
					now,
					now,
				],
			);

			return db
				.query(
					`SELECT * FROM ${TABLES.upstream_links}
					 WHERE task_id = ? AND provider = ? AND external_id = ?`,
				)
				.get(link.taskId, link.provider, link.externalId);
		});
		if (!rowResult.ok) return rowResult;

		return rowToUpstreamLink(rowResult.value);
	};

	/** Get every private upstream relationship attached to one Jake root. */
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

	/** Get compact private-link metadata for a bounded task set. */
	export const getUpstreamSummariesForTasks = async (
		basePath: string,
		taskIds: string[],
	): Promise<Result<UpstreamSummary[]>> => {
		if (taskIds.length === 0) return ok([]);

		const placeholders = taskIds.map(() => "?").join(", ");
		const rowsResult = await withDb(basePath, (db) =>
			db
				.query(
					`SELECT task_id, provider, identifier, refreshed_at
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
	 * Resolve an external work item to all private implementation roots. One
	 * team item may intentionally map to roots in multiple scopes/repos.
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

	/** Remove one local relationship by its private link id. */
	export const deleteUpstreamLink = async (
		basePath: string,
		id: string,
	): Promise<Result<void>> => {
		return withDb(basePath, (db) => {
			db.run(`DELETE FROM ${TABLES.upstream_links} WHERE id = ?`, [id]);
		});
	};
}
