/**
 * Planner Storage
 *
 * Storage for tasks, projects, links, comments, work logs, sessions and sync
 * state, over the Db port. The host decides the engine and the table prefix.
 *
 * Each domain file declares its own `export namespace Planner { ... }`.
 * This barrel re-exports them under a single merged `Planner` namespace.
 */

import { Planner as AssembleContext } from "./assemble-context";
import { Planner as Comments } from "./comments";
import { Planner as ContextRefs } from "./context-refs";
// Import domain namespaces
import { Planner as Init } from "./init";
import { Planner as Projects } from "./projects";
import { Planner as SelectDurable } from "./select-durable";
import { Planner as Sessions } from "./sessions";
import { Planner as Stats } from "./stats";
import { Planner as TaskLinks } from "./task-links";
import { Planner as Tasks } from "./tasks";
import { Planner as UpstreamLinks } from "./upstream-links";
import { Planner as WorkLogs } from "./work-logs";

// Merge all domain namespaces into a single Planner export.
// Using object spread + intersection type to combine all members.
export const Planner = {
	// Init
	init: Init.init,
	// Tasks & ID Resolution
	resolveTaskId: Tasks.resolveTaskId,
	addTask: Tasks.addTask,
	getTask: Tasks.getTask,
	findBySourceId: Tasks.findBySourceId,
	findByExternalRef: Tasks.findByExternalRef,
	getTasks: Tasks.getTasks,
	findDuplicatesBySourceId: Tasks.findDuplicatesBySourceId,
	updateTask: Tasks.updateTask,
	deleteTask: Tasks.deleteTask,
	queryTasks: Tasks.queryTasks,
	searchTasks: Tasks.searchTasks,
	getSubtaskCounts: Tasks.getSubtaskCounts,
	getToday: Tasks.getToday,
	// Task Links
	addLink: TaskLinks.addLink,
	getLinksForTask: TaskLinks.getLinksForTask,
	deleteLink: TaskLinks.deleteLink,
	// Projects
	resolveProjectId: Projects.resolveProjectId,
	addProject: Projects.addProject,
	getProject: Projects.getProject,
	updateProject: Projects.updateProject,
	deleteProject: Projects.deleteProject,
	queryProjects: Projects.queryProjects,
	// Comments
	addComment: Comments.addComment,
	updateComment: Comments.updateComment,
	getComment: Comments.getComment,
	getComments: Comments.getComments,
	deleteComment: Comments.deleteComment,
	// Work Logs
	addWorkLog: WorkLogs.addWorkLog,
	getWorkLogs: WorkLogs.getWorkLogs,
	deleteWorkLog: WorkLogs.deleteWorkLog,
	// Context Refs
	addContextRef: ContextRefs.addContextRef,
	getContextRefs: ContextRefs.getContextRefs,
	deleteContextRef: ContextRefs.deleteContextRef,
	promoteToContext: ContextRefs.promoteToContext,
	// Private Upstream Links
	upsertUpstreamLink: UpstreamLinks.upsertUpstreamLink,
	getUpstreamLinksForTask: UpstreamLinks.getUpstreamLinksForTask,
	getUpstreamSummariesForTasks: UpstreamLinks.getUpstreamSummariesForTasks,
	getUpstreamLinksByExternalRef: UpstreamLinks.getUpstreamLinksByExternalRef,
	deleteUpstreamLink: UpstreamLinks.deleteUpstreamLink,
	// Durable activity selector + session card (S5)
	selectDurableActivities: SelectDurable.selectDurableActivities,
	toSessionCard: SelectDurable.toSessionCard,
	// Context assembly (S3)
	assembleContext: AssembleContext.assembleContext,
	// Stats
	stats: Stats.stats,
	listScopes: Stats.listScopes,
	// Agent Sessions (S4a)
	startSession: Sessions.startSession,
	getSession: Sessions.getSession,
	updateSessionState: Sessions.updateSessionState,
	endSession: Sessions.endSession,
	addActivity: Sessions.addActivity,
	getActivities: Sessions.getActivities,
	querySessions: Sessions.querySessions,
	getNeedsInput: Sessions.getNeedsInput,
	sweepStaleSessions: Sessions.sweepStaleSessions,
} as const;

export { normalizeScopeUri } from "./helpers";
