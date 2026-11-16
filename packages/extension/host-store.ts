/**
 * The storage kit on `host.store`: an extension's data modules write through it, and it owns
 * the commit and the notification (`ARCHITECTURE.md`, "An extension's data modules get a storage
 * kit on `host.store`"). Built from core's exports, so the CLI and an extension's module tests
 * run the same kit over a real database.
 */
import {
	atomic,
	err,
	Events,
	Oplog,
	PLANNER_EVENTS,
	Planner,
	type Result,
	type Task,
	trySync,
	withDb,
} from "@cabane/core";
import type { Host } from "./host";

const NOT_CONFIGURED =
	"the runtime is not configured yet for this host; use store after the factory returns and the store opens (standalone commands do not open it automatically)";

/**
 * `basePath` is the database's directory once the store is open, undefined before. `tables` are
 * the replicated tables the extension's own modules declare: capture refuses any other.
 */
export const createHostStore = (
	basePath: () => string | undefined,
	tables: () => readonly string[],
): Host.Store => {
	const refuse = (table: string): Result<void> =>
		err(
			new Error(
				`"${table}" is no table this extension's modules declare in syncTables; an extension captures only its own tables and changes tasks with tx.updateTask`,
			),
		);
	return {
		read: async (fn) => {
			const base = basePath();
			if (base === undefined) return err(new Error(NOT_CONFIGURED));
			const read = await withDb(base, async (db) => {
				db.run("PRAGMA query_only = ON");
				try {
					return await fn(db);
				} finally {
					db.run("PRAGMA query_only = OFF");
				}
			});
			return read.ok ? read.value : read;
		},
		write: async (fn) => {
			const base = basePath();
			if (base === undefined) return err(new Error(NOT_CONFIGURED));
			const changed = new Map<string, Task>();
			const written = await atomic(base, async (db) => {
				let failed: Error | undefined;
				const checked = <T>(result: Result<T>): Result<T> => {
					if (!result.ok) failed ??= result.error;
					return result;
				};
				const owns = (table: string): boolean => tables().includes(table);
				const tx: Host.Tx = {
					db,
					afterWrite: (table, op, id) =>
						checked(
							owns(table)
								? trySync(() => Oplog.afterWrite(db, table, op, id))
								: refuse(table),
						),
					snapshot: (table, id) => Oplog.snapshot(db, table, id),
					afterDelete: (rows) => {
						const foreign = rows.find(({ tbl }) => !owns(tbl));
						return checked(
							foreign
								? refuse(foreign.tbl)
								: trySync(() => Oplog.afterDelete(db, rows)),
						);
					},
					updateTask: (id, updates) => {
						const updated = checked(Planner.updateTaskIn(db, id, updates));
						if (updated.ok && updated.value)
							changed.set(updated.value.id, updated.value);
						return updated;
					},
				};
				const result = await fn(tx);
				// Thrown inside the transaction to roll it back; `atomic` returns it as the err.
				if (!result.ok) throw result.error;
				if (failed) throw failed;
				return result.value;
			});
			if (written.ok)
				for (const task of changed.values())
					await Events.emit(PLANNER_EVENTS.TASK_UPDATED, task);
			return written;
		},
	};
};
