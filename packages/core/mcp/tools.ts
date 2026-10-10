/**
 * MCP tool definitions — transport-free.
 *
 * One list of tools, each a name, a description an agent reads, a zod input
 * shape, and a handler over the storage namespace returning `Result`. The
 * stdio server (`kabane mcp`) and the hub Worker both build their MCP server
 * from this list, so a browser connector and a local CLI see the same surface.
 *
 * ONLY REPLICATED DATA. The hub holds what the sync set carries: tasks,
 * links, comments, work logs, projects, context refs, upstream links. Agent
 * sessions do not replicate, so there are no session tools here; the assembled
 * brief's Discussion section at the hub therefore carries comments only.
 *
 * SCOPE IS EXPLICIT AT THE HUB. A device can default `scopeUri` from its
 * working directory; the hub has no directory, so `scopeRequired` makes every
 * write demand one and points the agent at `kabane_scopeList`.
 */

import { z } from "zod";
import { ContextPageOptionsSchema } from "../context-output";
import { err, ok, type Result } from "../result";
import { Runtime } from "../runtime";
import {
	Deadline,
	ItemKindSchema,
	LinkTypeSchema,
	type TaskDraft,
	TaskPrioritySchema,
	TaskStateSchema,
	type TaskUpdate,
} from "../schemas";
import { Planner } from "../storage";
import { ResponseFormatSchema, taskReceipt } from "../task-output";

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
				"scopeUri is required here: there is no working directory to detect it from. Call kabane_scopeList to see the scopes in use.",
			),
		);
	}
	return ok(scope);
};

const resolveId = (ctx: ToolContext, input: string): Promise<Result<string>> =>
	Planner.resolveTaskId(ctx.basePath, input);

const definedOnly = <T extends Record<string, unknown>>(value: T): T =>
	Object.fromEntries(
		Object.entries(value).filter(([, v]) => v !== undefined),
	) as T;

// ============================================================
// Tools
// ============================================================

