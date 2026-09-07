/**
 * Planner Sync — In-process Relay
 *
 * A `SyncTransport` backed by an ordered in-memory log. This is what makes the
 * slice-1 milestone real: two planner DBs in separate temp dirs share one relay
 * and converge with no Worker, no D1, no wrangler and no network.
 *
 * SHIPPED CODE, NOT A FIXTURE. When `http-transport.ts` (JJAK-1074) lands, this
 * stays as the permanent test double so every convergence assertion still runs
 * in CI without Cloudflare, and so a resolution bug can be reproduced without a
 * deploy.
 *
 * IN MEMORY, NOT SQLITE. The contract a transport owes an applier is exactly
 * one thing — a monotonic total order with idempotent append — and an array
 * plus a `Set` of seen `opId`s is that, with no second database file to open,
 * pragma, or clean up. Durable ordering is D1's job in slice 2, not the double's.
 *
 * THE WIRE IS A BOUNDARY, so `push` re-parses every op with `SyncOpSchema`
 * rather than trusting the caller. That also strips the local `seq` a
 * `DrainedOp` carries, which is meaningless to anyone but the device that
 * captured it.
 */

import { err, ok, type Result } from "../result";
import { type SyncOp, SyncOpSchema } from "../schemas";
import type { PullPage, PushAck, RelayOp, SyncTransport } from "./transport";

// ============================================================
// Types
// ============================================================

/**
 * The shared log. Mutable by design — it stands in for a server, and every
 * device holding a transport for it observes one another's appends.
 */
export type Relay = {
	/** Appended in `serverSeq` order; index + 1 is the `serverSeq`. */
	readonly log: RelayOp[];
	/** `opId`s already appended. The idempotency key, same as the remote's. */
	readonly seen: Set<string>;
};

// ============================================================
// Private Helpers
// ============================================================

const parseOp = (op: SyncOp): Result<SyncOp> => {
	const parsed = SyncOpSchema.safeParse(op);
	return parsed.success
		? ok(parsed.data)
		: err(new Error(`Relay rejected a malformed op: ${parsed.error.message}`));
};

// ============================================================
// LocalRelay Namespace
// ============================================================

export namespace LocalRelay {
	/** A fresh, empty log. One per simulated server. */
	export const create = (): Relay => ({ log: [], seen: new Set<string>() });

	/** `serverSeq` of the head, or 0 when the log is empty. */
	export const head = (relay: Relay): number => relay.log.length;

	/** The whole log, for assertions and debugging. */
	export const ops = (relay: Relay): readonly RelayOp[] => relay.log;

	/**
	 * A transport for one device against `relay`.
	 *
	 * `deviceId` must match what `Oplog.initDevice` wrote on that machine — it
	 * is how `pull` withholds the caller's own ops.
	 */
	export const transportFor = (
		relay: Relay,
		deviceId: string,
	): SyncTransport => ({
		push: async (incoming: SyncOp[]): Promise<Result<PushAck>> => {
			let accepted = 0;
			let duplicates = 0;

			for (const raw of incoming) {
				const parsed = parseOp(raw);
				if (!parsed.ok) return parsed;

				const op = parsed.value;
				if (relay.seen.has(op.opId)) {
					duplicates++;
					continue;
				}

				relay.seen.add(op.opId);
				relay.log.push({ ...op, serverSeq: relay.log.length + 1 });
				accepted++;
			}

			return ok({ accepted, duplicates, head: head(relay) });
		},

		pull: async (
			sinceSeq: number,
			limit: number,
		): Promise<Result<PullPage>> => {
			if (limit <= 0) {
				return err(new Error(`Pull limit must be positive, got ${limit}`));
			}

			// The window is taken BEFORE the device filter so `throughSeq` covers
			// what was examined, not what was returned.
			const window = relay.log
				.filter((op) => op.serverSeq > sinceSeq)
				.slice(0, limit);
			const throughSeq = window[window.length - 1]?.serverSeq ?? sinceSeq;

			return ok({
				ops: window.filter((op) => op.deviceId !== deviceId),
				throughSeq,
				hasMore: head(relay) > throughSeq,
			});
		},
	});
}
