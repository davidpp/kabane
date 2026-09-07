/**
 * The sync log, as a Durable Object.
 *
 * WHY A DURABLE OBJECT AND NOT D1. The one thing the planner needs from a server
 * is a genuine total order with idempotent append. DO SQLite gives that for
 * free: input/output gates serialize every request into this object, so
 * `server_seq AUTOINCREMENT` is a real sequence and two concurrent pushes cannot
 * interleave. A stateless D1 writer has no such serialization — it would need a
 * per-partition Durable Object queue in front of it to get the same guarantee,
 * which is a DO plus a second database. That serialization is the actual reason
 * this design chose Cloudflare.
 *
 * A CLASS, WHICH THE HOUSE STYLE FORBIDS — the platform requires extending
 * `DurableObject` to get `ctx`/`env` and RPC dispatch, so it is a framework
 * requirement, not a design choice. Everything with logic in it lives in the
 * namespace modules this class delegates to.
 */

import { DurableObject } from "cloudflare:workers";
import { type Result, trySync } from "@cabane/core";
import { Migrations } from "./migrations";
import { Oplog } from "./oplog";
import type { PullPage, PullRequest, PushAck, PushRequest } from "./wire";

export class CabaneLog extends DurableObject<Cloudflare.Env> {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);

		// Constructor ONLY. Per request this would serialize everything behind a
		// full concurrency block; here it just means the first caller waits for the
		// schema. `Migrations.apply` is synchronous, hence the resolved promise.
		ctx.blockConcurrencyWhile(() => {
			Migrations.apply(ctx.storage.sql);
			return Promise.resolve();
		});
	}

	/**
	 * Append ops and report what stuck.
	 *
	 * `trySync` wraps `transactionSync` rather than sitting inside it: a throw is
	 * what rolls the batch back, so it has to escape the closure before being
	 * turned into an `err`.
	 */
	push(req: PushRequest): Result<PushAck> {
		return trySync(() =>
			this.ctx.storage.transactionSync(() =>
				Oplog.append(this.ctx.storage.sql, req),
			),
		);
	}

	/** Read one page of the log, withholding `req.deviceId`'s own ops. */
	pull(req: PullRequest): Result<PullPage> {
		return trySync(() =>
			this.ctx.storage.transactionSync(() =>
				Oplog.read(this.ctx.storage.sql, req),
			),
		);
	}
}
