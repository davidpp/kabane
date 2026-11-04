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
	enabled: z
		.boolean()
		.default(false)
		.describe("Master sync switch; off means no surface opens a connection."),
	url: z.string().optional().describe("Sync Worker's base URL."),
	token: z
		.string()
		.optional()
		.describe("Bearer secret matching the Worker's SYNC_TOKEN."),
	deviceId: z
		.string()
		.optional()
		.describe("Device identity for first arming only (read-only, write-once)."),
	headers: z
		.record(z.string())
		.optional()
		.describe(
			"Extra push/pull headers, including Cloudflare Access service-token credentials.",
		),
	// 256 KB fits below the DO's 2 MB bound-parameter cap.
	batchBytes: z
		.number()
		.finite()
		.positive()
		.default(262144)
		.describe("Push chunk ceiling in bytes; defaults to 262144."),
});
export type SyncConfig = z.infer<typeof SyncConfigSchema>;
