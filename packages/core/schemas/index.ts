/**
 * Planner Schemas
 *
 * Zod schemas for Planner data structures.
 * All schemas follow Zod-first pattern: define schema, infer type.
 */

// assembleContext options
export {
	type AssembleContextOpts,
	AssembleContextOptsSchema,
	type ResolvedAssembleContextOpts,
} from "./assemble-context";
// Comment schemas
export {
	type AuthorType,
	AuthorTypeSchema,
	type TaskComment,
	type TaskCommentDraft,
	TaskCommentDraftSchema,
	TaskCommentSchema,
	type TaskCommentUpdate,
	TaskCommentUpdateSchema,
} from "./comment";
// Config schemas
export {
	type SyncConfig,
	SyncConfigSchema,
} from "./config";
// Context ref schemas
export {
	type AddContextRefInput,
	AddContextRefInputSchema,
	CONTEXT_REF_KINDS,
	type TaskContextRef,
	TaskContextRefSchema,
} from "./context-ref";
// Deadline: a calendar date or an instant, read in the owner's timezone
export { Deadline, DeadlineSchema, TimeZoneSchema } from "./deadline";
// Display configs (for UI consumers like dashboard)
export {
	AGENT_ACTIVITY_TYPE_DISPLAY,
	AGENT_SESSION_STATE_DISPLAY,
	CONTEXT_KIND_DISPLAY,
	type DisplayConfig,
	TASK_PRIORITY_DISPLAY,
	TASK_SOURCE_DISPLAY,
	TASK_STATE_DISPLAY,
} from "./display";
// Link schemas
export {
	type LinkType,
	LinkTypeSchema,
	type TaskLink,
	type TaskLinkDraft,
	TaskLinkDraftSchema,
	TaskLinkSchema,
} from "./link";
// Project schemas
export {
	type Project,
	type ProjectDraft,
	ProjectDraftSchema,
	type ProjectQuery,
	ProjectQuerySchema,
	ProjectSchema,
	type ProjectState,
	ProjectStateSchema,
	type ProjectUpdate,
	ProjectUpdateSchema,
} from "./project";
// Question-body convention (S4b — ask_question onto sessions)
export {
	answersContext,
	formatQuestionBody,
	isAnswerTo,
	type ParsedQuestion,
	parseQuestionBody,
	type QuestionMeta,
	QuestionMetaSchema,
} from "./question-body";
// Agent session schemas (S4a)
export {
	ACTIVITY_SEVERITIES,
	ACTIVITY_TYPES,
	type ActivitySeverity,
	ActivitySeveritySchema,
	type ActivityType,
	ActivityTypeSchema,
	type AgentActivity,
	type AgentActivityDraft,
	AgentActivityDraftSchema,
	AgentActivitySchema,
	type AgentSession,
	type AgentSessionDraft,
	AgentSessionDraftSchema,
	AgentSessionSchema,
	SESSION_STATES,
	type SessionCard,
	SessionCardSchema,
	type SessionQuery,
	SessionQuerySchema,
	type SessionState,
	SessionStateSchema,
} from "./session";
// Sync schemas
export {
	type QuarantinedOp,
	QuarantinedOpSchema,
	SYNC_TABLES,
	type SyncOp,
	type SyncOpKind,
	SyncOpKindSchema,
	SyncOpSchema,
	type SyncStatus,
	SyncStatusSchema,
	type SyncTable,
} from "./sync";
// Task schemas
export {
	type ItemKind,
	ItemKindSchema,
	type Provenance,
	ProvenanceSchema,
	type Task,
	type TaskDraft,
	TaskDraftSchema,
	type TaskPriority,
	TaskPrioritySchema,
	type TaskQuery,
	TaskQuerySchema,
	TaskSchema,
	type TaskSource,
	TaskSourceSchema,
	type TaskState,
	// Core task
	TaskStateSchema,
	type TaskUpdate,
	TaskUpdateSchema,
	type Verification,
	type VerificationMethod,
	VerificationMethodSchema,
	VerificationSchema,
	type VerificationStatus,
	VerificationStatusSchema,
} from "./task";
// Private upstream-link schemas
export {
	UPSTREAM_PROVIDERS,
	type UpsertUpstreamLinkInput,
	UpsertUpstreamLinkInputSchema,
	type UpstreamLink,
	UpstreamLinkSchema,
	type UpstreamSummary,
	UpstreamSummarySchema,
} from "./upstream-link";
// Work log schemas
export {
	type AddWorkLogInput,
	AddWorkLogInputSchema,
	parseWorkRefUri,
	type TaskWorkLog,
	type TaskWorkLogDraft,
	TaskWorkLogDraftSchema,
	TaskWorkLogSchema,
	WORK_REF_TYPES,
	type WorkRef,
	WorkRefSchema,
	type WorkRefType,
} from "./work-log";
