/**
 * Planner Sync — HTTP Transport
 *
 * The same `SyncTransport` as `local-relay.ts`, over two POST routes on the
 * planner-sync Worker. Everything HTTP lives here and nothing above the seam
 * changes: `Sync.push` / `Sync.pull` cannot tell which transport they hold, so
 * every convergence assertion keeps running against the in-process relay.
 *
 * THE WIRE SHAPE IS NOT `PullPage`, deliberately. The server returns
 * `{ serverSeq, payload }` where `payload` is the verbatim JSON text that was
 * pushed, because merging `serverSeq` into the envelope would force the Durable
 * Object to parse payloads — and never parsing them is why it can hold planner
 * data without holding planner schema. Reconstitution happens here, through a
 * `.passthrough()` schema: plain zod strips unknown keys, and inside a sync path
 * an unknown key is a column a newer device sent, so stripping it is silent
 * data loss.
 *
 * TWO FAILURE MODES THIS FILE EXISTS TO SURVIVE:
 *
 * 1. POISON PILL. The remote batch is atomic, so one op the server will never
 *    accept — an oversized row, and task descriptions are PRDs — fails every
 *    retry that includes it, forever, with no error a human ever sees. The
 *    server cannot fix this without giving up atomicity. So a failing chunk is
 *    BISECTED until the offender is alone, and an op that fails alone is
 *    quarantined: recorded, skipped, watermark still moving. A visible skipped
 *    op is recoverable; an invisible permanent stall is not.
 *
 * 2. LOG RESET. If the log is wiped or restored from a bookmark, a device whose
 *    `last_applied_seq` sits above the new head reads "caught up" forever.
 *    `PushAck.head` already exposes it — `head < lastAppliedSeq` means the log
 *    shrank, which is impossible in a healthy log, and the answer is to rewind
 *    and re-read from 0.
 *
 * QUARANTINE ONLY ON A SERVER REFUSAL. Bisecting on any failure at all would
 * eventually quarantine perfectly good ops because the network was down or the
 * token was wrong. Only a response the server actually produced, with a status
 * that means "this content is unacceptable", is grounds for giving up on an op;
 * everything else propagates as `err` so the watermark stays put and the next
 * pass retries.
 */

import { z } from "zod";
import type { Db } from "../db/port";
import { err, ok, type Result, tryCatch } from "../result";
import { withDb } from "../runtime";
import { type SyncOp, SyncOpSchema } from "../schemas";
import { Oplog } from "../storage/oplog";
import type { PullPage, PushAck, RelayOp, SyncTransport } from "./transport";

// ============================================================
// Constants
// ============================================================

/** Default push chunk ceiling. Mirrors `SyncConfigSchema.batchBytes`. */
const DEFAULT_BATCH_BYTES = 262144;

/** Attempts per chunk before it is bisected or given up on. */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Backoff base, matching `Connection`'s SQLITE_BUSY retry shape. */
const RETRY_BASE_MS = 250;

/** Server-side `MAX_PULL_LIMIT`. A larger `limit` is a 400, so clamp instead. */
const MAX_PULL_LIMIT = 1000;

/**
 * Statuses that mean the server looked at this content and refused it. The only
 * grounds for quarantining an op.
 *
 * 400 — failed the wire schema. 413 — too large for the edge. 500 — storage
 * refused the write, which is what a row over the 2 MB limit produces.
 *
 * Everything else is deliberately absent: 401/403 is a bad token, 404/405 a bad
 * URL, 429/503 backpressure. Quarantining on any of those would drop the whole
 * oplog because of a config typo.
 */
const REFUSAL_STATUSES = new Set([400, 413, 500]);

// ============================================================
// Types
// ============================================================

/** Just the part of `fetch` this file uses, so a test can substitute one. */
export type FetchLike = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
	},
) => Promise<Response>;

