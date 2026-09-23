// What the human is looking at, as one structured value: the scope, the section and filters in
// force, the row under the cursor, the `m` working set, and the assembled briefs for those tasks.
// The copilot (sibling issues) prepends `render(ctx)` to every prompt, so this is the one place that
// decides what "the selection" means. `project` and `render` are pure; `load` is the wrapper that
// fetches the briefs.
import { ok, type Result, TASK_STATE_DISPLAY, type Task } from "@cabane/core";
import { BoardData } from "./data";
import { BoardNav } from "./nav";

export namespace BoardContext {
	export type Ref = { id: string; shortId: string; title: string };

	export type Brief = { shortId: string; brief: string };

	export type Filter = {
		kind: BoardNav.KindFilter;
		status: BoardNav.StatusFilter;
		query?: string;
	};

	export type Context = {
		// Absent when the board is on all scopes.
		scopeUri?: string;
		view: "board" | "detail";
		// The selected task's section, when it has one on the board.
		section?: string;
		filter: Filter;
		// The row under the cursor, or the open task in the detail view.
		selected?: Ref;
		// The `m` working set, oldest mark first.
		marked: Ref[];
		// Selected first, then marked; each capped, the whole capped, oldest marks dropped first.
		briefs: Brief[];
		// Whether any brief was cut or dropped to fit the budget.
		truncated: boolean;
	};

	// One brief is bounded the way assembleContext bounds a context ref; the whole block is bounded so
	// a large working set never floods the prompt. Six full briefs fit, then the oldest marks go.
	export const PER_BRIEF_CAP = 6000;
	export const TOTAL_BRIEF_CAP = 24000;

	const refOf = (task: Task): Ref => ({
		id: task.id,
		shortId: task.shortId ?? task.id.slice(0, 8),
		title: task.title,
	});

	const taskById = (
		sections: BoardData.BoardSection[],
		id: string,
	): Task | undefined => {
		for (const section of sections) {
			for (const { task, children } of section.rows) {
				if (task.id === id) return task;
				for (const child of children) if (child.id === id) return child;
			}
		}
		return undefined;
	};

	const sectionOf = (
		sections: BoardData.BoardSection[],
		id: string,
	): string | undefined => {
		for (const section of sections) {
			if (section.rows.some((row) => row.task.id === id))
				return TASK_STATE_DISPLAY[section.state].label.toLowerCase();
		}
		return undefined;
	};

	const selectedIdOf = (state: BoardNav.BoardState): string | null =>
		state.view.type === "detail" ? state.view.taskId : state.selectedId;

	// The task ids whose briefs the context carries, in the order they are rendered: the selected
	// task first, then the marks oldest first, without repeating the selected task if it is marked.
	export const briefIds = (state: BoardNav.BoardState): string[] => {
		const selected = selectedIdOf(state);
		const ids = selected ? [selected] : [];
		for (const id of state.marked) if (id !== selected) ids.push(id);
		return ids;
	};

	const cut = (text: string): { text: string; cut: boolean } =>
		text.length <= PER_BRIEF_CAP
			? { text, cut: false }
			: { text: `${text.slice(0, PER_BRIEF_CAP - 1)}…`, cut: true };

	// Fit the briefs to the budget: cap each, then drop marked briefs oldest first (index 1 onward
	// when the selected task leads) until the total fits. The selected task's brief is never dropped.
	const fitBriefs = (
		refs: Ref[],
		briefsById: ReadonlyMap<string, string>,
		hasSelected: boolean,
	): { briefs: Brief[]; truncated: boolean } => {
		let truncated = false;
		const capped: Brief[] = [];
		for (const ref of refs) {
			const brief = briefsById.get(ref.id);
			if (brief === undefined) continue;
			const c = cut(brief);
			truncated = truncated || c.cut;
			capped.push({ shortId: ref.shortId, brief: c.text });
		}
		const total = (list: Brief[]): number =>
			list.reduce((n, b) => n + b.brief.length, 0);
		const floor = hasSelected ? 1 : 0;
		while (total(capped) > TOTAL_BRIEF_CAP && capped.length > floor) {
			capped.splice(floor, 1);
			truncated = true;
		}
		return { briefs: capped, truncated };
	};

	export const project = (
		state: BoardNav.BoardState,
		scope: BoardData.ScopeInfo | null,
		briefsById: ReadonlyMap<string, string>,
	): Context => {
		const selectedId = selectedIdOf(state);
		const selectedTask = selectedId
			? taskById(state.sections, selectedId)
			: undefined;
		const selected = selectedTask ? refOf(selectedTask) : undefined;
		const marked: Ref[] = [];
		for (const id of state.marked) {
			const task = taskById(state.sections, id);
			if (task) marked.push(refOf(task));
		}
		const query = BoardNav.activeQuery(state.search);
		const refs = selected
			? [selected, ...marked.filter((ref) => ref.id !== selected.id)]
			: marked;
		const { briefs, truncated } = fitBriefs(
			refs,
			briefsById,
			Boolean(selected),
		);
		return {
			scopeUri: state.scoped && scope ? scope.scopeUri : undefined,
			view: state.view.type === "detail" ? "detail" : "board",
			section: selectedId ? sectionOf(state.sections, selectedId) : undefined,
			filter: {
				kind: state.kind,
				status: state.status,
				...(query === "" ? {} : { query }),
			},
			selected,
			marked,
			briefs,
			truncated,
		};
	};

	const refLine = (ref: Ref): string => `${ref.shortId} · ${ref.title}`;

	// The text the copilot reads before the prompt: a fenced field block (one line per field, in a
	// fixed order, so it diffs cleanly across turns), then the briefs under `### <shortId>` headings.
	// Briefs sit outside the fence because they carry fences of their own.
	export const render = (ctx: Context): string => {
		const fields: string[] = [
			`scope: ${ctx.scopeUri ?? "all"}`,
			`view: ${ctx.view}`,
		];
		if (ctx.section) fields.push(`section: ${ctx.section}`);
		const filter = [`kind=${ctx.filter.kind}`, `status=${ctx.filter.status}`];
		if (ctx.filter.query !== undefined)
			filter.push(`query=${JSON.stringify(ctx.filter.query)}`);
		fields.push(`filter: ${filter.join(" ")}`);
		if (ctx.selected) fields.push(`selected: ${refLine(ctx.selected)}`);
		fields.push(
			ctx.marked.length === 0
				? "marked: none"
				: `marked: ${ctx.marked.map(refLine).join("; ")}`,
		);
		if (ctx.truncated) fields.push("truncated: yes");
		const parts = ["```kabane-board", ...fields, "```"];
		for (const { shortId, brief } of ctx.briefs) {
			parts.push("", `### ${shortId}`, "", brief);
		}
		return `${parts.join("\n")}\n`;
	};

	// Fetch the briefs the context needs, then project. A brief that fails to assemble fails the
	// whole load: a copilot turn on a half-described selection is worse than no turn.
	export const load = async (
		basePath: string,
		state: BoardNav.BoardState,
		scope: BoardData.ScopeInfo | null,
	): Promise<Result<Context>> => {
		const briefsById = new Map<string, string>();
		for (const id of briefIds(state)) {
			const brief = await BoardData.taskBrief(basePath, id);
			if (!brief.ok) return brief;
			briefsById.set(id, brief.value);
		}
		return ok(project(state, scope, briefsById));
	};
}
