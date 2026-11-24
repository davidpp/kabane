/**
 * MCP tool definitions — transport-free.
 *
 * One list of tools, each a name, a description an agent reads, a zod input
 * shape, and a handler over the storage namespace returning `Result`. The
 * stdio server (`kabane mcp`) and the hub Worker both build their MCP server
 * from this list, so a browser connector and a local CLI see the same surface.
 *
 * ONLY REPLICATED DATA. The hub holds what the sync set carries: tasks,
 * links, timeline entries, work logs, projects, context refs, upstream links,
 * and each registered module's tables. Core keeps no agent session: its
 * outcomes are timeline entries and the session a `session:` ref in the work
 * log, so the brief a device assembles and the hub's are the same.
 *
 * SCOPE IS EXPLICIT AT THE HUB. A device can default `scopeUri` from its
 * working directory; the hub has no directory, so `scopeRequired` makes every
 * write demand one and points the agent at `kabane_scopeList`.
 */

import { z } from "zod";
import { ActorUri } from "../actor";
import { ContextPageOptionsSchema } from "../context-output";
import { err, ok, NotFoundError, type Result } from "../result";
import { Runtime } from "../runtime";
import {
	Deadline,
	DEFAULT_ENTRY_KIND,
	ItemKindSchema,
	LinkTypeSchema,
	PlanSchema,
	type TaskDraft,
	TaskPrioritySchema,
	TaskStateSchema,
	type TaskUpdate,
} from "../schemas";
import { Planner } from "../storage";
import { ResponseFormatSchema, taskReceipt } from "../task-output";
import { CORE_TOOL_NAMES } from "./tool-names";

// ============================================================
// Types
// ============================================================

/** What a host knows and a tool needs. */
export type ToolContext = {
	/** The `basePath` storage functions take. */
	basePath: string;
	/** Actor URI stamped as author on comments, work logs and context refs. */
	actor: string;
	/**
	 * The human this connection relays for, set by the host that knows one:
	 * the device's configured actor before any `--as`, or the hub's Access
	 * identity when Access authenticated a human (never a service token). Read
	 * it through `humanActorOf`; `actor` alone is never taken for one.
	 */
	humanActor?: string;
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
	annotations?: { destructiveHint?: boolean; openWorldHint?: boolean };
	handler: ToolHandler<Shape>;
};

/** Human actor URIs comment as `human`; agent actor URIs as `ai`. */
export const authorTypeOf = (actor: string): "human" | "ai" =>
	actor.startsWith(ActorUri.AGENT) ? "ai" : "human";

/**
 * The human actor a connection can credit with a reply it relays: the host's
 * `humanActor` when it is a `kabane://actor/human/` URI, else none, so a
 * configured agent is never passed off as the human. `actor` is not consulted:
 * its URI alone does not say whether a human or a service authenticated.
 */
export const humanActorOf = (ctx: ToolContext): string | undefined =>
	ctx.humanActor?.startsWith(ActorUri.HUMAN) ? ctx.humanActor : undefined;

/** A tool with its own input shape, widened to the `ToolDef` a list of tools holds. */
export const define = <Shape extends z.ZodRawShape>(
	def: ToolDef<Shape>,
): ToolDef<z.ZodRawShape> => def as unknown as ToolDef<z.ZodRawShape>;

// ============================================================
// Private helpers
// ============================================================

const SCOPE_HINT =
	'Workspace/repo/client scope: a bare id ("myapp") or a full URI ("kabane://scope/myapp"). The context boundary, not a project.';

const ID_HINT = "Task id: the short label (JCAB-12) or the ULID.";

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
	name: CORE_TOOL_NAMES.add,
	kind: "write",
	description: `Create a task, an issue or a job (inbox by default).

Parameters:
- title: What to do, action-oriented
- kind: 'task' (a human, GTD), 'issue' (an agent runtime picks it up) or 'job' (a standing request a schedule runs). Default task
- description: Optional Markdown body; for an issue this is the brief an agent reads
- state: inbox, next, in_progress, waiting, someday. Default inbox; use next for work ready to be picked up
- priority: urgent, high, normal, low. Default normal
- scopeUri: ${SCOPE_HINT}
- assignee: Who completes it: a person, or an agent runtime such as claude, hermes, codex
- parentTaskId: Optional parent (short id or ULID) to file this under
- tags: Optional labels
- dueDate: Optional. YYYY-MM-DD is a calendar date, due by the end of that day in the owner's timezone; an ISO datetime with Z or an offset is that exact instant; one without is a local time in the owner's timezone
- key: Optional "<plan>/<name>" (lowercase), used as the task's id: adding again with the same key creates nothing and returns the task, marked existed, so a retry is safe. The same id kabane_apply gives thread <name> of plan <plan>
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
		key: z.string().optional(),
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
		const created = await Planner.addTask(ctx.basePath, draft, {
			key: args.key,
			concise: args.responseFormat === "concise",
		});
		if (!created.ok) return created;
		if (args.responseFormat !== "concise") return created;
		return taskReceipt(created.value);
	},
});

const apply = define({
	name: CORE_TOOL_NAMES.apply,
	kind: "write",
	description: `File a whole plan in one call: threads with keys you choose, and the links between them. Each thread's id is "<key>/<thread key>", so applying the same plan again creates nothing and says so: a retry after a crash is safe.

