/**
 * Rendering — one place that knows about `--json` and icons.
 *
 * Commands return an `Outcome` (`@cabane/extension`): an exit code, a JSON
 * value, and the human text. `main` prints one or the other.
 */

import {
	Deadline,
	Runtime,
	type Task,
	type TaskComment,
	type TaskLink,
	type TaskPriority,
	type TaskState,
	type TaskWorkLog,
} from "@cabane/core";
import type { Outcome } from "@cabane/extension";

const STATE_ICONS: Record<TaskState, string> = {
	inbox: "📥",
	next: "⏭️",
	in_progress: "🔄",
	waiting: "⏸️",
	someday: "💭",
	done: "✅",
	cancelled: "❌",
};

const PRIORITY_ICONS: Record<TaskPriority, string> = {
	urgent: "🔴",
	high: "🟠",
	normal: "🟡",
	low: "🟢",
};

const displayId = (task: Pick<Task, "id" | "shortId">): string =>
	task.shortId ?? task.id;

export const formatTaskLine = (task: Task): string => {
	const deadline = task.deadline
		? ` 📅 ${Deadline.format(task.deadline, Runtime.timezone())}`
		: "";
	const tags = task.tags.length > 0 ? ` [${task.tags.join(", ")}]` : "";
	const assignee = task.assignee ? ` @${task.assignee}` : "";
	const review = task.needsReview ? " 👀" : "";
	const subtask = task.parentTaskId ? " ↳" : "";
	const kind = task.kind === "issue" ? "🔧" : "";
	return `${subtask}${STATE_ICONS[task.state]} ${PRIORITY_ICONS[task.priority]} ${kind}${displayId(task)}  ${task.title}${assignee}${review}${deadline}${tags}`;
};

export const formatTaskList = (
	tasks: Task[],
	empty = "No tasks found.",
): string =>
	tasks.length === 0 ? empty : tasks.map(formatTaskLine).join("\n");

export const formatTaskDetail = (task: Task): string => {
	const lines: string[] = [];
	if (task.shortId) {
		lines.push(`ID: ${task.shortId}`, `ULID: ${task.id}`);
	} else {
		lines.push(`ID: ${task.id}`);
	}
	lines.push(`Title: ${task.title}`);
	if (task.description) lines.push(`Description: ${task.description}`);
	lines.push(
		`Kind: ${task.kind}`,
		`State: ${task.state}`,
		`Priority: ${task.priority}`,
	);
	if (task.scopeUri) lines.push(`Scope: ${task.scopeUri}`);
	if (task.parentTaskId) lines.push(`Parent: ${task.parentTaskId}`);
	if (task.projectId) lines.push(`Project: ${task.projectId}`);
	if (task.assignee) lines.push(`Assignee: ${task.assignee}`);
	if (task.deadline)
		lines.push(
			`Deadline: ${Deadline.format(task.deadline, Runtime.timezone())}`,
		);
	if (task.deferUntil) lines.push(`Deferred until: ${task.deferUntil}`);
	if (task.tags.length > 0) lines.push(`Tags: ${task.tags.join(", ")}`);
	if (task.needsReview) lines.push("Needs review: yes");
	lines.push(
		`Source: ${task.provenance.source}${task.provenance.discoveredBy ? ` (${task.provenance.discoveredBy})` : ""}`,
	);
	lines.push(`Created: ${task.createdAt}`, `Updated: ${task.updatedAt}`);
	if (task.completedAt) lines.push(`Completed: ${task.completedAt}`);
	return lines.join("\n");
};

export const formatLinks = (taskId: string, links: TaskLink[]): string =>
	links
		.map((link) => {
			const outbound = link.sourceId === taskId;
			const other = outbound ? link.targetId : link.sourceId;
			const arrow = outbound ? `→ [${link.type}] →` : `← [${link.type}] ←`;
			return `  ${arrow} ${other}${link.note ? `  (${link.note})` : ""}`;
		})
		.join("\n");

export const formatComments = (comments: TaskComment[]): string =>
	comments
		.map(
			(c) =>
				`  ${c.authorType === "ai" ? "🤖" : "👤"} ${c.author} · ${c.createdAt.slice(0, 16)}\n    ${c.content.replace(/\n/g, "\n    ")}`,
		)
		.join("\n");

export const formatWorkLogs = (logs: TaskWorkLog[]): string =>
	logs
		.map((log) => {
			const refs = log.refs.map((r) => r.uri).join(", ");
			return `  ${log.createdAt.slice(0, 16)}  ${refs}${log.note ? `\n    ${log.note}` : ""}`;
		})
		.join("\n");

export const print = (outcome: Outcome, json: boolean): void => {
	const text = json
		? JSON.stringify(outcome.json, null, outcome.compact ? undefined : 2)
		: outcome.text;
	// An empty text is a command that owned stdout itself (`mcp`); stay silent.
	if (text.length === 0) return;
	if (outcome.compact && outcome.exitCode === 0) {
		process.stdout.write(text);
		return;
	}
	if (outcome.exitCode === 0) {
		console.log(text);
	} else {
		console.error(text);
	}
};
