/**
 * Planner Sync — Device Wiring
 *
 * Turns the host's sync settings into a live transport, and
 * arms this machine for capture the first time it is asked to. One place, so the
 * CLI, the tRPC router and the Stop hook cannot disagree about what "sync is on"
 * means.
 *
 * ONLY THE SYNC BLOCK IS VALIDATED. Parsing the whole planner config would fail
 * sync because of an unrelated bad key somewhere else in it, and sync is the one
 * subsystem whose failure must never reach a planner write.
 *
 * ARMING IS A SIDE EFFECT OF THE FIRST SYNC, not a separate command. Capture is
 * armed by the presence of the `sync_state` row (see storage/oplog.ts), so a
 * device with config and no row has nothing to push and no way to get anything.
 * `Oplog.initDevice` is write-once, so doing it here is idempotent — a second
 * call with a different id is a no-op rather than a rename.
 */

import { hostname } from "node:os";
import { err, ok, type Result } from "../result";
import { Runtime, withDb } from "../runtime";

import type { SyncConfig } from "../schemas";
import { generateId } from "../storage/helpers";
import { Oplog } from "../storage/oplog";
import { HttpTransport, type HttpTransportConfig } from "./http-transport";
import type { SyncTransport } from "./transport";

// ============================================================
// Types
// ============================================================

export type ConnectedSync = {
	transport: SyncTransport;
	/** This machine's identity, as stored in `sync_state`. */
	deviceId: string;
	settings: SyncConfig;
};

/** Test seams, passed straight through to the transport. */
export type ConnectOpts = Pick<
	HttpTransportConfig,
	"fetchImpl" | "sleep" | "maxAttempts"
> & {
	/** Skip the config file. */
	settings?: SyncConfig;
};

// ============================================================
// SyncDevice Namespace
// ============================================================

export namespace SyncDevice {
	/**
	 * The sync settings the host configured, defaults filled in.
	 *
	 * Missing settings mean `enabled: false`, not an error: every surface calls
	 * this and most users never turn sync on.
	 */
	export const settings = (): Promise<Result<SyncConfig>> =>
		Runtime.syncSettings()();

	/**
	 * Ensure this device has an identity and capture is armed.
	 *
	 * @returns the identity actually in use, which is the existing one when the
	 * device was already armed — config cannot rename a device.
	 */
	export const arm = async (
		basePath: string,
		preferredId?: string,
	): Promise<Result<string>> => {
		const outer = await withDb(basePath, (db) => {
			const state = Oplog.getState(db);
			if (!state.ok) return state;
			if (state.value !== undefined) return ok(state.value.deviceId);

			const deviceId = preferredId ?? generateId();
			const armed = Oplog.initDevice(db, deviceId);
			return armed.ok ? ok(deviceId) : armed;
		});
		return outer.ok ? outer.value : outer;
	};

	/**
	 * A transport for this machine, or an error explaining what is missing.
	 *
	 * Disabled sync is an error here rather than a silent no-op: a caller reaching
	 * for a transport has already decided to sync, and the surfaces that must stay
	 * quiet (the Stop hook) check `settings().enabled` first.
	 */
	export const connect = async (
		basePath: string,
		opts: ConnectOpts = {},
	): Promise<Result<ConnectedSync>> => {
		const resolved = opts.settings
			? ok(opts.settings)
			: await SyncDevice.settings();
		if (!resolved.ok) return resolved;
		const config = resolved.value;

		if (!config.enabled) {
			return err(
				new Error("Sync is disabled. Enable it in the sync settings first."),
			);
		}
		if (!config.url || !config.token) {
			return err(
				new Error(
					"Sync needs url and token in the sync settings (the Worker URL and its SYNC_TOKEN).",
				),
			);
		}

		const deviceId = await SyncDevice.arm(basePath, config.deviceId);
		if (!deviceId.ok) return deviceId;

		return ok({
			deviceId: deviceId.value,
			settings: config,
			transport: HttpTransport.create(basePath, {
				url: config.url,
				token: config.token,
				deviceId: deviceId.value,
				name: hostname(),
				headers: config.headers,
				batchBytes: config.batchBytes,
				maxAttempts: opts.maxAttempts,
				fetchImpl: opts.fetchImpl,
				sleep: opts.sleep,
			}),
		});
	};
}
