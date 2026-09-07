/**
 * Planner Configuration Schema
 *
 * Module configuration for ~/.jake/config.json
 */

import { z } from "zod";

/**
 * Multi-device replication settings.
 *
 * Named separately from `PlannerConfigSchema` so a surface can validate JUST
 * this block: parsing the whole module config would fail sync for an unrelated
 * bad key, and sync is the one subsystem that must degrade quietly.
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
	 * Push chunk ceiling in bytes. 256 KB sits comfortably inside every limit in
	 * the path — the DO's 2 MB bound-parameter cap is the tight one.
	 */
	batchBytes: z.number().positive().default(262144),
});
export type SyncConfig = z.infer<typeof SyncConfigSchema>;

/**
 * Planner module configuration
 */
export const PlannerConfigSchema = z.object({
	/** Global enable flag */
	enabled: z.boolean().default(false),

	/** Enable auto-apply for high-confidence proposals */
	enableAutoApply: z.boolean().default(false),

	/** Default daily focus list capacity */
	dailyFocusCapacity: z.number().positive().default(5),

	/** Default weekly focus list capacity */
	weeklyFocusCapacity: z.number().positive().default(15),

	/** GTD contexts to suggest */
	defaultContexts: z
		.array(z.string())
		.default([
			"@computer",
			"@phone",
			"@home",
			"@office",
			"@errands",
			"@waiting",
		]),

	/** Default areas (created on first run if not exist) */
	defaultAreas: z
		.array(
			z.object({
				id: z.string(),
				name: z.string(),
				icon: z.string().optional(),
			}),
		)
		.default([
			{ id: "work", name: "Work", icon: "💼" },
			{ id: "personal", name: "Personal", icon: "🏠" },
		]),

	/** Sync integrations configuration */
	integrations: z
		.object({
			linear: z
				.object({
					enabled: z.boolean().default(false),
					apiKey: z.string().optional(),
					defaultTeam: z.string().optional(),
					syncInterval: z.number().positive().default(300), // seconds
				})
				.default({}),

			github: z
				.object({
					enabled: z.boolean().default(false),
					repos: z.array(z.string()).default([]),
					syncLabels: z.array(z.string()).default(["todo", "task"]),
				})
				.default({}),
		})
		.default({}),

	/** Multi-device replication (jake plan sync) */
	sync: SyncConfigSchema.default({}),
});
export type PlannerConfig = z.infer<typeof PlannerConfigSchema>;

/**
 * Parse and validate planner config from module config
 */
export const parsePlannerConfig = (moduleConfig: unknown): PlannerConfig => {
	return PlannerConfigSchema.parse(moduleConfig ?? {});
};

/**
 * Get default config
 */
export const getDefaultPlannerConfig = (): PlannerConfig => {
	return PlannerConfigSchema.parse({});
};
