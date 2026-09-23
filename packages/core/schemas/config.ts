/**
 * Sync configuration schema: the `sync` block of a device's config.
 */

import { z } from "zod";

/**
 * Multi-device replication settings.
 *
 * A schema of its own so a host can validate JUST this block inside its larger
 * config: parsing the whole file would fail sync for an unrelated bad key, and
 * sync is the one subsystem that must degrade quietly.
 *
 * `deviceId` seeds `Oplog.initDevice` on first use and is ignored afterwards —
 * device identity is write-once in `sync_state`, because changing it would make
 * the remote treat this machine as new and hand back its own ops.
 */
export const SyncConfigSchema = z.object({
	/** Master switch. Off means no surface ever opens a connection. */
	enabled: z.boolean().default(false),

	/** Worker base URL, e.g. https://planner-sync.<subdomain>.workers.dev */
	url: z.string().optional(),

	/** Bearer secret. Matches the Worker's SYNC_TOKEN. */
	token: z.string().optional(),

	/** Device identity for the first arming only (see above). */
	deviceId: z.string().optional(),

	/**
	 * Extra request headers sent with every push and pull. This is how a device
	 * passes the edge in front of the hub: Cloudflare Access service-token
	 * credentials (`CF-Access-Client-Id` / `CF-Access-Client-Secret`) travel
	 * here, separate from the log's own bearer `token`.
	 */
	headers: z.record(z.string()).optional(),

	/**
	 * Push chunk ceiling in bytes. 256 KB sits comfortably inside every limit in
	 * the path — the DO's 2 MB bound-parameter cap is the tight one.
	 */
	batchBytes: z.number().positive().default(262144),
});
export type SyncConfig = z.infer<typeof SyncConfigSchema>;
