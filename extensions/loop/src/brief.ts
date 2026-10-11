// What an implementing session is told. The issue's own brief comes from `assembleContext`; this
// adds only what the run knows and the issue does not: that it is one of several sessions, which
// subtask is its own, and how it signals that it is finished. The kabane tool loop itself is the
// MCP server's to describe, so it is not restated.
import type { Task } from "@cabane/core";
import type { Gates } from "./gates";

export namespace Brief {
	type Subject = {
		runId: string;
		parent: Task;
		task: Task;
		retry?: Gates.Result;
	};

	const label = (task: Task): string => task.shortId ?? task.id;

	const instructions = ({ runId, parent, task }: Subject): string =>
		[
			`You are one implementing session of kabane loop run ${runId}, which drives the subtasks of ${label(parent)} ("${parent.title}") to completion. Other sessions may be working on sibling subtasks in the same repository at the same time.`,
			`Your subtask is ${label(task)}. Work on it and nothing else. Its brief follows, assembled from the tracker.`,
			`Use the kabane MCP tools for tracker state: kabane_log for what you changed (commits, files), kabane_comment for decisions and blockers. When the subtask is implemented and you have verified it, call kabane_done on ${label(task)}. That is how the run knows you are finished; ending your turn without it means the subtask is still open.`,
			`If you find work outside your subtask, add it with kabane_add as a child of ${label(parent)} and link it with kabane_link instead of doing it. If you are blocked, comment why on ${label(task)} and end your turn.`,
			"Finish each turn with at most three lines saying what you did.",
		].join("\n\n");

	// Why the subtask is open again: the gate its last session's work failed, and how.
	const retried = (task: Task, gate: Gates.Result): string =>
		[
			`${label(task)} was closed before, then reopened: the \`${gate.name}\` gate (\`${gate.command}\`) failed ${gate.exit === null ? "to finish" : `with exit ${gate.exit}`} on that work. Make it pass before you call kabane_done again. The end of its output:`,
			`\`\`\`\n${gate.tail}\n\`\`\``,
		].join("\n\n");

	/** The opening prompt: the run's instructions, a failed gate to fix, then the issue's own brief. */
	export const opening = (subject: Subject, assembled: string): string =>
		[
			instructions(subject),
			...(subject.retry ? [retried(subject.task, subject.retry)] : []),
			assembled,
		].join("\n\n---\n\n");

	/** The nudge for a turn that ended with the subtask still open. */
	export const continuation = (task: Task): string =>
		`${label(task)} is still open. Continue the work. If it is finished and verified, call kabane_done on ${label(task)}. If you are blocked, comment the blocker on ${label(task)} and end your turn.`;
}
