/**
 * The oplog — append and read the shared total order.
 *
 * Synchronous by design: DO SQLite's API is synchronous, and every function here
 * runs inside one `transactionSync` closure with no `await` in it. That matters
 * twice over — cursors must be drained before any await or snapshot isolation
 * breaks, and a closure that returns normally is a closure that commits.
 */

import type { PullPage, PullRequest, PushAck, PushRequest } from "./wire";

// ============================================================
// SQL
// ============================================================

/**
 * ONE bound parameter for the whole batch, unpacked with `json_each`.
 *
 * A row-per-statement insert breaks at ~4 ops: DO SQLite allows 100 bound
 * parameters per query and each op needs 4 of them. Passing the batch as a
 * single JSON string also sidesteps the 100 KB SQL-statement limit, because a
 * parameter VALUE is bounded by the 2 MB row/string limit instead.
 *
 * Three details that are each load-bearing:
 * - `WHERE true` — without it SQLite cannot tell the upsert's `ON CONFLICT` from
 *   a join's `ON`, and refuses to parse `INSERT ... SELECT ... ON CONFLICT`.
 * - `DO NOTHING` on `op_id` — this is the idempotency guarantee. A push retried
 *   after a lost ack re-sends the same `opId`s and changes nothing.
 * - `RETURNING server_seq` — the accepted count, exactly. The two obvious
 *   alternatives are both wrong, measured: `rowsWritten` reported 5 for a 2-row
 *   insert and 1 for a batch that inserted nothing (it counts index writes), and
 *   a head delta undercounts because a skipped insert still burns an
 *   AUTOINCREMENT value — after one conflict the next op landed at seq 6, not 3.
 */
const APPEND_SQL = `
	WITH incoming(op) AS (SELECT value FROM json_each(?))
	INSERT INTO oplog (device_id, op_id, payload, received_at)
	SELECT json_extract(op, '$.deviceId'), json_extract(op, '$.opId'), op, ?
	FROM incoming
	WHERE true
	ON CONFLICT(op_id) DO NOTHING
	RETURNING server_seq
`;

const REGISTER_DEVICE_SQL = `
	INSERT INTO devices (device_id, name) VALUES (?, ?)
	ON CONFLICT(device_id) DO UPDATE SET name = COALESCE(excluded.name, devices.name)
`;

const ACK_DEVICE_SQL = `
	INSERT INTO devices (device_id, last_ack_seq) VALUES (?, ?)
	ON CONFLICT(device_id) DO UPDATE
	SET last_ack_seq = MAX(devices.last_ack_seq, excluded.last_ack_seq)
`;

/**
 * The page window, taken BEFORE the caller's own ops are filtered out — see
 * `read` for why that ordering is the whole ballgame.
 */
const WINDOW_SQL = `
	SELECT server_seq, device_id, payload
	FROM oplog
	WHERE server_seq > ?
	ORDER BY server_seq
	LIMIT ?
`;

const HEAD_SQL = "SELECT COALESCE(MAX(server_seq), 0) AS head FROM oplog";

// ============================================================
// Private Helpers
// ============================================================

type WindowRow = {
	server_seq: number;
	device_id: string;
	payload: string;
};

const registerDevice = (
	sql: SqlStorage,
	deviceId: string,
	name: string | undefined,
): void => {
	sql.exec(REGISTER_DEVICE_SQL, deviceId, name ?? null);
};

/**
 * Record how far a device has been handed. Advisory only — the device owns its
 * real watermark, this is for looking at the log and seeing who is behind.
 */
const ackDevice = (sql: SqlStorage, deviceId: string, seq: number): void => {
	sql.exec(ACK_DEVICE_SQL, deviceId, seq);
};

// ============================================================
// Oplog Namespace
// ============================================================

export namespace Oplog {
	/** `server_seq` of the head, or 0 when the log is empty. */
	export const head = (sql: SqlStorage): number =>
		sql.exec<{ head: number }>(HEAD_SQL).one().head;

	/**
	 * Append a batch. Idempotent on `opId`.
	 *
	 * `duplicates` is the batch size minus what was inserted, which also covers
	 * the same `opId` appearing twice inside one batch — the second occurrence
	 * conflicts with the first and counts as a duplicate, same as the in-process
	 * relay.
	 *
	 * `received_at` is a JS ISO string, never SQLite's `datetime('now')`: that
	 * emits a space-separated, second-granularity value that sorts below and
	 * misorders against every other timestamp in Jake.
	 */
	export const append = (sql: SqlStorage, req: PushRequest): PushAck => {
		registerDevice(sql, req.deviceId, req.name);

		const inserted = sql
			.exec<{ server_seq: number }>(
				APPEND_SQL,
				JSON.stringify(req.ops),
				new Date().toISOString(),
			)
			.toArray();

		return {
			accepted: inserted.length,
			duplicates: req.ops.length - inserted.length,
			head: head(sql),
		};
	};

	/**
	 * Read one page, oldest first, withholding the caller's own ops.
	 *
	 * THE WINDOW IS TAKEN BEFORE THE DEVICE FILTER, and `throughSeq` describes
	 * the window, not the returned ops. A page whose every row belonged to the
	 * caller yields zero ops and still has to move the watermark — deriving the
	 * cursor from the last returned op would leave `sinceSeq` where it was while
	 * `hasMore` stayed true, and the client would re-read that same page forever.
	 */
	export const read = (sql: SqlStorage, req: PullRequest): PullPage => {
		const window = sql
			.exec<WindowRow>(WINDOW_SQL, req.sinceSeq, req.limit)
			.toArray();

		const throughSeq = window.at(-1)?.server_seq ?? req.sinceSeq;
		const ops = window
			.filter((row) => row.device_id !== req.deviceId)
			.map((row) => ({ serverSeq: row.server_seq, payload: row.payload }));
		const hasMore = head(sql) > throughSeq;

		ackDevice(sql, req.deviceId, throughSeq);

		return { ops, throughSeq, hasMore };
	};
}