const add = define({
	name: "kabane_add",
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
- dueDate: Optional. YYYY-MM-DD is a calendar date, due by the end of that day in the owner's timezone; an ISO datetime with Z or an offset is that exact instant; one without is a local time in the owner's timezone
- responseFormat: concise returns a <=2KiB identity/state/version receipt; omitted/full returns the task`,
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
		responseFormat: ResponseFormatSchema.optional(),
	},
	handler: async (args, ctx) => {
		const scope = resolveScope(args.scopeUri, ctx);
		if (!scope.ok) return scope;
		const deadline = Deadline.fromInput(args.dueDate, Runtime.timezone());
		if (!deadline.ok) return deadline;
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
			deadline: deadline.value,
			provenance: {
				source: authorTypeOf(ctx.actor),
				discoveredAt: new Date().toISOString(),
				discoveredBy: ctx.actor,
			},
		};
		const created = await Planner.addTask(ctx.basePath, draft);
		if (!created.ok) return created;
		return args.responseFormat === "concise"
			? taskReceipt(created.value)
			: created;
	},
});

const get = define({
	name: "kabane_get",
	kind: "read",
	description: `Get one task's own fields: title, description, state, priority, assignee, scope, who last wrote it and its version. A raw record read; use kabane_context for the full brief.

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
	name: "kabane_list",
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
- limit: Full default 100; concise default 20, maximum 100
- responseFormat: concise returns a <=16KiB summary page; omitted/full returns raw records
- cursor: Concise continuation; repeat the same filters. Relevant writes invalidate it`,
	input: {
		state: TaskStateSchema.optional(),
		kind: ItemKindSchema.optional(),
		priority: TaskPrioritySchema.optional(),
		assignee: z.string().optional(),
		scopeUri: z.string().optional(),
		tag: z.string().optional(),
		includeClosed: z.boolean().optional(),
		limit: z.number().int().positive().optional(),
		responseFormat: ResponseFormatSchema.optional(),
		cursor: z.string().max(700).optional(),
	},
	handler: (args, ctx) => {
		const query = {
			state: args.state,
			kind: args.kind,
			priority: args.priority,
			assignee: args.assignee,
			scopeUri: args.scopeUri,
			tag: args.tag,
			includeClosed: args.includeClosed ?? args.state !== undefined,
		};
		if (args.responseFormat === "concise")
			return Planner.queryTaskPage(ctx.basePath, query, {
				limit: args.limit,
				cursor: args.cursor,
			});
		if (args.cursor !== undefined)
			return Promise.resolve(
				err(new Error("cursor requires responseFormat: concise.")),
			);
		return Planner.queryTasks(ctx.basePath, { ...query, limit: args.limit });
	},
});

const search = define({
	name: "kabane_search",
	kind: "read",
	description: `Full-text search over titles and descriptions.

Parameters:
- query: Search terms
- state: Optional state filter
- scopeUri: ${SCOPE_HINT} Omit for every scope
- limit: Full default 20; concise default 20, maximum 100
- responseFormat: concise returns a <=16KiB ranked summary page; omitted/full returns raw records
- cursor: Concise continuation; repeat query, filters and format`,
	input: {
		query: z.string().min(1),
		state: TaskStateSchema.optional(),
		scopeUri: z.string().optional(),
		limit: z.number().int().positive().optional(),
		responseFormat: ResponseFormatSchema.optional(),
		cursor: z.string().max(700).optional(),
	},
	handler: (args, ctx) => {
		const opts = { state: args.state, scopeUri: args.scopeUri };
		if (args.responseFormat === "concise")
			return Planner.searchTaskPage(ctx.basePath, args.query, opts, {
				limit: args.limit,
				cursor: args.cursor,
			});
		if (args.cursor !== undefined)
			return Promise.resolve(
				err(new Error("cursor requires responseFormat: concise.")),
			);
		return Planner.searchTasks(ctx.basePath, args.query, {
			...opts,
			limit: args.limit,
		});
	},
});

const today = define({
	name: "kabane_today",
	kind: "read",
	description: `Today's view for daily planning: overdue, due today, and the next actions. Today is the owner's local day; a calendar-date deadline counts on its own day.

Parameters:
- scopeUri: ${SCOPE_HINT} Omit for every scope
- kind: task or issue; omit for both
- includeDone: Include completed tasks (default false)
- responseFormat: concise returns independent bucket pages, all text <=16KiB; omitted/full returns legacy buckets
- limit: Concise per-bucket rows (default 20, maximum 100)
- cursors: Per-bucket concise continuation; repeat scope/filters. Owner day/timezone changes require restarting`,
	input: {
		scopeUri: z.string().optional(),
		kind: ItemKindSchema.optional(),
		includeDone: z.boolean().optional(),
		responseFormat: ResponseFormatSchema.optional(),
		limit: z.number().int().positive().optional(),
		cursors: z
			.object({
				overdue: z.string().max(700).optional(),
				dueToday: z.string().max(700).optional(),
				next: z.string().max(700).optional(),
			})
			.strict()
			.optional(),
	},
	handler: (args, ctx) => {
		const opts = {
			scopeUri: args.scopeUri,
			kind: args.kind,
			includeDone: args.includeDone,
		};
		if (args.responseFormat === "concise")
			return Planner.getTodayPages(ctx.basePath, opts, {
				limit: args.limit,
				cursors: args.cursors,
			});
		if (args.limit !== undefined || args.cursors !== undefined)
			return Promise.resolve(
				err(new Error("today limit/cursors require responseFormat: concise.")),
			);
		return Planner.getToday(ctx.basePath, opts);
	},
});

const done = define({
	name: "kabane_done",
	kind: "write",
	description: `Mark a task done. Add a comment first if the outcome needs explaining.

Parameters:
- id: ${ID_HINT}
- responseFormat: concise returns a <=2KiB identity/state/version receipt; omitted/full returns the task`,
	input: {
		id: z.string().min(1),
		responseFormat: ResponseFormatSchema.optional(),
	},
	handler: async (args, ctx) => {
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;
		if (args.responseFormat === "concise")
			return Planner.updateTaskReceipt(ctx.basePath, id.value, {
				state: "done",
			});
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
	name: "kabane_edit",
	kind: "write",
	description: `Edit a task. Pass the id and only the fields to change. Setting state to in_progress with your own assignee is how a runtime claims an issue.

Parameters:
- id: ${ID_HINT}
- title, description, state, priority, kind, assignee, scopeUri, parentTaskId, tags, dueDate: as in kabane_add
- assignee 'none' and parentTaskId 'none' clear the field
- responseFormat: concise returns a <=2KiB identity/state/version receipt; omitted/full returns the task`,
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
		responseFormat: ResponseFormatSchema.optional(),
	},
	handler: async (args, ctx) => {
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;
		const deadline = Deadline.fromInput(args.dueDate, Runtime.timezone());
		if (!deadline.ok) return deadline;
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
			deadline: deadline.value,
		});
		if (Object.keys(update).length === 0) {
			return err(new Error("Nothing to change: pass at least one field."));
		}
		if (args.responseFormat === "concise")
			return Planner.updateTaskReceipt(ctx.basePath, id.value, update);
		const updated = await Planner.updateTask(ctx.basePath, id.value, update);
		if (!updated.ok) return updated;
		return updated.value
			? ok(updated.value)
			: err(new Error(`No task found: ${args.id}`));
	},
});

const link = define({
	name: "kabane_link",
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
	name: "kabane_comment",
	kind: "write",
	description: `Add a comment to a task. The author is the connected identity; agent identities comment as ai. Human comments are never dropped from the brief, so this is how to steer an agent.

Parameters:
- id: ${ID_HINT}
- body: Markdown (recommended); text and legacy content are aliases. Supply at least one; multiple must be exactly equal`,
	input: {
		id: z.string().min(1),
		body: z
			.string()
			.min(1)
			.optional()
			.describe("Markdown comment (recommended)."),
		text: z
			.string()
			.min(1)
			.optional()
			.describe("Alias for body; must match exactly if combined."),
		content: z
			.string()
			.min(1)
			.optional()
			.describe("Legacy alias for body; must match exactly if combined."),
	},
	handler: async (args, ctx) => {
		const content = args.body ?? args.text ?? args.content;
		if (content === undefined)
			return err(
				new Error(
					"Comment requires Markdown: supply body (recommended), text or content.",
				),
			);
		if (
			[args.body, args.text, args.content].some(
				(value) => value !== undefined && value !== content,
			)
		)
			return err(
				new Error(
					"Comment body, text and content must be exactly equal when combined; supply only body or make all supplied aliases identical.",
				),
			);
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;
		return Planner.addComment(ctx.basePath, {
			taskId: id.value,
			author: ctx.actor,
			authorType: authorTypeOf(ctx.actor),
			content,
		});
	},
});

const workLog = define({
	name: "kabane_log",
	kind: "write",
	description: `Log work done on a task as URI references.

Ref forms: commit:<sha>, branch:<name>, pr:<owner>/<repo>#<n>, issue:<owner>/<repo>#<n>, file:<path>, session:<id>, url:<https://...>

Parameters:
- id: ${ID_HINT}
- refs: Optional nonempty array of { uri, label? }; supply refs or commit
- commit: Optional bare SHA or revision, shorthand for a commit: URI; appended unless that exact URI is already in refs
- note: Optional summary`,
	input: {
		id: z.string().min(1),
		refs: z
			.array(z.object({ uri: z.string().min(1), label: z.string().optional() }))
			.min(1)
			.optional()
			.describe("Work references {uri, label?}; supply refs or commit."),
		commit: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Bare SHA or revision; adds commit:<value> unless already in refs.",
			),
		note: z.string().optional(),
	},
	handler: async (args, ctx) => {
		if (args.refs === undefined && args.commit === undefined)
			return err(
				new Error(
					"Work log requires references: supply commit (bare SHA or revision) or a nonempty refs array of {uri, label?}.",
				),
			);
		const refs = [...(args.refs ?? [])];
		if (args.commit !== undefined) {
			const uri = `commit:${args.commit}`;
			if (!refs.some((ref) => ref.uri === uri)) refs.push({ uri });
		}
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;
		return Planner.addWorkLog(ctx.basePath, {
			taskId: id.value,
			refs,
			note: args.note,
			addedBy: ctx.actor,
			addedByType: authorTypeOf(ctx.actor),
		});
	},
});

const contextAdd = define({
	name: "kabane_contextAdd",
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
	name: "kabane_contextList",
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
	name: "kabane_contextRemove",
	kind: "write",
	description: `Remove a context ref by its ref id (from kabane_contextList). Never touches the work log.

Parameters:
- refId: The context ref id`,
	input: { refId: z.string().min(1) },
	handler: async (args, ctx) => {
		const removed = await Planner.deleteContextRef(ctx.basePath, args.refId);
		return removed.ok ? ok({ removed: args.refId }) : removed;
	},
});

const context = define({
	name: "kabane_context",
	kind: "read",
	description: `THE read entrypoint before picking up an issue: description, DAG position, curated references, prior work and discussion. Prefer responseFormat: concise for bounded selected markdown (16KiB UTF-8 including JSON); consume ALL preceding chunks and finish required description/human steering before starting work. Completeness describes coverage from offset zero through this chunk, not instructions repeated in this response. Omitted/full preserves the complete legacy markdown envelope without a size bound. Local sessions/files may not be available at the hub.

Parameters:
- id: ${ID_HINT}
- deref: Inline file: refs within existing caps when the host can read them (default true)
- includeSubtasks: Include all children in the subtask roll-up (default true)
- responseFormat: concise or full; omission preserves full
- sections: Concise only; subset of metadata, description, upstream, position, context, priorWork, discussion (default all). Canonical order, duplicates ignored; omitted sections explicitly named.
- cursor: Concise only; pass nextCursor with the same id/options. Concatenate markdown chunks by offset to recover exact selected text. Relevant content changes invalidate continuation; restart without cursor.`,
	input: {
		id: z.string().min(1),
		deref: z.boolean().optional(),
		includeSubtasks: z.boolean().optional(),
		responseFormat: ResponseFormatSchema.optional(),
		sections: ContextPageOptionsSchema.shape.sections.optional(),
		cursor: ContextPageOptionsSchema.shape.cursor,
	},
	handler: async (args, ctx) => {
		if (args.responseFormat === "concise")
			return Planner.getContextPage(ctx.basePath, args.id, {
				deref: args.deref,
				includeSubtasks: args.includeSubtasks,
				sections: args.sections,
				cursor: args.cursor,
			});
		if (args.sections !== undefined || args.cursor !== undefined)
			return err(
				new Error("Context sections/cursor require responseFormat: concise."),
			);
		const brief = await Planner.assembleContext(ctx.basePath, args.id, {
			deref: args.deref,
			includeSubtasks: args.includeSubtasks,
		});
		return brief.ok ? ok({ id: args.id, markdown: brief.value }) : brief;
	},
});

const upstreamLink = define({
	name: "kabane_upstream_link",
	kind: "write",
	description: `Record that a task points at an issue in an external tracker (Linear, GitHub). Identity only: the link names the issue and opens it, it does NOT hold what the issue says. Put what matters about the external issue into the task's own description with kabane_edit — a second copy here would rot. Re-linking the same task to the same issue corrects the identifier, url and title in place.

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
	name: "kabane_upstream_unlink",
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
	name: "kabane_scopeList",
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
export const KABANE_TOOLS: readonly ToolDef[] = [
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
export const SERVER_INSTRUCTIONS = `Kabane is a shared work queue for humans and agent runtimes.
Two kinds of item: 'task' is human GTD work (inbox → next → done); 'issue' is work an agent runtime picks up.
To brainstorm into work: kabane_add with kind issue, a description that is the brief, state next, and assignee set to the runtime (claude, hermes, codex).
To pick up work as a runtime: kabane_list with responseFormat concise, your assignee and state next (follow nextCursor with the same filters), kabane_context on the chosen id, kabane_edit to in_progress with responseFormat concise, then kabane_log and kabane_comment as you go, kabane_done with responseFormat concise at the end. Use kabane_get for full fields; omitted/full formats remain legacy and unbounded.
Scopes are the context boundary (a repo, a client). Discover them with kabane_scopeList and pass scopeUri on writes.
When a task has a twin in Linear or GitHub, record it with kabane_upstream_link and put what the external issue says into the task's own description — the link is identity only, so nothing stored on it can go stale.`;
