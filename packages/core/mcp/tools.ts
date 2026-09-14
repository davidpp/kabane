/**
 * MCP tool definitions — transport-free.
 *
 * One list of tools, each a name, a description an agent reads, a zod input
 * shape, and a handler over the storage namespace returning `Result`. The
 * stdio server (`cabane mcp`) and the hub Worker both build their MCP server
 * from this list, so a browser connector and a local CLI see the same surface.
 *
 * ONLY REPLICATED DATA. The hub holds what the sync set carries: tasks,
 * links, comments, work logs, projects, context refs, upstream links. Agent
 * sessions do not replicate, so there are no session tools here; the assembled
 * brief's Discussion section at the hub therefore carries comments only.
 *
 * SCOPE IS EXPLICIT AT THE HUB. A device can default `scopeUri` from its
 * working directory; the hub has no directory, so `scopeRequired` makes every
 * write demand one and points the agent at `cabane_scopeList`.
 */

import { z } from "zod";
import { err, ok, type Result } from "../result";
import {
	ItemKindSchema,
	LinkTypeSchema,
	type TaskDraft,
	TaskPrioritySchema,
	TaskStateSchema,
	type TaskUpdate,
} from "../schemas";
import { Planner } from "../storage";

// ============================================================
// Types
// ============================================================

/** What a host knows and a tool needs. */
export type ToolContext = {
	/** The `basePath` storage functions take. */
	basePath: string;
	/** Actor URI stamped as author on comments, work logs and context refs. */
	actor: string;
	/** Applied when a write omits `scopeUri`. */
	defaultScope?: string;
	/** Refuse writes with no scope (the hub). */
	scopeRequired: boolean;
};

export type ToolHandler<Shape extends z.ZodRawShape> = (
	args: z.infer<z.ZodObject<Shape>>,
	ctx: ToolContext,
) => Promise<Result<unknown>>;

export type ToolDef<Shape extends z.ZodRawShape = z.ZodRawShape> = {
	name: string;
	description: string;
	input: Shape;
	/** A read never mutates; the hub pushes to the log after every write. */
	kind: "read" | "write";
	handler: ToolHandler<Shape>;
};

/** Human actor URIs comment as `human`; agent actor URIs as `ai`. */
export const authorTypeOf = (actor: string): "human" | "ai" =>
	actor.startsWith("cabane://actor/agent/") ? "ai" : "human";

// ============================================================
// Private helpers
// ============================================================

const SCOPE_HINT =
	'Workspace/repo/client scope: a bare id ("jake") or a full URI ("jake://scope/jake"). The context boundary, not a project.';

const ID_HINT = "Task id: the short label (JCAB-12) or the ULID.";

const define = <Shape extends z.ZodRawShape>(
	def: ToolDef<Shape>,
): ToolDef<z.ZodRawShape> => def as unknown as ToolDef<z.ZodRawShape>;

const resolveScope = (
	given: string | undefined,
	ctx: ToolContext,
): Result<string | undefined> => {
	const scope = given ?? ctx.defaultScope;
	if (ctx.scopeRequired && scope === undefined) {
		return err(
			new Error(
				"scopeUri is required here: there is no working directory to detect it from. Call cabane_scopeList to see the scopes in use.",
			),
		);
	}
	return ok(scope);
};

const resolveId = (ctx: ToolContext, input: string): Promise<Result<string>> =>
	Planner.resolveTaskId(ctx.basePath, input);

const toDeadline = (date: string | undefined): string | undefined =>
	date === undefined
		? undefined
		: new Date(`${date}T23:59:59.000Z`).toISOString();

const definedOnly = <T extends Record<string, unknown>>(value: T): T =>
	Object.fromEntries(
		Object.entries(value).filter(([, v]) => v !== undefined),
	) as T;

// ============================================================
// Tools
// ============================================================

