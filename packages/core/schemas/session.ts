/**
 * Agent Session Schemas (S4a)
 *
 * The container for agent work: a session with a lifecycle + typed activities,
 * so agent output stops being prose bolted onto issues. Modeled on Linear's
 * AgentSession, single-user-simplified.
 *
 * `state` and `type` stay soft strings (house style) with well-known-value
 * consts as suggestions — producers can introduce new values without a schema
 * change; consumers fall back gracefully (see display.ts).
 *
 * CONTEXT: an activity carries ONE context field (`context`) — the dogfood
 * requirement. `question` and `decision` activities are expected to make that
 * field self-contained (the question + its trade-off; the decision + its why),
 * paired with refs, so an answerer needs nothing else.
 */

// plain zod (not zui): must compose into the router's plain-zod
// discriminatedUnion — see JJAK-959 quality ruling.
import { z } from "zod";

// ============================================================
// Session state (soft string + well-known values)
// ============================================================

/**
 * Well-known session states. NOT enforced — `state` stays a plain string.
 * State machine (driven by storage/sessions.ts):
 *   start → active (or pending for a pre-dispatch batch)
 *   question activity → awaiting_input
 *   any non-question activity on an awaiting_input session → active
 *   endSession(complete|error) → complete | error
 *   idle > SESSION_STALE_MS → stale (via sweepStaleSessions)
 */