Parameters:
- key: The plan's key, lowercase letters, digits, dots, dashes and underscores
- plan: { threads: [{ key, title, kind?, description?, state?, priority?, assignee?, tags?, scopeUri?, parent? }], links?: [{ from, to, type, note? }] }. kind defaults to issue. A link's ends and a parent are a thread key in this plan, or an existing task's short id or ULID. type: ${LinkTypeSchema.options.join(", ")}
- scopeUri: ${SCOPE_HINT} For every thread that names none`,
	input: {
		key: z.string().min(1),
		plan: PlanSchema,
		scopeUri: z.string().optional(),
	},
	handler: async (args, ctx) => {
		const scope = resolveScope(args.scopeUri, ctx);
		if (!scope.ok) return scope;
		return Planner.applyPlan(ctx.basePath, args.plan, {
			key: args.key,
			scopeUri: scope.value,
			author: ctx.actor,
			source: authorTypeOf(ctx.actor),
		});
	},
});

const getInput = { id: z.string().min(1) };

const get = define({
	name: CORE_TOOL_NAMES.get,
	kind: "read",
	description: `Get one task's own fields: title, description, state, priority, assignee, scope, who last wrote it and its version. A raw record read; use kabane_context for the full brief.

Parameters:
- id: ${ID_HINT}`,
	input: getInput,
	handler: async (args, ctx) => {
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;
		const task = await Planner.getTask(ctx.basePath, id.value);
		if (!task.ok) return task;
		return task.value
			? ok(task.value)
			: err(new NotFoundError(`No task found: ${args.id}`));
	},
});

// Using .int() would add safe-integer bounds to the published MCP input schema.
const integerInput = (bound: z.ZodNumber) =>
	bound.refine(Number.isInteger, "Expected integer").meta({ type: "integer" });
const positiveLimit = integerInput(z.number().positive()).optional();

const listInput = {
	state: TaskStateSchema.optional(),
	kind: ItemKindSchema.optional(),
	priority: TaskPrioritySchema.optional(),
	assignee: z.string().optional(),
	scopeUri: z.string().optional(),
	tag: z.string().optional(),
	parentTaskId: z.string().min(1).optional(),
	includeDeferred: z.boolean().optional(),
	includeClosed: z.boolean().optional(),
	limit: positiveLimit,
	offset: integerInput(z.number().nonnegative()).optional(),
	responseFormat: ResponseFormatSchema.optional(),
	cursor: z.string().max(700).optional(),
};

const list = define({
	name: CORE_TOOL_NAMES.list,
	kind: "read",
	description: `Query tasks with filters. Open tasks only unless includeClosed.

