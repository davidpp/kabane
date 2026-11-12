import {
	atomic,
	type Db,
	err,
	ok,
	Oplog,
	Planner,
	type Result,
	Runtime,
	type SqlValue,
	TABLES,
	withDb,
} from "@cabane/core";
import { monotonicFactory } from "ulid";
import { ITEMS_TABLE } from "./migrations";
import { place } from "./rank";
import {
	AddSchema,
	type AddInput,
	type ChecklistChange,
	type ChecklistItem,
	type ChecklistItemView,
	type ChecklistProgress,
	EditSchema,
	type EditInput,
	TickSchema,
	type TickInput,
} from "./schema";

const generateId = monotonicFactory();

/** `JCAB-12.3`; a question's handle is `JCAB-12:3`. */
const HANDLE = /^(.+)\.([1-9]\d*)$/;
const QUESTION_HANDLE = /^(.+):([1-9]\d*)$/;

/**
 * Every item of one issue, removed ones included, in list order. Ordinals
 * count removed items, so removing or moving one never renumbers another.
 */
const selectItems = (db: Db, taskId: string): ChecklistItemView[] =>
	db
		.query<ChecklistItem & { ordinal: number; short_id: string | null }>(
			`SELECT i.*, t.short_id,
		(SELECT COUNT(*) FROM ${ITEMS_TABLE} preceding WHERE preceding.task_id = i.task_id AND preceding.id <= i.id) AS ordinal
		FROM ${ITEMS_TABLE} i JOIN ${TABLES.tasks} t ON t.id = i.task_id
		WHERE i.task_id = ?
		ORDER BY i.rank, i.id`,
		)
		.all(taskId)
		.map((row) => ({
			id: row.id,
			taskId: row.task_id,
			text: row.text,
			done: row.done_at !== null,
			doneAt: row.done_at ?? undefined,
			doneBy: row.done_by ?? undefined,
			removedAt: row.removed_at ?? undefined,
			rank: row.rank,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			updatedBy: row.updated_by,
			version: row.version,
			visibility: row.visibility,
			handle: `${row.short_id ?? row.task_id}.${row.ordinal}`,
			ordinal: row.ordinal,
			shortId: row.short_id ?? undefined,
		}));

const live = (items: ChecklistItemView[]): ChecklistItemView[] =>
	items.filter((item) => item.removedAt === undefined);

const progressOf = (items: ChecklistItemView[]): ChecklistProgress => ({
	done: items.filter((item) => item.done).length,
	total: items.length,
});

const taskRow = (db: Db, taskId: string) => {
	const task = db
		.query<{ short_id: string | null; visibility: string }>(
			`SELECT short_id, visibility FROM ${TABLES.tasks} WHERE id = ?`,
		)
		.get(taskId);
	if (!task) throw new Error(`No task found: ${taskId}`);
	return task;
};

/** The change a write returns: `ids` as they now are, and the issue's checklist after it. */
const changeOf = (
	db: Db,
	taskId: string,
	ids: readonly string[],
): ChecklistChange => {
	const all = selectItems(db, taskId);
	return {
		items: ids.flatMap((id) => all.filter((item) => item.id === id)),
		issue: taskRow(db, taskId).short_id ?? taskId,
		progress: progressOf(live(all)),
	};
};

/** Update one item's columns and capture it. */
const write = (db: Db, id: string, set: Record<string, SqlValue>): void => {
	const columns = Object.keys(set).map((column) => `${column} = ?`);
	db.run(
		`UPDATE ${ITEMS_TABLE} SET ${columns.join(", ")}, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?`,
		[...Object.values(set), new Date().toISOString(), Runtime.actor(), id],
	);
	Oplog.afterWrite(db, ITEMS_TABLE, "update", id);
};

/** The live item `id`, refusing a missing or removed one; `ref` is what the caller passed. */
const liveItem = (db: Db, id: string, ref: string): ChecklistItem => {
	const row = db
		.query<ChecklistItem>(`SELECT * FROM ${ITEMS_TABLE} WHERE id = ?`)
		.get(id);
	if (!row) throw new Error(`No checklist item found: ${ref}`);
	if (row.removed_at !== null)
		throw new Error(`Checklist item ${ref} was removed.`);
	return row;
};

const positionProblem = (position: number, slots: number): string =>
	`position ${position} is outside the checklist: use 1 to ${slots}.`;

export namespace Checklist {
	/** The issue's live items, in list order. */
	export const list = async (
		basePath: string,
		id: string,
	): Promise<Result<ChecklistItemView[]>> => {
		const taskId = await Planner.resolveTaskId(basePath, id);
		if (!taskId.ok) return taskId;
		return withDb(basePath, (db) => live(selectItems(db, taskId.value)));
	};

	/** Done and total live items of every task that has any, keyed by task ULID. */
	export const progress = (
		basePath: string,
	): Promise<Result<Map<string, ChecklistProgress>>> =>
		withDb(
			basePath,
			(db) =>
				new Map(
					db
						.query<{ task_id: string; done: number; total: number }>(
							`SELECT task_id, COUNT(done_at) AS done, COUNT(*) AS total FROM ${ITEMS_TABLE} WHERE removed_at IS NULL GROUP BY task_id`,
						)
						.all()
						.map((row) => [row.task_id, { done: row.done, total: row.total }]),
				),
		);

