/**
 * Session Defaults Schema
 *
 * Per-session (or per-scope) planner defaults that new tasks inherit —
 * e.g. a default project or parent task. Stored as a small JSON file keyed
 * by the resolved session/scope key (see storage/session-defaults.ts).
 */

import { z } from "zod";

export const SessionDefaultsSchema = z.object({
	/** Resolved defaults key (e.g. "session:abc123" or "scope:github.com/user/repo") */
	key: z.string().min(1),

	/** Default project id inherited by new tasks */
	projectId: z.string().optional(),

	/** Default parent task id inherited by new tasks */
	parentTaskId: z.string().optional(),

	/** ISO timestamp of last update */
	updatedAt: z.string(),
});

export type SessionDefaults = z.infer<typeof SessionDefaultsSchema>;
