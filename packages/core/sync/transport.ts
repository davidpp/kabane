/**
 * Planner Sync — Transport Seam
 *
 * The one hinge that makes slice 1 provable with no cloud involvement. A
 * transport hands ops to a shared ordered log and reads them back in that
 * order; everything subtle (capture, resolution, apply ordering, the rename
 * protocol) sits on this side of the seam and is testable without a network.
 *
 * NO HTTP CONCEPTS LEAK IN. No URLs, headers, status codes, tokens, retries or
 * chunk sizes appear here — those are `http-transport.ts`'s business (JJAK-1074)
 * and they change nothing about what a transport means. `local-relay.ts`
 * implements this in-process and stays permanently as the test double, so every
 * convergence assertion keeps running in CI without Cloudflare.
 *
 * A TRANSPORT IS BOUND TO ONE DEVICE. `pull` takes no device argument because
 * the identity belongs to the connection, not the call — the same way the HTTP
 * transport will carry one machine's credentials. That is what lets `pull`
 * withhold the caller's own ops: replaying them would be wasted work at best,
 * and at worst re-resolves rows this device is already authoritative for.
 */

import type { Result } from "../result";
import type { SyncOp } from "../schemas";

/**
 * An op that has been given its place in the shared total order.
 *
 * `serverSeq` is assigned by the log, is strictly increasing, and is the only
 * ordering an applier may trust. A device's local `seq` is meaningless to
 * anyone else and never crosses the seam.
 */
export type RelayOp = SyncOp & { serverSeq: number };

/** What the log did with a push. */
export type PushAck = {
	/** Ops appended to the log. */
	accepted: number;
	/**
	 * Ops already present under the same `opId`. A retried push is a no-op, so
	 * a non-zero count is normal after an interrupted pass, not an error.
	 */
	duplicates: number;
	/** `serverSeq` of the log head after the push. */
	head: number;
};

/** One page of the log, oldest first. */
export type PullPage = {
	/** Ops to apply, ascending by `serverSeq`. Never the caller's own. */
	ops: RelayOp[];
	/**
	 * Highest `serverSeq` this page covers — the caller's next `sinceSeq`.
	 *
	 * Reported separately from `ops` because a page whose whole window belonged
	 * to the calling device yields no ops and still has to move the watermark;
	 * deriving it from the last op would stall the cursor forever on that page.
	 */
	throughSeq: number;
	/** More ops exist beyond `throughSeq`. */
	hasMore: boolean;
};

/**
 * Move ops to and from the shared ordered log.
 *
 * Both directions return `Result` and never throw: a transport is the one part
 * of sync that talks to something outside this process, so failure is ordinary
 * and must never take a planner write with it.
 */
export interface SyncTransport {
	/** Append ops to the log. Idempotent on `opId`. */
	push(ops: SyncOp[]): Promise<Result<PushAck>>;
	/** Read at most `limit` ops with `serverSeq > sinceSeq`. */
	pull(sinceSeq: number, limit: number): Promise<Result<PullPage>>;
}