	/**
	 * The ULID of the item `ref` names: a handle (`JCAB-12.3`), a ULID, or
	 * `id:<ULID>`. A ULID is returned as given; the write that uses it checks it.
	 */
	export const resolve = async (
		basePath: string,
		ref: string,
	): Promise<Result<string>> => {
		const input = ref.trim();
		if (input.startsWith("id:")) return ok(input.slice(3));
		const question = input.match(QUESTION_HANDLE);
		if (question)
			return err(
				new Error(
					`${input} is a question's handle; a checklist item's reads ${question[1]}.${question[2]}.`,
				),
			);
		const match = input.match(HANDLE);
		if (!match) return ok(input);
		const ordinal = Number(match[2]);
		const taskId = await Planner.resolveTaskId(basePath, match[1] ?? "");
		if (!taskId.ok) return taskId;
		// Ordinals follow creation order, which is id order, whatever the list order.
		const ids = await withDb(basePath, (db) =>
			db
				.query<{ id: string }>(
					`SELECT id FROM ${ITEMS_TABLE} WHERE task_id = ? ORDER BY id`,
				)
				.all(taskId.value),
		);
		if (!ids.ok) return ids;
		const item = ids.value[ordinal - 1];
		return item
			? ok(item.id)
			: err(
					new Error(
						`No checklist item ${input}: ${match[1]} has ${ids.value.length}. Read them with kabane_context, sections: ["checklist.items"].`,
					),
				);
	};

	const resolveAll = async (
		basePath: string,
		refs: readonly string[],
	): Promise<Result<{ ref: string; id: string }[]>> => {
		const resolved: { ref: string; id: string }[] = [];
		for (const ref of refs) {
			const id = await resolve(basePath, ref);
			if (!id.ok) return id;
			resolved.push({ ref, id: id.value });
		}
		return ok(resolved);
	};

	/** Add items in the order given, at the end or from a 1-based position. */
	export const add = async (
		basePath: string,
		input: AddInput,
	): Promise<Result<ChecklistChange>> => {
		const parsed = AddSchema.safeParse(input);
		if (!parsed.success)
			return err(new Error(`Invalid checklist items: ${parsed.error.message}`));
		const taskId = await Planner.resolveTaskId(basePath, parsed.data.id);
		if (!taskId.ok) return taskId;
		return atomic(basePath, (db) => {
			const task = taskRow(db, taskId.value);
			const items = live(selectItems(db, taskId.value));
			const position = parsed.data.position ?? items.length + 1;
			if (position > items.length + 1)
				throw new Error(positionProblem(position, items.length + 1));
			const { placed, moved } = place(items, position - 1, parsed.data.items);
			for (const entry of moved) write(db, entry.id, { rank: entry.rank });
			const now = new Date().toISOString();
			const ids = placed.map(({ entry: text, rank }) => {
				const id = generateId();
				db.run(
					`INSERT INTO ${ITEMS_TABLE} (id, task_id, text, rank, created_at, updated_at, updated_by, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						id,
						taskId.value,
						text,
						rank,
						now,
						now,
						Runtime.actor(),
						task.visibility,
					],
				);
				Oplog.afterWrite(db, ITEMS_TABLE, "insert", id);
				return id;
			});
			return changeOf(db, taskId.value, ids);
		});
	};

	/**
	 * Tick (`done`, the default) or untick items of one issue, as `actor`.
	 * An item already in that state is left as it is, who ticked it included.
	 */
	export const tick = async (
		basePath: string,
		input: TickInput,
		actor = Runtime.actor(),
	): Promise<Result<ChecklistChange>> => {
		const parsed = TickSchema.safeParse(input);
		if (!parsed.success)
			return err(new Error(`Invalid tick: ${parsed.error.message}`));
		const { items: refs, done } = parsed.data;
		const resolved = await resolveAll(basePath, refs);
		if (!resolved.ok) return resolved;
		return atomic(basePath, (db) => {
			const rows = resolved.value
				.filter(({ id }, n, all) => all.findIndex((ref) => ref.id === id) === n)
				.map(({ ref, id }) => liveItem(db, id, ref));
			const [taskId, ...others] = new Set(rows.map((row) => row.task_id));
			if (taskId === undefined || others.length)
				throw new Error(
					`Tick the items of one issue per call: ${refs.join(", ")} span ${others.length + 1}.`,
				);
			const now = new Date().toISOString();
			for (const row of rows)
				if ((row.done_at !== null) !== done)
					write(db, row.id, {
						done_at: done ? now : null,
						done_by: done ? actor : null,
					});
			return changeOf(
				db,
				taskId,
				rows.map((row) => row.id),
			);
		});
	};

	/** Change one item's text or 1-based position, or remove it. */
	export const edit = async (
		basePath: string,
		input: EditInput,
	): Promise<Result<ChecklistChange>> => {
		const parsed = EditSchema.safeParse(input);
		if (!parsed.success)
			return err(new Error(`Invalid checklist edit: ${parsed.error.message}`));
		const { item: ref, text, position, remove } = parsed.data;
		const id = await resolve(basePath, ref);
		if (!id.ok) return id;
		return atomic(basePath, (db) => {
			const row = liveItem(db, id.value, ref);
			if (remove) {
				write(db, row.id, { removed_at: new Date().toISOString() });
				return changeOf(db, row.task_id, [row.id]);
			}
			const set: Record<string, SqlValue> = {};
			if (text !== undefined) set.text = text;
			if (position !== undefined) {
				const others = live(selectItems(db, row.task_id)).filter(
					(item) => item.id !== row.id,
				);
				if (position > others.length + 1)
					throw new Error(positionProblem(position, others.length + 1));
				const { placed, moved } = place(others, position - 1, [row.id]);
				for (const entry of moved) write(db, entry.id, { rank: entry.rank });
				for (const { rank } of placed) set.rank = rank;
			}
			write(db, row.id, set);
			return changeOf(db, row.task_id, [row.id]);
		});
	};
}
