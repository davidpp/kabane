/**
 * Wire contracts.
 *
 * The server validates exactly what it uses — an idempotency key and an author
 * — and treats everything else as opaque bytes. That is the whole reason this
 * Worker can deploy once and never again while planner tables keep evolving:
 * it holds no planner schema, so `db-registration.ts` can grow columns without
 * a redeploy.
 *
 * Plain `zod`, not zui (JJAK-959): these compose with the planner-side schemas.
 */

import { z } from "zod";

/** Upper bound on ops per pull page. The real cap is the 2 MB response limit. */
export const MAX_PULL_LIMIT = 1000;

/**
 * One op as the server sees it.
 *
 * `.passthrough()` is load-bearing. Zod strips unknown keys by default, and here
 * the unknown keys ARE the payload — stripping them would silently drop every
 * planner column this build has never heard of, which inside a sync path is
 * silent data loss.
 */
const WireOpSchema = z
	.object({
		opId: z.string().min(1),
		deviceId: z.string().min(1),
	})
	.passthrough();
export type WireOp = z.infer<typeof WireOpSchema>;

/**
 * `deviceId` here is the caller, used for the `devices` row. Each op's own
 * `deviceId` is what gets stored per row and what `pull` withholds on — they
 * are usually the same and are allowed to differ, so a device could relay
 * another's ops without the log lying about who authored them.
 */
export const PushRequestSchema = z.object({
	deviceId: z.string().min(1),
	name: z.string().optional(),
	ops: z.array(WireOpSchema),
});
export type PushRequest = z.infer<typeof PushRequestSchema>;

export const PullRequestSchema = z.object({
	deviceId: z.string().min(1),
	sinceSeq: z.number().int().min(0),
	limit: z.number().int().positive().max(MAX_PULL_LIMIT),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

/** Mirrors `PushAck` in `packages/planner/sync/transport.ts`. */
export type PushAck = {
	accepted: number;
	duplicates: number;
	head: number;
};

/**
 * An op on its way back out, with its place in the total order.
 *
 * `payload` is the verbatim JSON text the device pushed — the server never
 * parses it, so it cannot merge `serverSeq` into it either. The transport
 * reconstitutes the `RelayOp` the applier wants:
 *
 * ```ts
 * { ...JSON.parse(op.payload), serverSeq: op.serverSeq }
 * ```
 */
type WirePullOp = {
	serverSeq: number;
	payload: string;
};

/** Mirrors `PullPage`, modulo the un-merged `payload` above. */
export type PullPage = {
	ops: WirePullOp[];
	throughSeq: number;
	hasMore: boolean;
};
