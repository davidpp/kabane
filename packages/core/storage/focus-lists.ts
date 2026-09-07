/**
 * Planner Storage — Focus Lists
 */

import type { Result } from "../result";
import { Runtime, withDb } from "../runtime";

import type { FocusList, FocusListDraft, FocusListUpdate } from "../schemas";
import { generateId, rowToFocusList, TABLES } from "./helpers";
import { Oplog } from "./oplog";

export namespace Planner {
	export const getFocusList = async (
		basePath: string,
		period: FocusList["period"],
	): Promise<Result<FocusList | null>> => {
		return withDb(basePath, (db) => {
			const row = db
				.query(`SELECT * FROM ${TABLES.focus_lists} WHERE period = ?`)
				.get(period) as Record<string, unknown> | null;

			return row ? rowToFocusList(row) : null;
		});
	};

	export const saveFocusList = async (
		basePath: string,
		draft: FocusListDraft,
	): Promise<Result<FocusList>> => {
		return withDb(basePath, (db) => {
			const now = new Date().toISOString();

			// Upsert: delete existing and insert new. The delete is captured from
			// the row that was, so the other devices drop the same ULID.
			const previous = db
				.query<Record<string, unknown>, [string]>(
					`SELECT * FROM ${TABLES.focus_lists} WHERE period = ?`,
				)
				.get(draft.period);
			db.run(`DELETE FROM ${TABLES.focus_lists} WHERE period = ?`, [
				draft.period,
			]);
			if (previous) {
				Oplog.afterDelete(db, [{ tbl: "focus_lists", row: previous }]);
			}

			const id = generateId();
			db.run(
				`INSERT INTO ${TABLES.focus_lists}
           (id, period, items, theme, reflection, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					id,
					draft.period,
					JSON.stringify(draft.items),
					draft.theme ?? null,
					draft.reflection ?? null,
					Runtime.actor(),
					now,
					now,
				],
			);
			Oplog.afterWrite(db, "focus_lists", "insert", id);

			return {
				id,
				period: draft.period,
				items: draft.items,
				theme: draft.theme,
				reflection: draft.reflection,
				createdAt: now,
				updatedAt: now,
			};
		});
	};

	export const updateFocusList = async (
		basePath: string,
		period: FocusList["period"],
		updates: FocusListUpdate,
	): Promise<Result<FocusList | null>> => {
		const updateResult = await withDb(basePath, (db) => {
			const now = new Date().toISOString();
			const sets: string[] = [
				"updated_at = ?",
				"version = version + 1",
				"updated_by = ?",
			];
			const params: (string | number | null)[] = [now, Runtime.actor()];

			if (updates.items !== undefined) {
				sets.push("items = ?");
				params.push(JSON.stringify(updates.items));
			}
			if (updates.theme !== undefined) {
				sets.push("theme = ?");
				params.push(updates.theme);
			}
			if (updates.reflection !== undefined) {
				sets.push("reflection = ?");
				params.push(updates.reflection);
			}

			params.push(period);

			db.run(
				`UPDATE ${TABLES.focus_lists} SET ${sets.join(", ")} WHERE period = ?`,
				params,
			);
			const row = db
				.query<{ id: string }, [string]>(
					`SELECT id FROM ${TABLES.focus_lists} WHERE period = ?`,
				)
				.get(period);
			if (row) Oplog.afterWrite(db, "focus_lists", "update", row.id);
		});

		if (!updateResult.ok) return updateResult;

		return getFocusList(basePath, period);
	};
}