Parameters:
- state: inbox, next, in_progress, waiting, someday, done, cancelled
- kind: task, issue or job; omit for every kind but job (a job is a standing request a schedule runs)
- priority: urgent, high, normal, low
- assignee: Who it is assigned to. An agent runtime polls with its own name and state next to find work
- scopeUri: ${SCOPE_HINT} Omit for every scope
- parentTaskId: Parent task short id or ULID
- includeDeferred: Include tasks deferred to a future date (default false)
- tag: One tag
- includeClosed: Include done and cancelled (default false)
- limit: Full default 100; concise default 20, maximum 100
- offset: Full-format rows to skip (default 0)
- responseFormat: concise returns a <=16KiB summary page; omitted/full returns raw records
- cursor: Concise continuation; repeat the same filters. Relevant writes invalidate it`,
	input: listInput,
	handler: async (args, ctx) => {
		if (args.responseFormat === "concise" && args.offset !== undefined)
			return err(
				new Error("concise pages with cursor; offset requires full format."),
			);
		let parentTaskId: string | undefined;
		if (args.parentTaskId !== undefined) {
			const parent = await resolveId(ctx, args.parentTaskId);
			if (!parent.ok) return parent;
			parentTaskId = parent.value;
		}
		const query = {
			state: args.state,
			kind: args.kind,
			priority: args.priority,
			assignee: args.assignee,
			scopeUri: args.scopeUri,
			tag: args.tag,
			parentTaskId,
			includeDeferred: args.includeDeferred ?? false,
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
		return Planner.queryTasks(ctx.basePath, {
			...query,
			limit: args.limit,
			offset: args.offset,
		});
	},
});

const search = define({
	name: CORE_TOOL_NAMES.search,
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
		limit: positiveLimit,
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
	name: CORE_TOOL_NAMES.today,
	kind: "read",
	description: `Today's view for daily planning: overdue, due today, and the next actions. Today is the owner's local day; a calendar-date deadline counts on its own day.

Parameters:
- scopeUri: ${SCOPE_HINT} Omit for every scope
- kind: task, issue or job; omit for every kind but job
- includeDone: Include completed tasks (default false)
- responseFormat: concise returns independent bucket pages, all text <=16KiB; omitted/full returns legacy buckets
- limit: Concise per-bucket rows (default 20, maximum 100)
- cursors: Per-bucket concise continuation; repeat scope/filters. Owner day/timezone changes require restarting`,
	input: {
		scopeUri: z.string().optional(),
		kind: ItemKindSchema.optional(),
		includeDone: z.boolean().optional(),
		responseFormat: ResponseFormatSchema.optional(),
		limit: positiveLimit,
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

const doneInput = {
	id: z.string().min(1),
	responseFormat: ResponseFormatSchema.optional(),
};

const done = define({
	name: CORE_TOOL_NAMES.done,
	kind: "write",
	description: `Mark a task done. Add a comment first if the outcome needs explaining.

Parameters:
- id: ${ID_HINT}
- responseFormat: concise returns a <=2KiB identity/state/version receipt; omitted/full returns the task`,
	input: doneInput,
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

const editInput = {
	id: z.string().min(1),
	title: z.string().min(1).max(500).optional(),
	description: z.string().optional(),
	state: TaskStateSchema.optional(),
	needsReview: z.boolean().optional(),
	priority: TaskPrioritySchema.optional(),
	kind: ItemKindSchema.optional(),
	assignee: z.string().optional(),
	scopeUri: z.string().optional(),
	parentTaskId: z.string().optional(),
	tags: z.array(z.string()).optional(),
	dueDate: z.string().optional(),
	responseFormat: ResponseFormatSchema.optional(),
};

const edit = define({
	name: CORE_TOOL_NAMES.edit,
	kind: "write",
	description: `Edit a task. Pass the id and only the fields to change. Setting state to in_progress with your own assignee is how a runtime claims an issue: the result's claimedBy names who holds the claim, and claimHeld is false when it is not you: another agent claimed it first, so leave it. Putting it back (any state but in_progress or waiting) releases the claim.

Parameters:
- id: ${ID_HINT}
- title, description, state, priority, kind, assignee, scopeUri, parentTaskId, tags, dueDate: as in kabane_add
- assignee 'none' and parentTaskId 'none' clear the field
- needsReview: Flag or unflag the issue for human review
- responseFormat: concise returns a <=2KiB identity/state/version receipt; omitted/full returns the task`,
	input: editInput,
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
			needsReview: args.needsReview,
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
		const result: Result<object> = await Planner.updateTask(
			ctx.basePath,
			id.value,
			update,
		).then((updated) =>
			!updated.ok || updated.value
				? (updated as Result<object>)
				: err(new Error(`No task found: ${args.id}`)),
		);
		if (!result.ok || args.state !== "in_progress") return result;
		const holder = await Planner.claimHolder(ctx.basePath, id.value);
		return holder.ok
			? ok({
					...result.value,
					claimedBy: holder.value,
					claimHeld: holder.value === Runtime.actor(),
				})
			: holder;
	},
});

const link = define({
	name: CORE_TOOL_NAMES.link,
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

const commentInput = {
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
	kind: z.string().optional().describe("Entry kind; omitted, a plain comment."),
};

const comment = define({
	name: CORE_TOOL_NAMES.comment,
	kind: "write",
	description: `Add a comment to a task. The author is the connected identity; agent identities comment as ai. Human comments are never dropped from the brief, so this is how to steer an agent. An entry given a kind other than comment (a review, a finding) is kept in the brief whoever writes it; for a kind a module lifts into its own section, only the newest is shown and the older ones are counted.