const add = define({
	name: "cabane_add",
	kind: "write",
	description: `Create a task or an issue (inbox by default).

Parameters:
- title: What to do, action-oriented
- kind: 'task' (a human, GTD) or 'issue' (an agent runtime picks it up). Default task
- description: Optional Markdown body; for an issue this is the brief an agent reads
- state: inbox, next, in_progress, waiting, someday. Default inbox; use next for work ready to be picked up
- priority: urgent, high, normal, low. Default normal
- scopeUri: ${SCOPE_HINT}
- assignee: Who completes it: a person, or an agent runtime such as claude, hermes, codex
- parentTaskId: Optional parent (short id or ULID) to file this under
- tags: Optional labels
- dueDate: Optional YYYY-MM-DD`,
	input: {
		title: z.string().min(1).max(500),
		kind: ItemKindSchema.optional(),
		description: z.string().optional(),
		state: TaskStateSchema.optional(),
		priority: TaskPrioritySchema.optional(),
		scopeUri: z.string().optional(),
		assignee: z.string().optional(),
		parentTaskId: z.string().optional(),
		tags: z.array(z.string()).optional(),
		dueDate: z.string().optional(),
	},
	handler: async (args, ctx) => {
		const scope = resolveScope(args.scopeUri, ctx);
		if (!scope.ok) return scope;
		let parentTaskId: string | undefined;
		if (args.parentTaskId) {
			const parent = await resolveId(ctx, args.parentTaskId);
			if (!parent.ok) return parent;
			parentTaskId = parent.value;
		}
		const draft: TaskDraft = {
			title: args.title,
			description: args.description,
			kind: args.kind ?? "task",
			state: args.state ?? "inbox",
			priority: args.priority ?? "normal",
			scopeUri: scope.value,
			assignee: args.assignee,
			parentTaskId,
			tags: args.tags ?? [],
			deadline: toDeadline(args.dueDate),
			provenance: {
				source: authorTypeOf(ctx.actor),
				discoveredAt: new Date().toISOString(),
				discoveredBy: ctx.actor,
			},
		};
		return Planner.addTask(ctx.basePath, draft);
	},
});

const get = define({
	name: "cabane_get",
	kind: "read",
	description: `Get one task's own fields: title, description, state, priority, assignee, scope, who last wrote it and its version. A raw record read; use cabane_context for the full brief.

Parameters:
- id: ${ID_HINT}`,
	input: { id: z.string().min(1) },
	handler: async (args, ctx) => {
		const task = await Planner.getTask(ctx.basePath, args.id);
		if (!task.ok) return task;
		return task.value
			? ok(task.value)
			: err(new Error(`No task found: ${args.id}`));
	},
});

const list = define({
	name: "cabane_list",
	kind: "read",
	description: `Query tasks with filters. Open tasks only unless includeClosed.

Parameters:
- state: inbox, next, in_progress, waiting, someday, done, cancelled
- kind: task or issue
- priority: urgent, high, normal, low
- assignee: Who it is assigned to. An agent runtime polls with its own name and state next to find work
- scopeUri: ${SCOPE_HINT} Omit for every scope
- tag: One tag
- includeClosed: Include done and cancelled (default false)
- limit: Max results (default 50)`,
	input: {
		state: TaskStateSchema.optional(),
		kind: ItemKindSchema.optional(),
		priority: TaskPrioritySchema.optional(),
		assignee: z.string().optional(),
		scopeUri: z.string().optional(),
		tag: z.string().optional(),
		includeClosed: z.boolean().optional(),
		limit: z.number().int().positive().optional(),
	},
	handler: (args, ctx) =>
		Planner.queryTasks(ctx.basePath, {
			state: args.state,
			kind: args.kind,
			priority: args.priority,
			assignee: args.assignee,
			scopeUri: args.scopeUri,
			tag: args.tag,
			includeClosed: args.includeClosed ?? args.state !== undefined,
			limit: args.limit,
		}),
});

const search = define({
	name: "cabane_search",
	kind: "read",
	description: `Full-text search over titles and descriptions.

Parameters:
- query: Search terms
- state: Optional state filter
- scopeUri: ${SCOPE_HINT} Omit for every scope
- limit: Optional max results`,
	input: {
		query: z.string().min(1),
		state: TaskStateSchema.optional(),
		scopeUri: z.string().optional(),
		limit: z.number().int().positive().optional(),
	},
	handler: (args, ctx) =>
		Planner.searchTasks(ctx.basePath, args.query, {
			state: args.state,
			scopeUri: args.scopeUri,
			limit: args.limit,
		}),
});

