import { z } from "zod";
import type { Db } from "../db/port";
import { err, ok, type Result, trySync } from "../result";
import { Runtime, withDb } from "../runtime";
import {
	Deadline,
	TaskStateSchema,
	TaskQuerySchema,
	type TaskQuery,
} from "../schemas";
import {
	QUEUE_BYTES,
	QUEUE_FULL_READ,
	QUEUE_OMISSIONS,
	serializedBytes,
	taskSummary,
	type TaskSummary,
} from "../task-output";
import { customAttributeKey } from "./custom-attribute";
import { rowToTask } from "./helpers";
import { fingerprintText as digest } from "./read-fingerprint";
import {
	selectTaskQuery,
	selectTaskSearch,
	selectTodayBucket,
	type SearchOptions,
	type TodayOptions,
	type TodayBucket,
	type TaskSelection,
} from "./task-selection";

const PageQuerySchema = TaskQuerySchema.omit({ limit: true, offset: true });
const PageSearchSchema = z.object({
	query: z.string(),
	state: TaskStateSchema.optional(),
	scopeUri: z.string().optional(),
});

export const PageOptionsSchema = z.object({
	limit: z.number().int().min(1).max(100).default(20),
	cursor: z.string().min(1).max(700).optional(),
});
type PageOptions = z.input<typeof PageOptionsSchema>;
const CursorSchema = z
	.object({
		v: z.literal(1),
		binding: z.string().regex(/^[a-f0-9]{64}$/),
		fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
		offset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
		asOf: z.iso.datetime(),
	})
	.strict();
type Cursor = z.infer<typeof CursorSchema>;
export type TaskPage = {
	items: (TaskSummary & { attributes?: Record<string, string> })[];
	hasMore: boolean;
	nextCursor?: string;
	omittedFields: string[];
	fullRead: string;
};
const cursorError = () =>
	err(
		new Error(
			"Invalid or mismatched cursor (query, scope/filter or owner day/timezone); restart without cursor.",
		),
	);
const staleError = () =>
	err(
		new Error(
			"Stale cursor: matching tasks/order or owner day/timezone changed; restart without cursor.",
		),
	);
const decodeCursor = (text: string | undefined): Result<Cursor | undefined> => {
	if (text === undefined) return ok(undefined);
	try {
		const parsed = CursorSchema.safeParse(JSON.parse(text));
		return parsed.success ? ok(parsed.data) : cursorError();
	} catch {
		return cursorError();
	}
};
const envelope = (items: TaskSummary[], nextCursor?: string): TaskPage => ({
	items,
	hasMore: nextCursor !== undefined,
	...(nextCursor === undefined ? {} : { nextCursor }),
	omittedFields: QUEUE_OMISSIONS,
	fullRead: QUEUE_FULL_READ,
});

const packPage = (
	rows: Record<string, unknown>[],
	total: number,
	cursor: Omit<Cursor, "offset">,
	offset: number,
	{ budget, attribute }: { budget: number; attribute?: string },
): Result<TaskPage> => {
	const items: TaskSummary[] = [];
	for (const row of rows) {
		const after = offset + items.length + 1;
		const next =
			after < total ? JSON.stringify({ ...cursor, offset: after }) : undefined;
		const attributes =
			attribute && typeof row.projected_value === "string"
				? { [attribute]: row.projected_value }
				: undefined;
		const extra = attributes ? serializedBytes({ attributes }) : 0;
		const projected = taskSummary(
			rowToTask(row),
			budget - serializedBytes(envelope([], next)) - extra,
		);
		if (!projected.ok) return projected;
		const item = attributes
			? { ...projected.value, attributes }
			: projected.value;
		if (serializedBytes(envelope([...items, item], next)) > budget) break;
		items.push(item);
	}
	if (rows.length && !items.length)
		return err(
			new Error(
				"Concise identity cannot fit this page; use responseFormat: full or --format full.",
			),
		);
	const after = offset + items.length;
	const next =
		after < total ? JSON.stringify({ ...cursor, offset: after }) : undefined;
	const page = envelope(items, next);
	return serializedBytes(page) <= budget
		? ok(page)
		: err(
				new Error(
					"Concise page metadata exceeds its byte budget; use full mode.",
				),
			);
};

/** Fingerprints only compact eligible metadata in actual SQL order, never bodies.
 * O(matching candidates) per call; unrelated predicate-excluded writes tolerate
 * continuation. No held snapshot: a relevant write invalidates the next cursor.
 */