Parameters:
- id: ${ID_HINT}
- body: Markdown (recommended); text and legacy content are aliases. Supply at least one; multiple must be exactly equal
- kind: Optional; lowercase "name" or "name.key" (review, handoff.summary). Default comment`,
	input: commentInput,
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
		return Planner.addEntry(ctx.basePath, {
			taskId: id.value,
			kind: args.kind ?? DEFAULT_ENTRY_KIND,
			author: ctx.actor,
			authorType: authorTypeOf(ctx.actor),
			content,
		});
	},
});

const workLogInput = {
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
};

const workLog = define({
	name: CORE_TOOL_NAMES.workLog,
	kind: "write",
	description: `Log work done on a task as URI references.

Ref forms: commit:<sha>, branch:<name>, pr:<owner>/<repo>#<n>, issue:<owner>/<repo>#<n>, file:<path>, session:<id>, url:<https://...>

Parameters:
- id: ${ID_HINT}
- refs: Optional nonempty array of { uri, label? }; supply refs or commit
- commit: Optional bare SHA or revision, shorthand for a commit: URI; appended unless that exact URI is already in refs
- note: Optional summary`,
	input: workLogInput,
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
	name: CORE_TOOL_NAMES.contextAdd,
	kind: "write",
	description: `Add a curated context ref to a task: either what it reads (the PRD, ADR, research note or transcript an implementer should read) or, with kind artifact, what it keeps up to date (a doc, a note, a page), on any task kind, a job included. A one-off output (a PR, a commit, a research note) is not an artifact: log it with kabane_log (pr:, commit:, file:).

Parameters:
- id: ${ID_HINT}
- uri: e.g. "obsidian:prds/foo.md", "file:docs/auth.md", "url:https://..."
- kind: PRD, ADR, research, exemplar, transcript, design, spec, doc, artifact, or any string
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

const linkListInput = { id: z.string().min(1) };

const linkList = define({
	name: CORE_TOOL_NAMES.linkList,
	kind: "read",
	description: `List a task's links in both directions.

Parameters:
- id: ${ID_HINT}`,
	input: linkListInput,
	handler: async (args, ctx) => {
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;
		return Planner.getLinksForTask(ctx.basePath, id.value);
	},
});

const upstreamListInput = { id: z.string().min(1) };

const upstreamList = define({
	name: CORE_TOOL_NAMES.upstreamList,
	kind: "read",
	description: `List a task's upstream links.

Parameters:
- id: ${ID_HINT}`,
	input: upstreamListInput,
	handler: async (args, ctx) => {
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;
		return Planner.getUpstreamLinksForTask(ctx.basePath, id.value);
	},
});

const logListInput = {
	id: z.string().min(1),
	limit: integerInput(z.number().min(1)).optional(),
};

const logList = define({
	name: CORE_TOOL_NAMES.logList,
	kind: "read",
	description: `List a task's work logs, oldest first.

Parameters:
- id: ${ID_HINT}
- limit: Optional; only the newest N entries, still oldest first`,
	input: logListInput,
	handler: async (args, ctx) => {
		const id = await resolveId(ctx, args.id);
		if (!id.ok) return id;
		const logs = await Planner.getWorkLogs(ctx.basePath, id.value);
		if (!logs.ok) return logs;
		return ok(
			args.limit === undefined ? logs.value : logs.value.slice(-args.limit),
		);
	},
});

