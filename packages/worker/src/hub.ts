/**
 * The cloud device: the Cabane core running on this object's SQLite, serving
 * MCP, and syncing with `CabaneLog` like any other device.
 *
 * WHAT MAKES IT A DEVICE. On boot it arms capture under the identity `cloud`
 * (`SyncDevice.arm`), so every MCP write lands in its oplog. After each write
 * it pushes (`waitUntil`, off the response path); on an alarm every
 * `SYNC_INTERVAL_MINUTES` it pulls, applies, and pushes. The log is reached
 * through its stub, never HTTP.
 *
 * WHO IS WRITING. The edge verifies Access and forwards the actor URI in
 * `X-Cabane-Actor`. The runtime's actor port reads it from an
 * `AsyncLocalStorage` so concurrent requests inside one object cannot see each
 * other's identity; a plain field would leak across an `await`.
 *
 * `Runtime.configure` is a module-level singleton in the core. One isolate
 * hosts one hub (`HUB_NAME`), and `CabaneHub` is the only class that configures
 * it, so the singleton is the right shape here rather than a limitation.
 *
 * A class, which the house style forbids: the platform requires extending
 * `DurableObject` for `ctx`/`env`, RPC dispatch, and `alarm()`.
 */

import { DurableObject } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import {
	ANONYMOUS_ACTOR,
	Deadline,
	err,
	handleHttpRequest,
	ok,
	Planner,
	type PullResult,
	type PushResult,
	type Result,
	Runtime,
	Sync,
	SyncDevice,
	TABLES,
	type ToolContext,
} from "@cabane/core";
import { DoDb } from "./db-do";
import { LogTransport } from "./log-transport";
import { ACTOR_HEADER, HUB_DEVICE_ID, SHARED_LOG } from "./names";

/** The `basePath` the core is handed. Opaque to the DO adapter. */
export const HUB_BASE = "hub";

const DEFAULT_INTERVAL_MINUTES = 5;

const actorStore = new AsyncLocalStorage<string>();

const intervalMs = (raw: string | undefined): number => {
	const minutes = Number(raw);
	return (minutes > 0 ? minutes : DEFAULT_INTERVAL_MINUTES) * 60_000;
};

export type SyncPass = { pull: Result<PullResult>; push: Result<PushResult> };

/**
 * The owner's timezone for the hub: `CABANE_TIMEZONE` (an IANA name), or UTC
 * when it is unset. It decides which day is today and when a date deadline's
 * day ends for every MCP client the hub serves (schemas/deadline.ts). A zone
 * the runtime does not know is an error rather than a silent UTC.
 */
export const hubTimezone = (raw: string | undefined): Result<string> => {
	const zone = raw?.trim() ?? "";
	if (zone === "") return ok("UTC");
	return Deadline.isValidZone(zone)
		? ok(zone)
		: err(
				new Error(
					`CABANE_TIMEZONE "${zone}" is not a timezone this runtime knows (use an IANA name such as America/Montreal)`,
				),
			);
};

export class CabaneHub extends DurableObject<Cloudflare.Env> {
	private readonly booted: Promise<Result<void>>;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		const zone = hubTimezone(env.CABANE_TIMEZONE);
		Runtime.configure({
			provider: DoDb.provider(ctx.storage),
			actor: () => actorStore.getStore() ?? ANONYMOUS_ACTOR,
			timezone: () => (zone.ok ? zone.value : "UTC"),
		});
		// Constructor only: the first caller waits for the schema and the device
		// identity, later ones do not pay for it.
		this.booted = new Promise<Result<void>>((resolve) => {
			ctx.blockConcurrencyWhile(async () => {
				if (!zone.ok) return resolve(zone);
				const initialized = await Planner.init(HUB_BASE);
				if (!initialized.ok) return resolve(initialized);
				const armed = await SyncDevice.arm(HUB_BASE, HUB_DEVICE_ID);
				if (!armed.ok) return resolve(armed);
				await this.ensureAlarm();
				resolve(initialized);
			});
		});
	}

	// ----------------------------------------------------------
	// MCP
	// ----------------------------------------------------------

	/** POST /mcp, forwarded by the edge with the actor already resolved. */
	async fetch(request: Request): Promise<Response> {
		const booted = await this.booted;
		if (!booted.ok) {
			return Response.json({ error: booted.error.message }, { status: 500 });
		}
		if (request.method !== "POST") {
			return Response.json({ error: "method not allowed" }, { status: 405 });
		}
		const actor = request.headers.get(ACTOR_HEADER) ?? ANONYMOUS_ACTOR;
		const toolCtx: ToolContext = {
			basePath: HUB_BASE,
			actor,
			scopeRequired: true,
		};
		return actorStore.run(actor, () =>
			handleHttpRequest(toolCtx, request, { name: "cabane-hub" }, () =>
				this.ctx.waitUntil(this.push()),
			),
		);
	}

	// ----------------------------------------------------------
	// Sync
	// ----------------------------------------------------------

	private transport() {
		return LogTransport.create(
			this.env.CABANE_LOG.getByName(SHARED_LOG),
			HUB_DEVICE_ID,
			"cabane hub",
		);
	}

	private async push(): Promise<Result<PushResult>> {
		const pushed = await Sync.push(HUB_BASE, this.transport());
		if (!pushed.ok) console.error("hub push failed", pushed.error.message);
		return pushed;
	}

	private async pull(): Promise<Result<PullResult>> {
		const pulled = await Sync.pull(HUB_BASE, this.transport());
		if (!pulled.ok) console.error("hub pull failed", pulled.error.message);
		return pulled;
	}

	private async ensureAlarm(): Promise<void> {
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(
				Date.now() + intervalMs(this.env.SYNC_INTERVAL_MINUTES),
			);
		}
	}

	/**
	 * The scheduled pass. Never throws: a throw would make the platform retry
	 * the alarm with backoff, and a transient log failure should simply wait
	 * for the next interval.
	 */
	async alarm(): Promise<void> {
		await this.booted;
		await this.syncNow();
		await this.ctx.storage.setAlarm(
			Date.now() + intervalMs(this.env.SYNC_INTERVAL_MINUTES),
		);
	}

	/** One pull-then-push pass, on demand (tests, operations). */
	async syncNow(): Promise<SyncPass> {
		await this.booted;
		const pull = await this.pull();
		const push = await this.push();
		return { pull, push };
	}

	// ----------------------------------------------------------
	// Introspection (tests and health)
	// ----------------------------------------------------------

	ping(): "hub" {
		return "hub";
	}

	/** Whether the core schema is in place and the device is armed. */
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

	/** When the next scheduled pass fires, or null when none is set. */
	nextAlarm(): Promise<number | null> {
		return this.ctx.storage.getAlarm();
	}
}
