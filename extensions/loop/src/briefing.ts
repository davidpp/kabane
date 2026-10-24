// What the board's trigger form shows before a loop starts: the plan as the tracker holds it right
// now, which subtasks a free slot would claim first and what each of the others waits on, the
// longest chain of blockers, and what could go wrong. Pure over a loaded plan and the risks core
// `lint` found, so it is the same plan the runner will read on its first tick.
import type { PanelLine, PanelPart } from "@cabane/board/ports";
import type { Task } from "@cabane/core";
import { LoopPlan } from "./plan";

export namespace Briefing {
	// A title past this many columns is cut so the column of states stays a column.
	const TITLE_COLS = 40;

	const label = (task: Task): string => task.shortId ?? task.id;

	const plural = (count: number, noun: string): string =>
		`${count} ${noun}${count === 1 ? "" : "s"}`;

	const tasksOf = (plan: LoopPlan.Plan): Map<string, Task> => {
		const map = new Map(plan.outside);
		for (const n of plan.nodes) map.set(n.task.id, n.task);
		return map;
	};

	/**
	 * The longest chain of open work in blocking order, first to do first, as short ids. A cycle
	 * contributes no chain through itself: the deadlock is reported as a risk instead.
	 */
	export const criticalPath = (plan: LoopPlan.Plan): string[] => {
		const open = new Map(
			plan.nodes
				.filter((n) => LoopPlan.isWork(n) && !LoopPlan.isClosed(n.task))
				.map((n) => [n.task.id, n]),
		);
		const memo = new Map<string, LoopPlan.Node[]>();
		const longest = (
			node: LoopPlan.Node,
			seen: ReadonlySet<string>,
		): LoopPlan.Node[] => {
			const cached = memo.get(node.task.id);
			if (cached) return cached;
			const next = new Set(seen).add(node.task.id);
			let best: LoopPlan.Node[] = [];
			for (const id of node.blockedBy) {
				const blocker = open.get(id);
				if (!blocker || next.has(id)) continue;
				const chain = longest(blocker, next);
				if (chain.length > best.length) best = chain;
			}
			const path = [...best, node];
			memo.set(node.task.id, path);
			return path;
		};
		let best: LoopPlan.Node[] = [];
		for (const node of open.values()) {
			const chain = longest(node, new Set());
			if (chain.length > best.length) best = chain;
		}
		return best.map((n) => label(n.task));
	};

	// Why the run's first tick claims nothing, from the plan itself.
	const planRisks = (plan: LoopPlan.Plan, now: Date): string[] => {
		const health = LoopPlan.health(plan, new Set(), now);
		if (health.kind === "deadlocked")
			return [`deadlocked: ${health.cycle.join(" → ")} block each other`];
		if (health.kind === "waiting")
			return [
				`nothing is ready: waiting on ${health.on.join(", ") || "a blocker"}`,
			];
		return [];
	};

	// Where a subtask stands: closed, ready, what it waits on (every open blocker, in full), or the
	// state someone parked it in.
	const statusOf = (
		node: LoopPlan.Node,
		ready: ReadonlySet<string>,
		tasks: Map<string, Task>,
	): PanelPart => {
		const { task } = node;
		if (LoopPlan.isClosed(task)) return { text: task.state, tone: "done" };
		if (ready.has(task.id)) return { text: "ready", tone: "working" };
		const waitingOn = node.blockedBy.flatMap((id) => {
			const blocker = tasks.get(id);
			return blocker && !LoopPlan.isClosed(blocker) ? [label(blocker)] : [];
		});
		const state = task.state.replace("_", " ");
		const status = waitingOn.length > 0 ? `← ${waitingOn.join(",")}` : state;
		return {
			text: task.kind === "task" ? `human · ${status}` : status,
			tone: "muted",
		};
	};

	// One subtask's row: its glyph, id, title, and where it stands.
	const row = (
		node: LoopPlan.Node,
		ready: ReadonlySet<string>,
		tasks: Map<string, Task>,
		titleCols: number,
	): PanelLine => {
		const { task } = node;
		const done = LoopPlan.isClosed(task);
		const isReady = ready.has(task.id);
		const title =
			task.title.length > titleCols
				? `${task.title.slice(0, titleCols - 1)}…`
				: task.title;
		const status = statusOf(node, ready, tasks);
		return [
			{
				text: done ? " ✓ " : isReady ? " ● " : " ○ ",
				tone: done ? "done" : isReady ? "working" : "muted",
			},
			{ text: `${label(task)}  `, tone: done ? "muted" : "default" },
			{
				text: `${title.padEnd(titleCols)}  `,
				...(done ? { tone: "muted" as const } : {}),
			},
			status,
		];
	};

	// The gates the run will hold each subtask to, in order. The form cannot edit a named command,
	// so they are read here and set in the repo's file or with `--gate`.
	const gateLines = (gates: Readonly<Record<string, string>>): PanelLine[] => {
		const named = Object.entries(gates);
		const width = Math.max(0, ...named.map(([name]) => name.length));
		return [
			[],
			[
				{ text: `Gates  ${named.length || "none"}`, bold: true },
				{
					text: `  set in .kabane/loop.json or with --gate`,
					tone: "muted",
				},
			],
			...named.map(([name, command]): PanelLine => [
				{ text: ` ${name.padEnd(width)}  `, tone: "muted" },
				{ text: command },
			]),
		];
	};

	const riskLines = (risks: readonly string[]): PanelLine[] =>
		risks.length === 0
			? []
			: [
					[],
					[{ text: `Risks  ${risks.length}`, bold: true, tone: "accent" }],
					...risks.map((risk): PanelLine => [
						{ text: " ! ", tone: "accent" },
						{ text: risk },
					]),
				];

	/**
	 * The plan the run would start on: a row per subtask (findings that are not `p1` are not the
	 * run's), the critical path, and the risks, the plan's own first and then core lint's.
	 */
	export const preview = (
		plan: LoopPlan.Plan,
		gates: Readonly<Record<string, string>>,
		lint: readonly string[],
		now: Date,
	): PanelLine[] => {
		const work = plan.nodes.filter(LoopPlan.isWork);
		const ready = new Set(
			LoopPlan.frontier(plan, new Set(), now).map((n) => n.task.id),
		);
		const tasks = tasksOf(plan);
		const links = work.reduce((sum, n) => sum + n.blockedBy.length, 0);
		const titleCols = Math.min(
			TITLE_COLS,
			Math.max(0, ...work.map((n) => n.task.title.length)),
		);
		const path = criticalPath(plan);
		return [
			[
				{ text: "Plan", bold: true },
				{
					text: `  ${plural(work.length, "subtask")} · ${plural(links, "link")} · ${ready.size} ready`,
					tone: "muted",
				},
			],
			[],
			...work.map((n) => row(n, ready, tasks, titleCols)),
			[],
			[
				{ text: "Critical path  ", bold: true },
				...(path.length === 0
					? [{ text: "nothing open", tone: "muted" as const }]
					: path.flatMap((id, i): PanelPart[] => [
							...(i > 0 ? [{ text: " → ", tone: "muted" as const }] : []),
							{ text: id },
						])),
				{ text: `   ${path.length} deep`, tone: "muted" },
			],
			...gateLines(gates),
			...riskLines([...planRisks(plan, now), ...lint]),
		];
	};
}