const contextList = define({
	name: CORE_TOOL_NAMES.contextList,
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
	name: CORE_TOOL_NAMES.contextRemove,
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

const contextInput = {
	id: z.string().min(1),
	deref: z.boolean().optional(),
	includeSubtasks: z.boolean().optional(),
	responseFormat: ResponseFormatSchema.optional(),
	sections: ContextPageOptionsSchema.shape.sections.unwrap().optional(),
	cursor: ContextPageOptionsSchema.shape.cursor,
};

const context = define({
	name: CORE_TOOL_NAMES.context,
	kind: "read",
	description: `THE read entrypoint before picking up an issue: description, DAG position, curated references, prior work and discussion. Prefer responseFormat: concise for bounded selected markdown (16KiB UTF-8 including JSON); consume ALL preceding chunks and finish required description/human steering before starting work. Completeness describes coverage from offset zero through this chunk, not instructions repeated in this response. Omitted/full preserves the complete legacy markdown envelope without a size bound. Local files may not be available at the hub.

Parameters:
- id: ${ID_HINT}
- deref: Inline file: refs within existing caps when the host can read them (default true)
- includeSubtasks: Include all children in the subtask roll-up (default true)
- responseFormat: concise or full; omission preserves full
- sections: Concise only; subset of metadata, description, upstream, position, context, priorWork, discussion and registered module section names (<module>.<key>, and <kind>.latest for a kind a module lifts out of the discussion); default all. Canonical order, duplicates ignored; omitted sections explicitly named.
- cursor: Concise only; pass nextCursor with the same id/options. Concatenate markdown chunks by offset to recover exact selected text. Relevant content changes invalidate continuation; restart without cursor.`,
	input: contextInput,
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

const upstreamLinkInput = {
	id: z.string().min(1),
	provider: z.string().trim().min(1),
	externalId: z.string().trim().min(1),
	identifier: z.string().trim().min(1).optional(),
	url: z.url(),
	title: z.string().trim().min(1),
};

const upstreamLink = define({
	name: CORE_TOOL_NAMES.upstreamLink,
	kind: "write",
	description: `Record that a task points at an issue in an external tracker (Linear, GitHub). Identity only: the link names the issue and opens it, it does NOT hold what the issue says. Put what matters about the external issue into the task's own description with kabane_edit — a second copy here would rot. Re-linking the same task to the same issue corrects the identifier, url and title in place.

Parameters:
- id: ${ID_HINT}
- provider: linear, github, or another tracker's name
- externalId: The provider's own stable id for the issue
- identifier: The human-readable key (ENG-123, owner/repo#12)
- url: The https link a human opens
- title: The issue's title, as it reads today`,
	input: upstreamLinkInput,
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
	name: CORE_TOOL_NAMES.upstreamUnlink,
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
	name: CORE_TOOL_NAMES.scopeList,
	kind: "read",
	description:
		"List the scopes in use with a task count each. Call this before a write when you do not know which scopeUri to pass.",
	input: {},
	handler: (_args, ctx) => Planner.listScopes(ctx.basePath),
});

// ============================================================
// Public surface
// ============================================================

/** Input shapes retained before define widens registered tools. */
export type CoreToolInputShapes = {
	get: typeof getInput;
	list: typeof listInput;
	edit: typeof editInput;
	done: typeof doneInput;
	comment: typeof commentInput;
	workLog: typeof workLogInput;
	context: typeof contextInput;
	upstreamLink: typeof upstreamLinkInput;
	linkList: typeof linkListInput;
	upstreamList: typeof upstreamListInput;
	logList: typeof logListInput;
};

/** Every tool, in the order an agent should discover them. */
export const KABANE_TOOLS: readonly ToolDef[] = [
	scopeList,
	add,
	apply,
	get,
	list,
	search,
	today,
	context,
	edit,
	done,
	link,
	linkList,
	comment,
	workLog,
	logList,
	contextAdd,
	contextList,
	contextRemove,
	upstreamLink,
	upstreamList,
	upstreamUnlink,
];

/** Server-level instructions sent on initialize. */
export const SERVER_INSTRUCTIONS = `Kabane is a shared work queue for humans and agent runtimes.
Three kinds of item: 'task' is human GTD work (inbox → next → done); 'issue' is work an agent runtime picks up; 'job' is a standing request a schedule runs, which a listing leaves out unless it names kind job.
To brainstorm into work: kabane_add with kind issue, a description that is the brief, state next, and assignee set to the runtime (claude, hermes, codex).
To pick up work as a runtime: kabane_list with responseFormat concise, your assignee and state next (follow nextCursor with the same filters), kabane_context on the chosen id, kabane_edit to in_progress with responseFormat concise, then kabane_log and kabane_comment as you go, kabane_done with responseFormat concise at the end. Use kabane_get for full fields; omitted/full formats remain legacy and unbounded.
Scopes are the context boundary (a repo, a client). Discover them with kabane_scopeList and pass scopeUri on writes.
When a task has a twin in Linear or GitHub, record it with kabane_upstream_link and put what the external issue says into the task's own description — the link is identity only, so nothing stored on it can go stale.`;