const today = define({
	name: "cabane_today",
	kind: "read",
	description: `Today's view for daily planning: overdue, due today, and the next actions.

Parameters:
- scopeUri: ${SCOPE_HINT} Omit for every scope
- kind: task or issue; omit for both
- includeDone: Include completed tasks (default false)`,
	input: {
		scopeUri: z.string().optional(),
		kind: ItemKindSchema.optional(),
		includeDone: z.boolean().optional(),
	},
	handler: (args, ctx) =>
		Planner.getToday(ctx.basePath, {
			scopeUri: args.scopeUri,
			kind: args.kind,
			includeDone: args.includeDone,
		}),
});

const done = define({
	name: "cabane_done",
	kind: "write",
	description: `Mark a task done. Add a comment first if the outcome needs explaining.

Parameters:
- id: ${ID_HINT}`,
	input: { id: z.string().min(1) },
	handler: async (args, ctx) => {
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;
		const updated = await Planner.updateTask(ctx.basePath, id.value, {
			state: "done",
		});
		if (!updated.ok) return updated;
		return updated.value
			? ok(updated.value)
			: err(new Error(`No task found: ${args.id}`));
	},
});

const edit = define({
	name: "cabane_edit",
	kind: "write",
	description: `Edit a task. Pass the id and only the fields to change. Setting state to in_progress with your own assignee is how a runtime claims an issue.

Parameters:
- id: ${ID_HINT}
- title, description, state, priority, kind, assignee, scopeUri, parentTaskId, tags, dueDate: as in cabane_add
- assignee 'none' and parentTaskId 'none' clear the field`,
	input: {
		id: z.string().min(1),
		title: z.string().min(1).max(500).optional(),
		description: z.string().optional(),
		state: TaskStateSchema.optional(),
		priority: TaskPrioritySchema.optional(),
		kind: ItemKindSchema.optional(),
		assignee: z.string().optional(),
		scopeUri: z.string().optional(),
		parentTaskId: z.string().optional(),
		tags: z.array(z.string()).optional(),
		dueDate: z.string().optional(),
	},
	handler: async (args, ctx) => {
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;
		let parentTaskId: string | undefined;
		if (args.parentTaskId && args.parentTaskId !== "none") {
			const parent = await resolveId(ctx, args.parentTaskId);
			if (!parent.ok) return parent;
			parentTaskId = parent.value;
		}
		const update: TaskUpdate = definedOnly({
			title: args.title,
			description: args.description,
			state: args.state,
			priority: args.priority,
			kind: args.kind,
			assignee: args.assignee === "none" ? "" : args.assignee,
			scopeUri: args.scopeUri,
			parentTaskId: args.parentTaskId === "none" ? null : parentTaskId,
			tags: args.tags,
			deadline: toDeadline(args.dueDate),
		});
		if (Object.keys(update).length === 0) {
			return err(new Error("Nothing to change: pass at least one field."));
		}
		const updated = await Planner.updateTask(ctx.basePath, id.value, update);
		if (!updated.ok) return updated;
		return updated.value
			? ok(updated.value)
			: err(new Error(`No task found: ${args.id}`));
	},
});

const link = define({
	name: "cabane_link",
	kind: "write",
	description: `Create a typed link in the task DAG, read source → target: one issue blocks another, follows it, duplicates it, or is related. Dependency order becomes queryable instead of buried in prose.

Parameters:
- sourceId: The 'from' task (short id or ULID)
- targetId: The 'to' task
- type: ${LinkTypeSchema.options.join(", ")}
- note: Optional explanation`,
	input: {
		sourceId: z.string().min(1),
		targetId: z.string().min(1),
		type: LinkTypeSchema,
		note: z.string().optional(),
	},
	handler: async (args, ctx) => {
		const source = await resolveId(ctx, args.sourceId);
		if (!source.ok) return source;
		const target = await resolveId(ctx, args.targetId);
		if (!target.ok) return target;
		return Planner.addLink(ctx.basePath, {
			sourceId: source.value,
			targetId: target.value,
			type: args.type,
			note: args.note,
		});
	},
});

