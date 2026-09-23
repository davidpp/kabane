/**
 * Task Schema
 *
 * Core task entity with GTD-inspired states and provenance tracking.
 */

import { z } from "zod";
import { DeadlineSchema } from "./deadline";

// ============================================================
// Verification Schema
// ============================================================

/**
 * Verification status for task completion
 */
export const VerificationStatusSchema = z.enum([
	"pending", // Not yet verified
	"passed", // Verification passed
	"failed", // Verification failed
	"skipped", // Verification skipped (human-owned tasks)
]);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

/**
 * Verification method used
 */
export const VerificationMethodSchema = z.enum([
	"manual", // Human verified
	"evidence", // Evidence-based (files, commits exist)
	"test", // Tests passed
	"ai", // AI verified criteria met
]);
export type VerificationMethod = z.infer<typeof VerificationMethodSchema>;

/**
 * Verification record for task completion
 */
export const VerificationSchema = z.object({
	/** Current verification status */
	status: VerificationStatusSchema.default("pending"),

	/** How verification was done */
	method: VerificationMethodSchema.optional(),

	/** When verified */
	verifiedAt: z.string().datetime().optional(),

	/** Who/what verified */
	verifiedBy: z.string().optional(),

	/** Notes about verification */
	notes: z.string().optional(),
});
export type Verification = z.infer<typeof VerificationSchema>;

// ============================================================
// Task States & Priority
// ============================================================

/**
 * Task states following GTD methodology
 *
 * Flow: inbox → (next|waiting|someday) → in_progress → (done|cancelled)
 */
export const TaskStateSchema = z.enum([
	"inbox", // Unprocessed - needs triage
	"next", // Ready to do (GTD "Next Actions")
	"in_progress", // Currently being worked on
	"waiting", // Blocked on external input
	"someday", // Deferred - maybe later (GTD "Someday/Maybe")
	"done", // Completed
	"cancelled", // Abandoned
]);
export type TaskState = z.infer<typeof TaskStateSchema>;

/**
 * Priority levels (Eisenhower-inspired)
 */
export const TaskPrioritySchema = z.enum([
	"urgent", // Urgent + Important (do first)
	"high", // Important, not urgent (schedule)
	"normal", // Default
	"low", // Nice to have
]);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

/**
 * Task source provenance - where the task originated
 */
export const TaskSourceSchema = z.enum([
	"human", // Manually created by user
	"ai", // Created by AI (requires proposal approval if low confidence)
	"linear", // Synced from Linear
	"github", // From GitHub issue/PR
	"email", // Extracted from email
	"calendar", // From calendar event
	"meeting", // From meeting transcription
	"session", // Extracted from Claude session
	"prd", // Generated from PRD implementation plan
	"intelligence", // Created from intelligence item
	"other", // Other source
]);
export type TaskSource = z.infer<typeof TaskSourceSchema>;

/**
 * Item kind - discriminates between personal tasks and agent issues
 *
 * Both use same states but with different mental models:
 * - 'task': Personal GTD workflow (inbox → next → done)
 * - 'issue': Agent/dev workflow (backlog → in_progress → review → done)
 */
export const ItemKindSchema = z.enum([
	"task", // Personal GTD task (focus management, energy levels)
	"issue", // Agent work item (evidence, verification, review)
]);
export type ItemKind = z.infer<typeof ItemKindSchema>;

/**
 * Provenance tracking - full origin information
 */