export type HttpTransportConfig = {
	/** Worker base URL. A trailing slash is fine. */
	url: string;
	/** Bearer secret, matching the Worker's `SYNC_TOKEN`. */
	token: string;
	/** This device's identity, as written in `sync_state`. */
	deviceId: string;
	/** Friendly name for the server's `devices` row. */
	name?: string;
	/** Extra headers on every request, e.g. Access service-token credentials. */
	headers?: Record<string, string>;
	/** Push chunk ceiling in bytes (default 256 KB). */
	batchBytes?: number;
	/** Attempts per chunk (default 3). */
	maxAttempts?: number;
	/** Test seams. */
	fetchImpl?: FetchLike;
	sleep?: (ms: number) => Promise<void>;
};

/** What `PushAck` cannot say: which ops were given up on. */
type ChunkOutcome = {
	accepted: number;
	duplicates: number;
	head: number;
	quarantined: number;
};

const PushAckSchema = z.object({
	accepted: z.number(),
	duplicates: z.number(),
	head: z.number(),
});

const WirePullPageSchema = z.object({
	ops: z.array(z.object({ serverSeq: z.number(), payload: z.string() })),
	throughSeq: z.number(),
	hasMore: z.boolean(),
});

/**
 * A refusal carries the status so the caller can tell "the server said no to
 * this content" from "the request never landed".
 */
type Failure = {
	error: Error;
	/** Absent when fetch itself threw — no response, so nothing was refused. */
	status?: number;
};

// ============================================================
// Private Helpers
// ============================================================

const sleepMs = (ms: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, ms));

/** Jittered exponential backoff, same shape as `Connection`'s busy retry. */
const backoffMs = (attempt: number): number =>
	RETRY_BASE_MS * 2 ** attempt + Math.random() * RETRY_BASE_MS;

const routeUrl = (base: string, route: "push" | "pull"): string =>
	`${base.replace(/\/+$/, "")}/${route}`;

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

const quarantinable = (failure: Failure): boolean =>
	failure.status !== undefined && REFUSAL_STATUSES.has(failure.status);

/**
 * Split ops into chunks no larger than `batchBytes`.
 *
 * An op that exceeds the ceiling on its own gets its own chunk rather than
 * being dropped here: whether the server accepts it is the server's call, and
 * pre-judging it would put a second size limit in the codebase to drift from
 * the real one.
 */
const chunkByBytes = (ops: SyncOp[], batchBytes: number): SyncOp[][] => {
	const chunks: SyncOp[][] = [];
	let current: SyncOp[] = [];
	let currentBytes = 0;

	for (const op of ops) {
		const size = byteLength(JSON.stringify(op));
		if (current.length > 0 && currentBytes + size > batchBytes) {
			chunks.push(current);
			current = [];
			currentBytes = 0;
		}
		current.push(op);
		currentBytes += size;
	}

	if (current.length > 0) chunks.push(current);
	return chunks;
};

const inDb = async <T>(
	basePath: string,
	fn: (db: Db) => Result<T>,
): Promise<Result<T>> => {
	const outer = await withDb(basePath, fn);
	return outer.ok ? outer.value : outer;
};

/**
 * `SyncOpSchema` that KEEPS unknown keys.
 *
 * The default strip is silent data loss here: an unknown key on a pulled op is a
 * field a newer device sent, and dropping it inside a sync path loses a write
 * nothing will ever re-send. Built once — `.passthrough()` returns a new schema
 * per call, and this runs per op.
 */
const PulledOpSchema = SyncOpSchema.passthrough();

/** Reconstitute the `RelayOp` the applier wants from the verbatim payload text. */
const reconstitute = (op: {
	serverSeq: number;
	payload: string;
}): Result<RelayOp> => {
	const decoded = ((): Result<unknown> => {
		try {
			return ok(JSON.parse(op.payload) as unknown);
		} catch (e) {
			return err(
				new Error(
					`Pulled op at serverSeq ${op.serverSeq} is not JSON: ${e instanceof Error ? e.message : String(e)}`,
				),
			);
		}
	})();
	if (!decoded.ok) return decoded;

	const parsed = PulledOpSchema.safeParse(decoded.value);
	if (!parsed.success) {
		return err(
			new Error(
				`Pulled op at serverSeq ${op.serverSeq} is not a sync op: ${parsed.error.message}`,
			),
		);
	}

	return ok({ ...parsed.data, serverSeq: op.serverSeq });
};

