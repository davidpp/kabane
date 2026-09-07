/**
 * The cloud device: the Cabane core running on this object's SQLite.
 *
 * This slice is storage only. The constructor wires the core runtime to the
 * object's storage through the Db port and boots the schema, so the object
 * holds a complete, queryable planner database. The MCP surface, Access
 * verification and the sync loop against `CabaneLog` arrive with JCAB-7.
 *
 * `Runtime.configure` is a module-level singleton in the core. One isolate
 * hosts one hub, and `CabaneHub` is the only class that configures it, so the
 * singleton is the right shape here rather than a limitation.
 *
 * A class, which the house style forbids: the platform requires extending
 * `DurableObject` for `ctx`/`env` and RPC dispatch.
 */

import { DurableObject } from "cloudflare:workers";
import { Planner, type Result, Runtime, TABLES } from "@cabane/core";
import { DoDb } from "./db-do";

/** The `basePath` the core is handed. Opaque to the DO adapter. */
export const HUB_BASE = "hub";

export class CabaneHub extends DurableObject<Cloudflare.Env> {
	private readonly booted: Promise<Result<void>>;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		Runtime.configure({ provider: DoDb.provider(ctx.storage) });
		// Constructor only: the first caller waits for the schema, later ones
		// do not pay for it.
		this.booted = new Promise<Result<void>>((resolve) => {
			ctx.blockConcurrencyWhile(async () => {
				resolve(await Planner.init(HUB_BASE));
			});
		});
	}

	ping(): "hub" {
		return "hub";
	}

	/** Whether the core schema is in place. */
	boot(): Promise<Result<void>> {
		return this.booted;
	}

	/** Physical table names the core created here. */
	tables(): string[] {
		return this.ctx.storage.sql
			.exec<{ name: string }>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
			)
			.toArray()
			.map((r) => r.name);
	}

	/** Row count of the tasks table, the cheapest proof the core is live. */
	taskCount(): number {
		return this.ctx.storage.sql
			.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLES.tasks}`)
			.one().n;
	}
}
