/**
 * The hub's `SyncTransport`: `CabaneLog` reached through its Durable Object
 * stub, not over HTTP.
 *
 * Same wire as `http-transport.ts` minus the network: the log hands back
 * `{ serverSeq, payload }` with `payload` the verbatim JSON text a device
 * pushed, and this file reconstitutes the `RelayOp` the applier wants. The
 * `.passthrough()` parse is load-bearing for the same reason as on the device:
 * an unknown key is a column a newer device sent, and plain zod would strip it.
 *
 * No retry, no chunking, no quarantine here. A DO-to-DO call either returns or
 * throws, and the hub's ops are small; the device transport keeps the
 * survival machinery because it crosses a real network.
 */

import {
	err,
	ok,
	type PullPage,
	type PushAck,
	type RelayOp,
	type Result,
	type SyncOp,
	SyncOpSchema,
	type SyncTransport,
	tryCatch,
} from "@cabane/core";
import type { CabaneLog } from "./log";
import { MAX_PULL_LIMIT, type PullPage as WirePullPage } from "./wire";

const PulledOpSchema = SyncOpSchema.passthrough();

const reconstitute = (wire: {
	serverSeq: number;
	payload: string;
}): Result<RelayOp> => {
	const decoded = tryCatchSync(() => JSON.parse(wire.payload) as unknown);
	if (!decoded.ok) return decoded;
	const parsed = PulledOpSchema.safeParse(decoded.value);
	if (!parsed.success) {
		return err(
			new Error(
				`log returned an unreadable op at seq ${wire.serverSeq}: ${parsed.error.message}`,
			),
		);
	}
	return ok({ ...(parsed.data as SyncOp), serverSeq: wire.serverSeq });
};

const tryCatchSync = <T>(fn: () => T): Result<T> => {
	try {
		return ok(fn());
	} catch (e) {
		return err(e instanceof Error ? e : new Error(String(e)));
	}
};

export namespace LogTransport {
	export const create = (
		log: DurableObjectStub<CabaneLog>,
		deviceId: string,
		name: string,
	): SyncTransport => ({
		push: async (ops: SyncOp[]): Promise<Result<PushAck>> => {
			// The stub's return type is the RPC-wrapped union; naming the plain
			// `Result` here is what lets the two layers of Result flatten.
			const acked = await tryCatch(
				async (): Promise<Result<PushAck>> =>
					await log.push({ deviceId, name, ops }),
			);
			if (!acked.ok) return acked;
			return acked.value;
		},

		pull: async (
			sinceSeq: number,
			limit: number,
		): Promise<Result<PullPage>> => {
			const page = await tryCatch(
				async (): Promise<Result<WirePullPage>> =>
					await log.pull({
						deviceId,
						sinceSeq,
						limit: Math.min(limit, MAX_PULL_LIMIT),
					}),
			);
			if (!page.ok) return page;
			if (!page.value.ok) return page.value;

			const ops: RelayOp[] = [];
			for (const wire of page.value.value.ops) {
				const op = reconstitute(wire);
				if (!op.ok) return op;
				ops.push(op.value);
			}
			return ok({
				ops,
				throughSeq: page.value.value.throughSeq,
				hasMore: page.value.value.hasMore,
			});
		},
	});
}
