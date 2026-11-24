/**
 * Planner Storage
 *
 * Storage for tasks, projects, links, timeline entries, work logs and sync
 * state, over the Db port. The host decides the engine.
 *
 * Each domain file declares its own `export namespace Planner { ... }`.
 * This barrel re-exports them under a single merged `Planner` namespace.
 */

import { Planner as AssembleContext } from "./assemble-context";
import { Planner as Comments } from "./comments";
import { Planner as Conditions } from "./conditions";
import { Planner as ContextPages } from "./context-pages";
import { Planner as ContextRefs } from "./context-refs";
// Import domain namespaces
import { Planner as Init } from "./init";
import { Planner as Plans } from "./plans";
import { Planner as Projects } from "./projects";
import { Planner as Stats } from "./stats";
import { Planner as TaskLinks } from "./task-links";
import { Planner as TaskPages } from "./task-pages";
import { Planner as TaskReceipts } from "./task-receipts";
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
	applyPlan: Plans.applyPlan,
	getTask: Tasks.getTask,
	findBySourceId: Tasks.findBySourceId,
	findByExternalRef: Tasks.findByExternalRef,
	getTasks: Tasks.getTasks,
	findDuplicatesBySourceId: Tasks.findDuplicatesBySourceId,
	updateTask: Tasks.updateTask,
	updateTaskIn: Tasks.updateTaskIn,
	updateTaskReceipt: TaskReceipts.updateTaskReceipt,
	deleteTask: Tasks.deleteTask,
	queryTasks: Tasks.queryTasks,
	searchTasks: Tasks.searchTasks,
	getSubtaskCounts: Tasks.getSubtaskCounts,
	getToday: Tasks.getToday,
	queryTaskPage: TaskPages.queryTaskPage,
	searchTaskPage: TaskPages.searchTaskPage,
	getTodayPages: TaskPages.getTodayPages,
	// Task Links
	matchingState: Conditions.matchingState,
	isReady: Conditions.isReady,
	claimHolder: Conditions.claimHolder,
	addressed: Conditions.addressed,
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
	// Timeline entries (a comment is an entry of kind `comment`)
	addEntry: Comments.addEntry,
	addEntryIn: Comments.addEntryIn,
	getEntries: Comments.getEntries,
	latestEntry: Comments.latestEntry,
	addComment: Comments.addComment,
	getComments: Comments.getComments,
	// Work Logs
	addWorkLog: WorkLogs.addWorkLog,
	deleteWorkLog: WorkLogs.deleteWorkLog,
	getWorkLogs: WorkLogs.getWorkLogs,
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
	// Context assembly (S3)
	assembleContext: AssembleContext.assembleContext,
	getContextPage: ContextPages.getContextPage,
	// Stats
	stats: Stats.stats,
	listScopes: Stats.listScopes,
} as const;

export { normalizeScopeUri } from "./helpers";

export { scopeClause } from "./task-selection";
