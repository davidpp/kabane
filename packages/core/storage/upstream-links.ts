/**
 * Planner Storage — Linked Issues
 *
 * Stores which external issue a task points at. Identity only: this module
 * never fetches a provider, never writes back to one, and never caches what
 * the external issue says.
 *
 * A link is a ref of kind `upstream` whose URI is `<provider>:<external id>`,
 * the provider's stable id, with the URL and identifier in `data` (migration
 * 14): two devices that link the same item write one row. Its id is the ref's
 * row id (`RecordKey`).
 */

import type { Db } from "../db/port";
import { err, NotFoundError, ok, type Result } from "../result";
import { atomic, withDb } from "../runtime";
import {
	type RefRow,
	RefRowSchema,
	type UpsertUpstreamLinkInput,
	UpsertUpstreamLinkInputSchema,
	type UpstreamLink,
	type UpstreamSummary,
} from "../schemas";
import { REF_FAMILY_SQL, refFamily, UPSTREAM_KIND } from "./families";
import { rowToUpstreamLink, TABLES } from "./helpers";
import { RecordRead } from "./record";
import { RecordWrite } from "./record-write";

const uriOf = (provider: string, externalId: string): string =>
	`${provider}:${externalId}`;

const convertRows = (rows: readonly RefRow[]): Result<UpstreamLink[]> => {
	const links: UpstreamLink[] = [];
	for (const row of rows) {
		const result = rowToUpstreamLink(row);
		if (!result.ok) return result;
		links.push(result.value);
	}
	return ok(links.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
};

/** Live upstream refs on visible threads, narrowed by `where`. */
const upstreamRefs = (db: Db, where: string, params: string[]): RefRow[] => {
	const parsed = RefRowSchema.array().safeParse(
		db
			.query<unknown, string[]>(
				`SELECT r.* FROM ${TABLES.refs} r JOIN ${TABLES.tasks} t ON t.id = r.thread_id
				  WHERE r.kind = '${UPSTREAM_KIND}' AND r.removed_at IS NULL
				    AND ${REF_FAMILY_SQL} = 'upstream' AND ${where}`,
			)
			.all(...params),
	);
	if (!parsed.success)
		throw new Error(`Invalid upstream-link row: ${parsed.error.message}`);
	return parsed.data;
};

export namespace Planner {
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
		const uri = uriOf(link.provider, link.externalId);
		const mine = "r.thread_id = ? AND r.uri = ?";
		const rowResult = await atomic(basePath, (db) => {
			const [held] = upstreamRefs(db, mine, [link.taskId, uri]);
			const before = held === undefined ? undefined : rowToUpstreamLink(held);
			RecordWrite.putRef(db, {
				threadId: link.taskId,
				uri,
				kind: UPSTREAM_KIND,
				title: link.title,
				data: {
					provider: link.provider,
					external_id: link.externalId,
					identifier: link.identifier ?? null,
					url: link.url,
					created_at: before?.ok
						? before.value.createdAt
						: new Date().toISOString(),
				},
			});
			const [row] = upstreamRefs(db, mine, [link.taskId, uri]);
			if (row === undefined)
				throw new Error(`upstream link ${uri} on ${link.taskId} does not show`);
			return row;
		});
		if (!rowResult.ok) return rowResult;

		return rowToUpstreamLink(rowResult.value);
	};

	export const getUpstreamLinksForTask = async (
		basePath: string,
		taskId: string,
	): Promise<Result<UpstreamLink[]>> => {
		const rows = await withDb(basePath, (db) => {
			const read = RecordRead.refs(db, taskId);
			if (!read.ok) throw read.error;
			return read.value.filter((row) => refFamily(row) === "upstream");
		});
		return rows.ok ? convertRows(rows.value) : rows;
	};

	export const getUpstreamSummariesForTasks = async (
		basePath: string,
		taskIds: string[],
	): Promise<Result<UpstreamSummary[]>> => {
		if (taskIds.length === 0) return ok([]);

		const rows = await withDb(basePath, (db) =>
			upstreamRefs(
				db,
				`r.thread_id IN (${taskIds.map(() => "?").join(", ")})`,
				taskIds,
			),
		);
		if (!rows.ok) return rows;
		const links = convertRows(rows.value);
		if (!links.ok) return links;
		return ok(
			links.value.map(({ taskId, provider, identifier }) => ({
				taskId,
				provider,
				...(identifier === undefined ? {} : { identifier }),
			})),
		);
	};

	export const getUpstreamLinksByExternalRef = async (
		basePath: string,
		provider: string,
		externalId: string,
	): Promise<Result<UpstreamLink[]>> => {
		const rows = await withDb(basePath, (db) =>
			upstreamRefs(db, "r.uri = ?", [uriOf(provider, externalId)]),
		);
		return rows.ok ? convertRows(rows.value) : rows;
	};

	/** Remove the upstream link `id` (its row id, `RecordKey`) names. */
	export const deleteUpstreamLink = async (
		basePath: string,
		id: string,
	): Promise<Result<void>> => {
		return atomic(basePath, (db) => {
			if (!RecordWrite.removeRef(db, id, "upstream"))
				throw new NotFoundError(`No upstream link ${id}`);
		});
	};
}