const comment = define({
	name: "cabane_comment",
	kind: "write",
	description: `Add a comment to a task. The author is the connected identity; agent identities comment as ai. Human comments are never dropped from the brief, so this is how to steer an agent.

Parameters:
- id: ${ID_HINT}
- content: Markdown`,
	input: { id: z.string().min(1), content: z.string().min(1) },
	handler: async (args, ctx) => {
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;
		return Planner.addComment(ctx.basePath, {
			taskId: id.value,
			author: ctx.actor,
			authorType: authorTypeOf(ctx.actor),
			content: args.content,
		});
	},
});

const workLog = define({
	name: "cabane_log",
	kind: "write",
	description: `Log work done on a task as URI references.

Ref forms: commit:<sha>, branch:<name>, pr:<owner>/<repo>#<n>, issue:<owner>/<repo>#<n>, file:<path>, session:<id>, url:<https://...>

Parameters:
- id: ${ID_HINT}
- refs: Array of { uri, label? }
- note: Optional summary`,
	input: {
		id: z.string().min(1),
		refs: z
			.array(z.object({ uri: z.string().min(1), label: z.string().optional() }))
			.min(1),
		note: z.string().optional(),
	},
	handler: async (args, ctx) => {
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;
		return Planner.addWorkLog(ctx.basePath, {
			taskId: id.value,
			refs: args.refs,
			note: args.note,
			addedBy: ctx.actor,
			addedByType: authorTypeOf(ctx.actor),
		});
	},
});

const contextAdd = define({
	name: "cabane_contextAdd",
	kind: "write",
	description: `Add a curated input-context ref to a task: the PRD, ADR, research note or transcript an implementer should read. The input side of an issue, distinct from the work log.

Parameters:
- id: ${ID_HINT}
- uri: e.g. "obsidian:prds/foo.md", "file:docs/auth.md", "url:https://..."
- kind: PRD, ADR, research, exemplar, transcript, design, spec, doc, or any string
- label: Optional human label
- note: Optional note`,
	input: {
		id: z.string().min(1),
		uri: z.string().min(1),
		kind: z.string().min(1),
		label: z.string().optional(),
		note: z.string().optional(),
	},
	handler: async (args, ctx) => {
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;
		return Planner.addContextRef(ctx.basePath, {
			taskId: id.value,
			uri: args.uri,
			kind: args.kind,
			label: args.label,
			note: args.note,
			addedBy: ctx.actor,
			addedByType: authorTypeOf(ctx.actor),
		});
	},
});

const contextList = define({
	name: "cabane_contextList",
	kind: "read",
	description: `List a task's curated context refs, oldest first.

Parameters:
- id: ${ID_HINT}`,
	input: { id: z.string().min(1) },
	handler: async (args, ctx) => {
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;
		return Planner.getContextRefs(ctx.basePath, id.value);
	},
});

const contextRemove = define({
	name: "cabane_contextRemove",
	kind: "write",
	description: `Remove a context ref by its ref id (from cabane_contextList). Never touches the work log.

Parameters:
- refId: The context ref id`,
	input: { refId: z.string().min(1) },
	handler: async (args, ctx) => {
		const removed = await Planner.deleteContextRef(ctx.basePath, args.refId);
		return removed.ok ? ok({ removed: args.refId }) : removed;
	},
});

const context = define({
	name: "cabane_context",
	kind: "read",
	description: `The assembled work brief for a task: description, position in the DAG, curated context, prior work, discussion. One call gives an agent everything it needs to start. THE read entrypoint before picking up an issue.

Parameters:
- id: ${ID_HINT}
- deref: Inline file: refs when the host can read them (default true)
- includeSubtasks: Include the subtask roll-up (default true)`,
	input: {
		id: z.string().min(1),
		deref: z.boolean().optional(),
		includeSubtasks: z.boolean().optional(),
	},
	handler: async (args, ctx) => {
		const brief = await Planner.assembleContext(ctx.basePath, args.id, {
			deref: args.deref,
			includeSubtasks: args.includeSubtasks,
		});
		return brief.ok ? ok({ id: args.id, markdown: brief.value }) : brief;
	},
});