export const ProvenanceSchema = z.object({
	/** Where the task originated */
	source: TaskSourceSchema,

	/** External system ID (e.g., Linear issue ID, GitHub issue number) */
	sourceId: z.string().optional(),

	/** URL to source (e.g., GitHub issue URL) */
	sourceUrl: z.string().url().optional(),

	/** When the task was discovered/created */
	discoveredAt: z.string().datetime(),

	/** Which workflow/agent discovered this task */
	discoveredBy: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * Full task record (stored in database)
 */
export const TaskSchema = z.object({
	/** Unique identifier (ULID - internal, immutable) */
	id: z.string(),

	/** Human-friendly ID (e.g., JAK-123, ACME-45 - Linear-style) */
	shortId: z.string().optional(),

	/** Task title (action-oriented, starts with verb) */
	title: z.string().min(1).max(500),

	/** Detailed description/notes (Markdown) */
	description: z.string().optional(),

	/** Item kind - 'task' (personal GTD) or 'issue' (agent work) */
	kind: ItemKindSchema.default("task"),

	/** Current state in GTD workflow */
	state: TaskStateSchema.default("inbox"),

	/** Priority level */
	priority: TaskPrioritySchema.default("normal"),

	// --- Scoping (ADR-010) ---

	/**
	 * Primary scope URI (e.g., "jake://scope/github.com/user/repo?client=acme")
	 * Uses Core Scope system for stable identity across machines/renames.
	 */
	scopeUri: z.string().optional(),

	/**
	 * Additional scope references for multi-scope tasks.
	 * Primary scope is in `scopeUri`, related scopes here.
	 */
	scopeRefs: z
		.array(
			z.object({
				scopeUri: z.string(),
				role: z.enum(["related", "blocked_by"]),
			}),
		)
		.optional(),

	// --- Time ---

	/** Due date: a calendar date or an instant, read in the owner's zone (deadline.ts) */
	deadline: DeadlineSchema.optional(),

	/** Defer until date (hide until this date) */
	deferUntil: z.string().datetime().optional(),

	/** Completion timestamp */
	completedAt: z.string().datetime().optional(),

	// --- Provenance ---

	/** Origin information */
	provenance: ProvenanceSchema,

	/** AI confidence score (0-1) for AI-created/updated tasks */
	confidence: z.number().min(0).max(1).optional(),

	// --- Ownership ---

	/** Who is responsible for completing this task (freeform: agent name, "me", email) */
	assignee: z.string().optional(),

	// --- Subtasks ---

	/** Parent task ID (for subtasks - one level deep); null detaches from the parent */
	parentTaskId: z.string().nullable().optional(),

	// --- Project ---

	/** Project ID (flat grouping layer between scope and tasks); null clears the association */
	projectId: z.string().nullable().optional(),

	// --- Review (for agent-owned tasks) ---

	/** Whether task needs human review before completion */
	needsReview: z.boolean().default(false),

	/** When the task was reviewed */
	reviewedAt: z.string().datetime().optional(),

	/** Who reviewed the task */
	reviewedBy: z.string().optional(),

	// --- Verification (primarily for agent-owned tasks) ---

	/** Verification status for task completion */
	verification: VerificationSchema.optional(),

	// --- Context ---

	/** Tags for filtering (e.g., ["@home", "@phone", "@computer"]) */
	tags: z.array(z.string()).default([]),

	/** GTD context (physical context like @home, @office) */
	context: z.string().optional(),

	// --- Replication ---

	/**
	 * Actor URI of the last local writer (cabane://actor/...). Storage always
	 * sets it; absent only on rows written before the column existed.
	 */
	updatedBy: z.string().optional(),

	/**
	 * Monotonic per-row version, bumped on every local write; the sync
	 * resolver compares it. Storage always fills it, so it is present on every
	 * task read back; optional here so callers never author it.
	 */
	version: z.number().int().min(1).optional(),

	// --- Metadata ---

	/** Creation timestamp */
	createdAt: z.string().datetime(),

	/** Last update timestamp */
	updatedAt: z.string().datetime(),
});
export type Task = z.infer<typeof TaskSchema>;

/**
 * Draft for creating a new task (without id, timestamps)
 */
export const TaskDraftSchema = TaskSchema.omit({
	id: true,
	shortId: true, // Auto-generated
	createdAt: true,
	updatedAt: true,
	completedAt: true,
	updatedBy: true, // Storage-owned
	version: true, // Storage-owned
}).extend({
	// Make provenance optional for drafts - will be filled with defaults
	provenance: ProvenanceSchema.optional(),
});
/** Input type for creating tasks - fields with defaults are optional */
export type TaskDraft = z.input<typeof TaskDraftSchema>;

/**
 * Partial update for existing task
 */
export const TaskUpdateSchema = TaskDraftSchema.partial();
export type TaskUpdate = z.infer<typeof TaskUpdateSchema>;

/**
 * Query parameters for filtering tasks
 */
export const TaskQuerySchema = z.object({
	/** Filter by states (multiple allowed) */
	states: z.array(TaskStateSchema).optional(),

	/** Filter by single state */
	state: TaskStateSchema.optional(),

	/** Filter by item kind ('task' for personal GTD, 'issue' for agent work) */
	kind: ItemKindSchema.optional(),

	/** Filter by priority */
	priority: TaskPrioritySchema.optional(),

	/** Filter by scope URI (exact match) */
	scopeUri: z.string().optional(),

	/** Filter by scope URI pattern (SQL LIKE, e.g., "jake://scope/github.com/user/%") */
	scopeUriPattern: z.string().optional(),

	/** Filter by source */
	source: TaskSourceSchema.optional(),

	/** Filter by source ID (provenance.sourceId) */
	sourceId: z.string().optional(),

	/** Filter by tag */
	tag: z.string().optional(),

	/** Filter by context */
	context: z.string().optional(),

	/** Filter by assignee */
	assignee: z.string().optional(),

	/** Filter by parent task (for subtasks) */
	parentTaskId: z.string().optional(),

	/** Filter for top-level tasks only (no parent) */
	topLevelOnly: z.boolean().optional(),

	/** Filter by project ID */
	projectId: z.string().optional(),

	/** Filter tasks needing review */
	needsReview: z.boolean().optional(),

	/** Due at or before this: a date includes its whole day (deadline.ts) */
	dueBefore: DeadlineSchema.optional(),

	/** Due at or after this: a date from its first instant (deadline.ts) */
	dueAfter: DeadlineSchema.optional(),

	/** Full-text search query */
	query: z.string().optional(),

	/** Include deferred tasks (deferUntil > today) */
	includeDeferred: z.boolean().default(false),

	/** Include done/cancelled tasks */
	includeClosed: z.boolean().default(false),

	/** Sort order */
	orderBy: z
		.enum(["createdAt", "updatedAt", "deadline", "priority"])
		.default("createdAt"),

	/** Sort direction */
	orderDir: z.enum(["asc", "desc"]).default("desc"),

	/** Maximum results */
	limit: z.number().positive().default(100),

	/** Offset for pagination */
	offset: z.number().nonnegative().default(0),
});
export type TaskQuery = z.infer<typeof TaskQuerySchema>;
