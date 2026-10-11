// What a session is told. The issue's own brief comes from `assembleContext`; this adds only what
// the run knows and the issue does not. An implementing session hears that it is one of several,
// which subtask is its own, and how it signals that it is finished; a lens hears what it reviews
// and how it files findings. The kabane tool loop itself is the
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

	type Lens = { runId: string; parent: Task; lens: string; prompt: string };

	// How a lens reports: findings are child issues of the parent, through kabane MCP, tagged so
	// the run reads them back structurally. It is the run's part of every lens, so a repository's
	// own lens cannot leave it out.
	const filing = ({ runId, parent, lens }: Lens): string =>
		[
			`You are the \`${lens}\` verifier of kabane loop run ${runId}, which drove the subtasks of ${label(parent)} ("${parent.title}") to completion. The plan is done and the project's gates pass. Review the result through the lens below and file what you find. Do not change files and do not fix anything: a finding is work for an implementing session.`,
			`File each finding with kabane_add: kind "issue", state "next", parentTaskId "${label(parent)}", tags ["finding", "<severity>", "${lens}"] where severity is p1, p2 or p3 as the lens defines them, a title that names the problem, and a description with the evidence and what fixed looks like. A p1 keeps the run open until it is fixed, so file p1 only for what must be fixed before this work is done. Before filing, check kabane_list for findings already under ${label(parent)} and do not file one twice.`,
			"When everything is filed, end your turn with one line: how many findings you filed at each severity.",
		].join("\n\n");

	/** A lens's prompt: how to file, the lens itself, then the parent's own brief. */
	export const lens = (subject: Lens, assembled: string): string =>
		[filing(subject), subject.prompt.trim(), assembled].join("\n\n---\n\n");

	/** The nudge for a turn that ended with the subtask still open. */
	export const continuation = (task: Task): string =>
		`${label(task)} is still open. Continue the work. If it is finished and verified, call kabane_done on ${label(task)}. If you are blocked, comment the blocker on ${label(task)} and end your turn.`;
}
