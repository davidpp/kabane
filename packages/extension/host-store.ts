/**
 * The storage kit on `host.store`: an extension's data modules write through it, and it owns
 * the commit and the notification (`ARCHITECTURE.md`, "An extension's data modules get a storage
 * kit on `host.store`"). Built from core's exports, so the CLI and an extension's module tests
 * run the same kit over a real database.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
	atomic,
	err,
	Events,
	ok,
	Oplog,
	PLANNER_EVENTS,
	Planner,
	type Result,
	type Task,
	trySync,
	withDb,
} from "@kabane/core";
import type { Host } from "./host";

/** The write that holds the turn: who opened it, since when, and whether it is still open. */
type Holder = { owner: string; since: number; open: boolean };

/**
 * The write the current call chain runs inside, if any. The write holds the database's write lock
 * on its connection until `fn` returns; a second write from inside it would open another
 * connection that waits on that lock on the one thread that could release it. A callback `fn`
 * schedules keeps this context after the write ends, so the guard reads `open`, which the write
 * clears when it ends.
 */
const inWrite = new AsyncLocalStorage<Holder>();
let holder: Holder | undefined;
const waiting: (() => void)[] = [];

export namespace HostWrites {
	/**
	 * How long a write waits for its turn: SQLite's busy timeout, which `@kabane/sqlite` sets to
	 * 5000 ms, so a write that cannot get the lock fails after the same wait whichever way it waits.
	 */
	export const WAIT_MS = 5_000;
	export const NESTED =
		"store.write was called inside another store.write, which holds the database's write lock until it returns; do this work in the open transaction with tx.db and tx.updateTask, or call store.write after the first one returns";

	/** True inside the `fn` of a `store.write` that is still open, whichever host opened it. */
	export const open = (): boolean => inWrite.getStore()?.open === true;

	/**
	 * Take the process's write turn for `owner` (worded for a message: "extension notes's
	 * store.write", "host.record kabane_comment"), waiting at most `WAIT_MS`. A waiter that gives
	 * up is removed from the queue, so it never runs later. The value releases the turn.
	 */
	export const take = (owner: string): Promise<Result<Holder>> => {
		if (holder === undefined) {
			holder = { owner, since: Date.now(), open: true };
			return Promise.resolve(ok(holder));
		}
		return new Promise((resolve) => {
			const grant = () => {
				clearTimeout(timer);
				holder = { owner, since: Date.now(), open: true };
				resolve(ok(holder));
			};
			const timer = setTimeout(() => {
				const at = waiting.indexOf(grant);
				if (at >= 0) waiting.splice(at, 1);
				const held = holder;
				resolve(
					err(
						new Error(
							`${owner} waited ${WAIT_MS} ms for the write turn and gave up without writing: ${held ? `${held.owner} has held it for ${Date.now() - held.since} ms` : "another write held it"}. A store.write must not await I/O or another write inside fn; finish the work in the transaction, or do it after store.write returns`,
						),
					),
				);
			}, WAIT_MS);
			waiting.push(grant);
		});
	};

	/** Release the turn `taken` holds and hand it to the next waiter. */
	export const release = (taken: Holder): void => {
		taken.open = false;
		if (holder !== taken) return;
		holder = undefined;
		waiting.shift()?.();
	};
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
	owner = "an extension",
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
			const turn = await HostWrites.take(`${owner}'s store.write`);
			if (!turn.ok) return turn;
			const written = await inWrite
				.run(turn.value, attempt)
				.finally(() => HostWrites.release(turn.value));
			// After the turn is released, so a listener may write.
			if (written.ok)
				for (const task of changed.values())
					await Events.emit(PLANNER_EVENTS.TASK_UPDATED, task);
			return written;
		},
	};
};