const upstreamLink = define({
	name: "cabane_upstream_link",
	kind: "write",
	description: `Record that a task points at an issue in an external tracker (Linear, GitHub). Identity only: the link names the issue and opens it, it does NOT hold what the issue says. Put what matters about the external issue into the task's own description with cabane_edit — a second copy here would rot. Re-linking the same task to the same issue corrects the identifier, url and title in place.

Parameters:
- id: ${ID_HINT}
- provider: linear, github, or another tracker's name
- externalId: The provider's own stable id for the issue
- identifier: The human-readable key (ENG-123, owner/repo#12)
- url: The https link a human opens
- title: The issue's title, as it reads today`,
	input: {
		id: z.string().min(1),
		provider: z.string().trim().min(1),
		externalId: z.string().trim().min(1),
		identifier: z.string().trim().min(1).optional(),
		url: z.string().url(),
		title: z.string().trim().min(1),
	},
	handler: async (args, ctx) => {
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;
		return Planner.upsertUpstreamLink(ctx.basePath, {
			taskId: id.value,
			provider: args.provider,
			externalId: args.externalId,
			identifier: args.identifier,
			url: args.url,
			title: args.title,
		});
	},
});

const upstreamUnlink = define({
	name: "cabane_upstream_unlink",
	kind: "write",
	description: `Remove the link between a task and an external issue. Addressed by the pair that made it, not by a link id: the same arguments that linked it, unlink it.

Parameters:
- id: ${ID_HINT}
- provider: The provider the link was made with
- externalId: The provider's own id for the issue`,
	input: {
		id: z.string().min(1),
		provider: z.string().trim().min(1),
		externalId: z.string().trim().min(1),
	},
	handler: async (args, ctx) => {
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;

		const links = await Planner.getUpstreamLinksForTask(ctx.basePath, id.value);
		if (!links.ok) return links;
		const match = links.value.find(
			(link) =>
				link.provider === args.provider && link.externalId === args.externalId,
		);
		if (match === undefined) {
			return err(
				new Error(
					`No ${args.provider} link on ${args.id} for external id ${args.externalId}.`,
				),
			);
		}

		const removed = await Planner.deleteUpstreamLink(ctx.basePath, match.id);
		return removed.ok
			? ok({ unlinked: match.identifier ?? match.externalId })
			: removed;
	},
});

const scopeList = define({
	name: "cabane_scopeList",
	kind: "read",
	description:
		"List the scopes in use with a task count each. Call this before a write when you do not know which scopeUri to pass.",
	input: {},
	handler: (_args, ctx) => Planner.listScopes(ctx.basePath),
});

// ============================================================
// Public surface
// ============================================================

/** Every tool, in the order an agent should discover them. */
export const CABANE_TOOLS: readonly ToolDef[] = [
	scopeList,
	add,
	get,
	list,
	search,
	today,
	context,
	edit,
	done,
	link,
	comment,
	workLog,
	contextAdd,
	contextList,
	contextRemove,
	upstreamLink,
	upstreamUnlink,
];

/** Server-level instructions sent on initialize. */
export const SERVER_INSTRUCTIONS = `Cabane is a shared work queue for humans and agent runtimes.
Two kinds of item: 'task' is human GTD work (inbox → next → done); 'issue' is work an agent runtime picks up.
To brainstorm into work: cabane_add with kind issue, a description that is the brief, state next, and assignee set to the runtime (claude, hermes, codex).
To pick up work as a runtime: cabane_list with your assignee and state next, cabane_context on the chosen id, cabane_edit to in_progress, then cabane_log and cabane_comment as you go, cabane_done at the end.
Scopes are the context boundary (a repo, a client). Discover them with cabane_scopeList and pass scopeUri on writes.
When a task has a twin in Linear or GitHub, record it with cabane_upstream_link and put what the external issue says into the task's own description — the link is identity only, so nothing stored on it can go stale.`;
