/**
 * Proposal Schema
 *
 * LEGACY, dying in JJAK-982. The confidence-gated auto-apply / human-review
 * proposal flow has been retired (JJAK-980) — evidence, the activity surface,
 * and the approval flow are gone. What remains is the `ask_question` legacy
 * shape plus the task-less `jake plan ask` fallback path; both are un-exposed
 * to MCP and slated for removal.
 */

import { z } from "zod";

/**
 * Proposal action types
 *
 * Only `ask_question` remains: the approval-flow actions were retired (S7).
 * Historical rows may still carry legacy action strings in the kept
 * `planner_proposals` table until the physical drop (JJAK-982); read paths
 * cast rather than validate, so legacy values render defensively.
 */
export const ProposalActionSchema = z.enum([
	"ask_question", // Ask human a question and wait for answer
]);
export type ProposalAction = z.infer<typeof ProposalActionSchema>;

/**
 * Proposal status
 */
export const ProposalStatusSchema = z.enum([
	"pending", // Awaiting human review
	"approved", // Approved and applied
	"rejected", // Rejected by human
	"expired", // Auto-expired (not reviewed in time)
	"superseded", // Replaced by newer proposal
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

/**
 * Payload for ask_question action
 *
 * Used by recipes/agents to pause execution and ask humans a question.
 * The answer is stored in reviewNotes when approved.
 */
export const AskQuestionPayloadSchema = z.object({
	action: z.literal("ask_question"),
	/** The question text to display */
	question: z.string(),
	/** Optional predefined choices (renders as buttons) */
	choices: z.array(z.string()).optional(),
	/** Allow freeform text input (default: true) */
	allowFreeform: z.boolean().default(true),
	/** Allow selecting multiple choices (default: false = single-select instant submit) */
	multiSelect: z.boolean().default(false),
	/** Question index for multi-question flows ("Question 1 of 3") */
	questionIndex: z.number().optional(),
	/** Total questions for progress indicator */
	totalQuestions: z.number().optional(),
	/** Context about why this question is being asked */
	questionContext: z.string().optional(),
	/** Group ID for batch questions — proposals with the same groupId form a batch */
	groupId: z.string().optional(),
	/** Default answer to use when "Apply all defaults" is selected */
	defaultAnswer: z.string().optional(),
});

/**
 * Combined payload schema
 *
 * Only ask_question survives the S7 retirement; the discriminated union
 * collapsed to a single member.
 */
export const ProposalPayloadSchema = AskQuestionPayloadSchema;
export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>;
/** Input type for proposal payloads - nested schemas accept input types */
export type ProposalPayloadInput = z.input<typeof ProposalPayloadSchema>;

/**
 * Proposal record (stored in database)
 */
export const ProposalSchema = z.object({
	/** Unique identifier (ULID) */
	id: z.string(),

	/** Action type */
	action: ProposalActionSchema,

	/** Current status */
	status: ProposalStatusSchema.default("pending"),

	/** AI confidence in this proposal (0-1) */
	confidence: z.number().min(0).max(1),

	/** Human-readable summary of the proposal */
	summary: z.string(),

	/** Detailed reasoning (why AI suggested this) */
	reasoning: z.string().optional(),

	/** The payload containing the actual changes (JSON) */
	payload: ProposalPayloadSchema,

	/** Session ID that generated this proposal */
	sessionId: z.string().optional(),

	/** Task/issue ID this proposal belongs to (for inline display) */
	taskId: z.string().optional(),

	/** Context that prompted this proposal */
	context: z.string().optional(),

	/** Expiration time (proposals expire if not reviewed) */
	expiresAt: z.string().datetime().optional(),

	/** Review decision timestamp */
	reviewedAt: z.string().datetime().optional(),

	/** Review notes from human */
	reviewNotes: z.string().optional(),

	/** Creation timestamp */
	createdAt: z.string().datetime(),

	/** Last update timestamp */
	updatedAt: z.string().datetime(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

/**
 * Draft for creating a proposal
 */
export const ProposalDraftSchema = ProposalSchema.omit({
	id: true,
	status: true,
	reviewedAt: true,
	reviewNotes: true,
	createdAt: true,
	updatedAt: true,
});
/** Input type for creating proposals - accepts draft types for nested schemas */
export type ProposalDraft = z.input<typeof ProposalDraftSchema>;

/**
 * Query parameters for proposals
 */
export const ProposalQuerySchema = z.object({
	/** Filter by status */
	status: ProposalStatusSchema.optional(),

	/** Filter by action type */
	action: ProposalActionSchema.optional(),

	/** Minimum confidence threshold */
	minConfidence: z.number().min(0).max(1).optional(),

	/** Include expired */
	includeExpired: z.boolean().default(false),

	/** Filter by task ID (for issue-scoped queries) */
	taskId: z.string().optional(),

	/** Maximum results */
	limit: z.number().positive().default(50),

	/** Offset for pagination */
	offset: z.number().nonnegative().default(0),
});
export type ProposalQuery = z.infer<typeof ProposalQuerySchema>;
