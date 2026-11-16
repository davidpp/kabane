import { AsyncLocalStorage } from "node:async_hooks";
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

/**
 * Whether the current call chain runs inside a `store.write`. The write holds the database's
 * write lock on its connection until `fn` returns; a second write from inside it would open
 * another connection that waits on that lock on the one thread that could release it.
 */
const inWrite = new AsyncLocalStorage<true>();
/** Writes from separate call chains in this process take turns instead of meeting in SQLite's busy handler. */
let turn: Promise<void> = Promise.resolve();

export namespace HostWrites {
	/** True inside the `fn` of a `store.write`, whichever host opened it. */
	export const open = (): boolean => inWrite.getStore() === true;
	/** Resolves once every write already started in this process has finished. */
	export const idle = (): Promise<void> => turn;
	export const NESTED =
		"store.write was called inside another store.write, which holds the database's write lock until it returns; do this work in the open transaction with tx.db and tx.updateTask, or call store.write after the first one returns";
}

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
			if (HostWrites.open()) return err(new Error(HostWrites.NESTED));
			const changed = new Map<string, Task>();
			const attempt = () =>
				atomic(base, async (db) => {
					// `withDb` reruns this on a busy database: only the attempt that commits notifies.
					changed.clear();
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
			const slot = turn.then(() => inWrite.run(true, attempt));
			turn = slot.then(
				() => undefined,
				() => undefined,
			);
			const written = await slot;
			// After the turn is released, so a listener may write.
			if (written.ok)
				for (const task of changed.values())
					await Events.emit(PLANNER_EVENTS.TASK_UPDATED, task);
			return written;
		},
	};
};