export const SESSION_STATES = [
	"pending",
	"active",
	"awaiting_input",
	"complete",
	"error",
	"stale",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** Soft string — see SESSION_STATES for well-known values. */
export const SessionStateSchema = z.string().min(1);

// ============================================================
// Activity type + severity (soft strings + well-known values)
// ============================================================

/**
 * Well-known activity types. NOT enforced — `type` stays a plain string.
 * `question` drives a session to awaiting_input; any other type on an
 * awaiting_input session flips it back to active (the answer).
 */
export const ACTIVITY_TYPES = [
	"progress",
	"action",
	"finding",
	"verification",
	"decision",
	"handoff",
	"response",
	"error",
	"question",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** Soft string — see ACTIVITY_TYPES for well-known values. */
export const ActivityTypeSchema = z.string().min(1);

/** Well-known severities for finding/verification activities. */
export const ACTIVITY_SEVERITIES = ["P1", "P2", "P3"] as const;
export type ActivitySeverity = (typeof ACTIVITY_SEVERITIES)[number];

/** Soft string — see ACTIVITY_SEVERITIES for well-known values. */
export const ActivitySeveritySchema = z.string().min(1);

// ============================================================
// Agent Session
// ============================================================

/** Full agent session record (stored in database). */
export const AgentSessionSchema = z.object({
	/** Unique identifier (ULID) */
	id: z.string(),

	/** Task (subtask) this session is keyed to */
	taskId: z.string(),

	/** Agent identifier (freeform: agent name, model, wave id) */
	agent: z.string(),

	/** Lifecycle state (soft string; see SESSION_STATES) */
	state: SessionStateSchema,

	/** Cross-reference: loop state file / Claude session id / wave id */
	externalRef: z.string().optional(),

	/** Final-response excerpt (the S5 card reads this) */
	summary: z.string().optional(),

	/** When the session started (ISO timestamp) */
	startedAt: z.string(),

	/** Bumped on EVERY activity/transition — drives staleness (ISO timestamp) */
	lastActivityAt: z.string(),

	/** When the session ended (ISO timestamp), if closed */
	endedAt: z.string().optional(),
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

/**
 * Input for starting a session (id/startedAt/lastActivityAt assigned by
 * storage; endedAt/summary set at end).
 */
export const AgentSessionDraftSchema = AgentSessionSchema.omit({
	id: true,
	startedAt: true,
	lastActivityAt: true,
	endedAt: true,
	summary: true,
}).extend({
	/** Defaults to "active" (use "pending" for a pre-dispatch batch). */
	state: SessionStateSchema.default("active"),
});
export type AgentSessionDraft = z.input<typeof AgentSessionDraftSchema>;

// ============================================================
// Agent Activity
// ============================================================

/** Full agent activity record (stored in database). */
export const AgentActivitySchema = z.object({
	/** Unique identifier (ULID) */
	id: z.string(),

	/** Session this activity belongs to */
	sessionId: z.string(),

	/** Activity type (soft string; see ACTIVITY_TYPES) */
	type: ActivityTypeSchema,

	/**
	 * Ephemeral rows (e.g. a spinner that overwrites itself) — only the latest
	 * ephemeral survives the query-time fold, and all-but-latest are compacted
	 * away when the session closes.
	 */
	ephemeral: z.boolean().default(false),

	/** Severity for finding/verification activities (soft string; P1|P2|P3) */
	severity: ActivitySeveritySchema.optional(),

	/** Free categorization (e.g. "security", "perf") */
	category: z.string().optional(),

	/**
	 * THE one context field. For question/decision activities this is expected
	 * to be self-contained (question + trade-off; decision + why).
	 */
	context: z.string().optional(),

	/** Activity body (the message) */
	body: z.string(),

	/** When the activity was recorded (ISO timestamp) */
	createdAt: z.string(),
});
export type AgentActivity = z.infer<typeof AgentActivitySchema>;

/** Input for adding an activity (id + createdAt assigned by storage). */
export const AgentActivityDraftSchema = AgentActivitySchema.omit({
	id: true,
	createdAt: true,
}).extend({
	ephemeral: z.boolean().default(false),
});
export type AgentActivityDraft = z.input<typeof AgentActivityDraftSchema>;

// ============================================================
// Session Card (S5 folded read shape)
// ============================================================

/**
 * The folded summary of a session — one screen line + excerpt instead of the
 * full activity prose. Built by `Planner.toSessionCard` from a session + its
 * activity trail; consumed by Jake's folded timeline, `jake plan show`, and its
 * dashboard SessionCardEntry.
 */
export const SessionCardSchema = z.object({
	/** Session id (the card expands to this session's activities). */
	id: z.string(),
	/** Agent identifier (freeform). */
	agent: z.string(),
	/** Lifecycle state (soft string; see SESSION_STATES). */
	state: SessionStateSchema,
	/**
	 * Excerpt (~200 chars) of the final response, falling back to the latest
	 * durable activity. Never blank; omitted only when the session has no
	 * durable activity with a non-blank body.
	 */
	finalResponse: z.string().optional(),
	/** Number of DURABLE activities (the ones the card summarizes). */
	activityCount: z.number(),
	/**
	 * Durable severity-carrying activities bucketed by severity — counts BOTH
	 * `finding` and `verification` types (anything durable with a P1/P2/P3).
	 */
	findingCounts: z.object({
		P1: z.number(),
		P2: z.number(),
		P3: z.number(),
	}),
	/**
	 * State-based: true iff the session is currently `awaiting_input` (an
	 * unanswered question). Field name kept for compatibility; semantics are
	 * "needs input now", not "ever asked".
	 */
	hasQuestion: z.boolean(),
	/** When the session started (ISO timestamp). */
	startedAt: z.string(),
	/** Last activity/transition (ISO timestamp). */
	lastActivityAt: z.string(),
	/** When the session ended (ISO timestamp), if closed. */
	endedAt: z.string().optional(),
});
export type SessionCard = z.infer<typeof SessionCardSchema>;

// ============================================================
// Query + composite read shapes
// ============================================================

/** Filter for querySessions. */
export const SessionQuerySchema = z.object({
	/** Filter by task id */
	taskId: z.string().optional(),
	/** Filter by session state */
	state: SessionStateSchema.optional(),
	/** Filter by external_ref (e.g. a loop's on-disk state file). */
	externalRef: z.string().optional(),
});
export type SessionQuery = z.infer<typeof SessionQuerySchema>;