// ============================================================
// HttpTransport Namespace
// ============================================================

export namespace HttpTransport {
	/**
	 * A transport for one device against one Worker.
	 *
	 * `basePath` is here because two of the three things this transport must do
	 * on failure are local writes — recording a quarantined op, and rewinding the
	 * applied watermark after a log reset. Routing them through a callback would
	 * put the decision somewhere that cannot see the HTTP status that produced
	 * it.
	 */
	export const create = (
		basePath: string,
		config: HttpTransportConfig,
	): SyncTransport => {
		const doFetch = config.fetchImpl ?? (globalThis.fetch as FetchLike);
		const pause = config.sleep ?? sleepMs;
		const batchBytes = config.batchBytes ?? DEFAULT_BATCH_BYTES;
		const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

		const request = async (
			route: "push" | "pull",
			body: unknown,
		): Promise<Result<unknown, Failure>> => {
			const sent = await tryCatch(() =>
				doFetch(routeUrl(config.url, route), {
					method: "POST",
					headers: {
						...config.headers,
						Authorization: `Bearer ${config.token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				}),
			);
			if (!sent.ok) {
				// No response at all: DNS, refused connection, timeout. Never a refusal.
				return err({ error: sent.error });
			}

			const response = sent.value;
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				return err({
					error: new Error(
						`planner-sync ${route} failed with ${response.status}: ${detail}`,
					),
					status: response.status,
				});
			}

			const decoded = await tryCatch(() => response.json() as Promise<unknown>);
			return decoded.ok
				? ok(decoded.value)
				: err({ error: decoded.error, status: response.status });
		};

		/**
		 * POST one chunk, retrying the identical body on failure.
		 *
		 * Retries reuse each op's own `opId`, which is what makes them safe: the
		 * server's `ON CONFLICT(op_id) DO NOTHING` turns a re-send of an already
		 * committed batch into duplicates rather than a second insert. So a lost
		 * ack costs a duplicate count, never a doubled row.
		 */
		const sendOnce = async (
			ops: SyncOp[],
		): Promise<Result<PushAck, Failure>> => {
			let last: Failure = { error: new Error("planner-sync push: no attempt") };

			for (let attempt = 0; attempt < maxAttempts; attempt++) {
				if (attempt > 0) await pause(backoffMs(attempt - 1));

				const response = await request("push", {
					deviceId: config.deviceId,
					name: config.name,
					ops,
				});
				if (!response.ok) {
					last = response.error;
					continue;
				}

				const ack = PushAckSchema.safeParse(response.value);
				if (ack.success) return ok(ack.data);

				last = {
					error: new Error(
						`planner-sync push returned an unreadable ack: ${ack.error.message}`,
					),
				};
			}

			return err(last);
		};

		/** Record an op nobody will ever accept, and report it as skipped. */
		const quarantine = async (
			op: SyncOp,
			failure: Failure,
		): Promise<Result<ChunkOutcome>> => {
			const recorded = await inDb(basePath, (db) =>
				Oplog.quarantine(db, {
					opId: op.opId,
					tbl: op.tbl,
					rowId: op.rowId,
					bytes: byteLength(JSON.stringify(op)),
					reason: failure.error.message,
				}),
			);
			if (!recorded.ok) return recorded;

			console.warn(
				`[jake planner] sync quarantined op ${op.opId} (${op.tbl}/${op.rowId}): ${failure.error.message}`,
			);
			return ok({ accepted: 0, duplicates: 0, head: 0, quarantined: 1 });
		};

		/**
		 * Send a chunk, isolating a poison op by bisection.
		 *
		 * Halving only happens for a status the server produced by refusing the
		 * content, so a 401 or a dead network aborts the pass on the first chunk
		 * instead of walking the whole batch down to singletons.
		 */
		const sendChunk = async (ops: SyncOp[]): Promise<Result<ChunkOutcome>> => {
			const ack = await sendOnce(ops);
			if (ack.ok) {
				return ok({
					accepted: ack.value.accepted,
					duplicates: ack.value.duplicates,
					head: ack.value.head,
					quarantined: 0,
				});
			}

			if (!quarantinable(ack.error)) return err(ack.error.error);

			const [op] = ops;
			if (ops.length === 1 && op !== undefined) {
				return quarantine(op, ack.error);
			}

			const middle = Math.floor(ops.length / 2);
			const first = await sendChunk(ops.slice(0, middle));
			if (!first.ok) return first;
			const second = await sendChunk(ops.slice(middle));
			if (!second.ok) return second;

			return ok({
				accepted: first.value.accepted + second.value.accepted,
				duplicates: first.value.duplicates + second.value.duplicates,
				head: Math.max(first.value.head, second.value.head),
				quarantined: first.value.quarantined + second.value.quarantined,
			});
		};

		/**
		 * A head below this device's applied watermark means the log lost rows this
		 * device had already read — a wipe or a bookmark restore. Rewind so the
		 * next pull re-reads from 0; every apply is idempotent, so re-reading
		 * costs time and changes nothing.
		 */
		const checkLogReset = async (head: number): Promise<Result<void>> => {
			const state = await inDb(basePath, Oplog.getState);
			if (!state.ok) return state;
			if (state.value === undefined) return ok(undefined);
			if (head >= state.value.lastAppliedSeq) return ok(undefined);

			console.warn(
				`[jake planner] sync log reset detected: remote head ${head} is below applied watermark ${state.value.lastAppliedSeq}; resyncing from 0`,
			);
			return inDb(basePath, Oplog.resetApplied);
		};

		return {
			push: async (incoming: SyncOp[]): Promise<Result<PushAck>> => {
				let accepted = 0;
				let duplicates = 0;
				let head = 0;

				for (const chunk of chunkByBytes(incoming, batchBytes)) {
					const outcome = await sendChunk(chunk);
					if (!outcome.ok) return outcome;

					accepted += outcome.value.accepted;
					duplicates += outcome.value.duplicates;
					head = Math.max(head, outcome.value.head);
				}

				// Zero only when nothing was acked (an empty push, or every op
				// quarantined), and a log reset cannot be inferred from that.
				if (head > 0) {
					const checked = await checkLogReset(head);
					if (!checked.ok) return checked;
				}

				return ok({ accepted, duplicates, head });
			},

			pull: async (
				sinceSeq: number,
				limit: number,
			): Promise<Result<PullPage>> => {
				if (limit <= 0) {
					return err(new Error(`Pull limit must be positive, got ${limit}`));
				}

				const response = await request("pull", {
					deviceId: config.deviceId,
					sinceSeq,
					limit: Math.min(limit, MAX_PULL_LIMIT),
				});
				if (!response.ok) return err(response.error.error);

				const page = WirePullPageSchema.safeParse(response.value);
				if (!page.success) {
					return err(
						new Error(
							`planner-sync pull returned an unreadable page: ${page.error.message}`,
						),
					);
				}

				const ops: RelayOp[] = [];
				for (const wire of page.data.ops) {
					const op = reconstitute(wire);
					if (!op.ok) return op;
					ops.push(op.value);
				}

				// `throughSeq` comes from the page, never from `ops.at(-1)`: the server
				// withholds this device's own ops AFTER taking the window, so a page
				// can legitimately return nothing and still have to move the cursor.
				return ok({
					ops,
					throughSeq: page.data.throughSeq,
					hasMore: page.data.hasMore,
				});
			},
		};
	};
}
