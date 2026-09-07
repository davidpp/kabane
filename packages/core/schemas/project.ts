/**
 * Project Schema
 *
 * Flat grouping layer between scopeUri and tasks.
 * Projects organize tasks within a scope (e.g. 'Auth Rewrite', 'Dashboard v2').
 */

import { z } from "zod";

// ============================================================
// Project States (GTD-inspired, simpler than task states)
// ============================================================

/**
 * Project lifecycle states.
 *
 * - active: Currently being worked on
 * - someday: Deferred / future
 * - done: Completed
 * - archived: No longer relevant
 */
export const ProjectStateSchema = z.enum([
	"active",
	"someday",
	"done",
	"archived",
]);
export type ProjectState = z.infer<typeof ProjectStateSchema>;

// ============================================================
// Project Schema
// ============================================================

/**
 * Full project record (stored in database)
 */
export const ProjectSchema = z.object({
	/** Unique identifier (ULID — internal, immutable) */
	id: z.string(),

	/** Human-friendly ID (e.g., JPRJ-1) */
	shortId: z.string().optional(),

	/** Project title */
	title: z.string().min(1).max(500),

	/** Optional description (Markdown) */
	description: z.string().optional(),

	/** Lifecycle state */
	state: ProjectStateSchema.default("active"),

	/** Scope URI — canonical, branch-agnostic */
	scopeUri: z.string().optional(),

	/** Creation timestamp */
	createdAt: z.string().datetime(),

	/** Last update timestamp */
	updatedAt: z.string().datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

/**
 * Draft for creating a new project (without id, timestamps)
 */
export const ProjectDraftSchema = ProjectSchema.omit({
	id: true,
	shortId: true,
	createdAt: true,
	updatedAt: true,
});
/** Input type for creating projects — fields with defaults are optional */
export type ProjectDraft = z.input<typeof ProjectDraftSchema>;

/**
 * Partial update for existing project
 */
export const ProjectUpdateSchema = ProjectDraftSchema.partial();
export type ProjectUpdate = z.infer<typeof ProjectUpdateSchema>;

/**
 * Query parameters for filtering projects
 */
export const ProjectQuerySchema = z.object({
	/** Filter by state */
	state: ProjectStateSchema.optional(),

	/** Filter by multiple states */
	states: z.array(ProjectStateSchema).optional(),

	/** Filter by scope URI (exact match) */
	scopeUri: z.string().optional(),

	/** Filter by scope URI pattern (SQL LIKE) */
	scopeUriPattern: z.string().optional(),

	/** Full-text search query */
	query: z.string().optional(),

	/** Include done/archived projects */
	includeClosed: z.boolean().default(false),

	/** Sort order */
	orderBy: z.enum(["createdAt", "updatedAt", "title"]).default("createdAt"),

	/** Sort direction */
	orderDir: z.enum(["asc", "desc"]).default("desc"),

	/** Maximum results */
	limit: z.number().positive().default(100),

	/** Offset for pagination */
	offset: z.number().nonnegative().default(0),
});
export type ProjectQuery = z.infer<typeof ProjectQuerySchema>;