const readPage = async (
	basePath: string,
	bindingValue: unknown,
	options: PageOptions & { attribute?: string },
	selectionFor: (db: Db, asOf: string) => TaskSelection | undefined,
	budget = QUEUE_BYTES,
): Promise<Result<TaskPage>> => {
	const { attribute } = options;
	const parsed = PageOptionsSchema.safeParse(options);
	if (!parsed.success)
		return err(
			new Error(
				`Invalid concise pagination: ${parsed.error.message.slice(0, 200)}`,
			),
		);
	const decoded = decodeCursor(parsed.data.cursor);
	if (!decoded.ok) return decoded;
	const bindingResult = await digest(JSON.stringify(bindingValue));
	if (!bindingResult.ok) return bindingResult;
	const binding = bindingResult.value;
	const cursor = decoded.value;
	if (cursor && cursor.binding !== binding) return cursorError();
	const asOf = cursor?.asOf ?? new Date().toISOString();
	const offset = cursor?.offset ?? 0;
	const read = await withDb(basePath, (db) => {
		const selection = selectionFor(db, asOf);
		if (!selection) return { metadata: "[]", total: 0, rows: [] };
		const compactSql = `SELECT id, short_id, version, updated_at, updated_by ${selection.sql}`;
		const candidates = db.query(compactSql).all(...selection.params);
		const metadata = JSON.stringify(candidates);
		const projection =
			attribute === undefined
				? ""
				: ", (SELECT value FROM attributes WHERE thread_id = tasks.id AND key = ? AND removed_at IS NULL) AS projected_value";
		const bind = attribute === undefined ? [] : [customAttributeKey(attribute)];
		const rows = db
			.query(
				`SELECT ${selection.sql.includes(" JOIN ") ? "t.*" : "*"}${projection} ${selection.sql} LIMIT ? OFFSET ?`,
			)
			.all(...bind, ...selection.params, parsed.data.limit, offset) as Record<
			string,
			unknown
		>[];
		// Catch a relevant writer racing the two reads without holding a transaction
		// across asynchronous digest/serialization work.
		if (
			metadata !== JSON.stringify(db.query(compactSql).all(...selection.params))
		)
			return undefined;
		return { metadata, total: candidates.length, rows };
	});
	if (!read.ok) return read;
	if (!read.value) return staleError();
	const fingerprintResult = await digest(read.value.metadata);
	if (!fingerprintResult.ok) return fingerprintResult;
	const fingerprint = fingerprintResult.value;
	if (
		cursor &&
		(cursor.fingerprint !== fingerprint || offset >= read.value.total)
	)
		return staleError();
	return packPage(
		read.value.rows,
		read.value.total,
		{ v: 1, binding, fingerprint, asOf },
		offset,
		{ budget, attribute },
	);
};

export namespace Planner {
	export const queryTaskPage = async (
		basePath: string,
		query: Partial<TaskQuery> = {},
		options: PageOptions & { attribute?: string } = {},
	): Promise<Result<TaskPage>> => {
		const parsed = PageQuerySchema.safeParse(query);
		if (!parsed.success)
			return err(
				new Error(
					`Invalid concise query: ${parsed.error.message.slice(0, 200)}`,
				),
			);
		const zone = Runtime.timezone();
		return readPage(
			basePath,
			{ type: "list", query: parsed.data, zone, attribute: options.attribute },
			options,
			(db, asOf) => selectTaskQuery(db, parsed.data, true, asOf),
		);
	};
	export const searchTaskPage = (
		basePath: string,
		query: string,
		opts: SearchOptions = {},
		options: PageOptions = {},
	): Promise<Result<TaskPage>> => {
		const parsed = PageSearchSchema.safeParse({
			query,
			state: opts.state,
			scopeUri: opts.scopeUri,
		});
		if (!parsed.success)
			return Promise.resolve(
				err(
					new Error(
						`Invalid concise search: ${parsed.error.message.slice(0, 200)}`,
					),
				),
			);
		return readPage(basePath, { type: "search", ...parsed.data }, options, () =>
			selectTaskSearch(parsed.data.query, parsed.data, true),
		);
	};
	export const getTodayPages = async (
		basePath: string,
		opts: TodayOptions = {},
		options: PageOptions & {
			cursors?: Partial<Record<TodayBucket, string>>;
		} = {},
	): Promise<Result<Record<TodayBucket, TaskPage>>> => {
		if (options.cursor !== undefined)
			return err(new Error("Today uses per-bucket cursors, not cursor."));
		const zone = opts.zone ?? Runtime.timezone();
		const now = opts.now ?? Date.now();
		const date = trySync(() => Deadline.localDate(now, zone));
		if (!date.ok)
			return err(new Error("Invalid owner date/timezone for concise today."));
		const day = date.value;
		const normalized = {
			scopeUri: opts.scopeUri,
			kind: opts.kind,
			includeDone: opts.includeDone ?? false,
			zone,
			now,
		};
		const pages: Partial<Record<TodayBucket, TaskPage>> = {};
		for (const bucket of ["overdue", "dueToday", "next"] as const) {
			const page = await readPage(
				basePath,
				{
					type: "today",
					bucket,
					day,
					zone,
					scopeUri: opts.scopeUri,
					kind: opts.kind,
					includeDone: opts.includeDone ?? false,
				},
				{ limit: options.limit, cursor: options.cursors?.[bucket] },
				(db) => selectTodayBucket(db, bucket, normalized, true),
				5 * 1024,
			);
			if (!page.ok) return page;
			pages[bucket] = page.value;
		}
		const { overdue, dueToday, next } = pages;
		if (!overdue || !dueToday || !next)
			return err(new Error("Today page assembly failed."));
		const result = { overdue, dueToday, next };
		if (serializedBytes(result) > QUEUE_BYTES)
			return err(new Error("Today response exceeds 16KiB; use full mode."));
		return ok(result);
	};
}
