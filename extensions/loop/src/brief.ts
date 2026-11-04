// What a session is told. The issue's own brief comes from `assembleContext`; this adds only what
// the run knows and the issue does not. An implementing session hears that it is one of several,
// which subtask is its own, and how it signals that it is finished (on a single issue, that the
// issue is the whole run); a lens hears what it reviews
// and how it files findings; the fixer hears which findings are its own, in what order, and how
// it settles each. The kabane tool loop itself is the MCP server's to describe, so it is not
// restated.
import { CopilotInstructions } from "@cabane/acp";
import type { Task } from "@cabane/core";
import type { Gates } from "./gates";
import { LoopPlan } from "./plan";

export namespace Brief {
	type Subject = {
		runId: string;
		parent: Task;
		task: Task;
		retry?: Gates.Result;
		interrupted?: Interrupted;
	};

	/**
	 * An attempt the runner's death cut short, as the tracker and the tree show it now: what the
	 * attempt that takes over is told, so it continues rather than restarts.
	 */
	export type Interrupted = {
		lane: string;
		startedAt: string;
		/** The harness session it ran in; absent on a claim recorded before it was kept. */
		acpSessionId?: string;
		/** Its task's work-log entries since it started, one line each. */
		logged: readonly string[];
		/** `git log --oneline` since it started; empty when it made no commit. */
		commits: string;
		/** `git status --short` now; empty when the tree is clean. */
		status: string;
	};

	const label = (task: Task): string => task.shortId ?? task.id;

	// The session's own server is not the only kabane one it may see: the harness also loads the
	// human's configured `kabane`, which is unscoped and may point at another home.
	const SERVER = `Your kabane_* tools are the ones of the ${CopilotInstructions.SERVER_NAME} MCP server. A server named kabane from your harness's own config may also be loaded; it is not tied to this run, so do not use it.`;

	// How the session finishes, parks, and hands off what it should not do: the same for a subtask
	// and a single issue, but for where outside work goes.
	const finishing = (task: Task, outside: string, noun: string): string[] => [
		`${SERVER} Use them for tracker state: kabane_log for what you changed (commits, files), kabane_comment for decisions and blockers. When the ${noun} is implemented and you have verified it, call kabane_done on ${label(task)}. That is how the run knows you are finished; ending your turn without it means the ${noun} is still open.`,
		`If you find work outside your ${noun}, ${outside} If you are blocked, call kabane_edit on ${label(task)} with state "waiting", explain the blocker with kabane_comment, then end your turn. The task stays parked until explicitly moved to state "next"; resolving a dependency alone does not unpark it.`,
		"Finish each turn with at most three lines saying what you did.",
	];

	const instructions = ({ runId, parent, task }: Subject): string =>
		(task.id === parent.id
			? [
					`You are the implementing session of kabane loop run ${runId}, which drives the single issue ${label(task)} ("${task.title}") to completion.`,
					`Your issue is ${label(task)}. Work on it and nothing else. Its brief follows, assembled from the tracker.`,
					// A child would make the issue a parent, whose subtasks the run then works instead.
					...finishing(
						task,
						`add it with kabane_add with kind "issue" and link it to ${label(task)} with kabane_link instead of doing it. Do not make it a child of ${label(task)}: a human decides when it runs.`,
						"issue",
					),
				]
			: [
					`You are one implementing session of kabane loop run ${runId}, which drives the subtasks of ${label(parent)} ("${parent.title}") to completion. Other sessions may be working on sibling subtasks in the same repository at the same time.`,
					`Your subtask is ${label(task)}. Work on it and nothing else. Its brief follows, assembled from the tracker.`,
					...finishing(
						task,
						`add it with kabane_add as a child of ${label(parent)} with kind "issue", so the run can claim it, and link it with kabane_link instead of doing it.`,
						"subtask",
					),
				]
		).join("\n\n");

	// Why the subtask is open again: the gate its last session's work failed, and how.
	const retried = (task: Task, gate: Gates.Result): string =>
		[
			`${label(task)} was closed before, then reopened: the \`${gate.name}\` gate (\`${gate.command}\`) failed ${gate.exit === null ? "to finish" : `with exit ${gate.exit}`} on that work. Make it pass before you call kabane_done again. The end of its output:`,
			`\`\`\`\n${gate.tail}\n\`\`\``,
		].join("\n\n");

	const fence = (text: string): string => `\`\`\`\n${text.trimEnd()}\n\`\`\``;

	const left = (attempt: Interrupted): string =>
		[
			attempt.logged.length > 0
				? `What it logged in the tracker:\n${attempt.logged.map((line) => `- ${line}`).join("\n")}`
				: "It logged nothing in the tracker.",
			attempt.commits
				? `Commits since it started:\n${fence(attempt.commits)}`
				: "It made no commit.",
			attempt.status
				? `Uncommitted changes in the tree now (\`git status --short\`):\n${fence(attempt.status)}`
				: "The tree has no uncommitted changes.",
		].join("\n\n");

	// For a new session taking over: the conversation is gone, the work may not be.
	const takeover = (attempt: Interrupted): string =>
		[
			`This work was started before, by attempt ${attempt.lane} (from ${attempt.startedAt}), which was interrupted: the kabane loop runner exited while its session was open, and that session could not be resumed. Its work may already be in the tree. Continue from what it left rather than starting over: look at what is there before you redo anything, and do not file or log again what it already did.`,
			left(attempt),
		].join("\n\n");

	/** The first prompt of an interrupted session its harness resumed: its last turn was cut short. */
	export const resumed = (attempt: Interrupted): string =>
		[
			`The kabane loop runner exited while your last turn was running, and has restarted. This is the same session, resumed, so your instructions and everything said so far still hold. That turn was cut short: its last tool call may not have finished, and if it shows as rejected or cancelled, the restart cut it, nobody refused it. Check the state below, then continue where you left off, retrying that call if it is still needed.`,
			left(attempt),
		].join("\n\n");

	/**
	 * The opening prompt: the run's instructions, a failed gate to fix, the attempt it takes over,
	 * then the issue's own brief.
	 */
	export const opening = (subject: Subject, assembled: string): string =>
		[
			instructions(subject),
			...(subject.retry ? [retried(subject.task, subject.retry)] : []),
			...(subject.interrupted ? [takeover(subject.interrupted)] : []),
			assembled,
		].join("\n\n---\n\n");

	type Lens = {
		runId: string;
		parent: Task;
		lens: string;
		prompt: string;
		gates: readonly string[];
		interrupted?: Interrupted;
	};

	// What has checked the work before the lens sees it. A run with no gates has run nothing, and
	// saying otherwise would have the lens skip the very checks nobody made.
	const checked = (gates: readonly string[]): string =>
		gates.length > 0
			? `Its gates (${gates.map((g) => `\`${g}\``).join(", ")}) pass on the tree you are reviewing.`
			: "No gates are configured for this run, so nothing has run the project's checks on the result: do not assume they pass.";

	// How a lens reports: findings are child issues of the parent, through kabane MCP, tagged so
	// the run reads them back structurally. It is the run's part of every lens, so a repository's
	// own lens cannot leave it out.
	const filing = ({ runId, parent, lens, gates }: Lens): string =>
		[
			`You are the \`${lens}\` verifier of kabane loop run ${runId} on ${label(parent)} ("${parent.title}"). Its work is done. ${checked(gates)} Review the result through the lens below and file what you find. Do not change files and do not fix anything: once every lens has reviewed, one fixer session works through all the findings.`,
			`${SERVER} File each finding with kabane_add: kind "issue", state "next", parentTaskId "${label(parent)}", tags ["finding", "<severity>", "${lens}"] where severity is p1, p2 or p3 as the lens defines them, a title that names the problem, and a description with the evidence and what fixed looks like. The fixer takes every finding, most severe first, and a human reads the severities, so grade by the lens's definitions as written: a finding that meets the p1 definition is p1 even when the fix is small, and one that does not stays p2 or p3. Before filing, check kabane_list for findings already under ${label(parent)} and do not file one twice.`,
			"When everything is filed, end your turn with one line: how many findings you filed at each severity.",
		].join("\n\n");

	/** A lens's prompt: how to file, the review it takes over, the lens itself, then the parent's own brief. */
	export const lens = (subject: Lens, assembled: string): string =>
		[
			filing(subject),
			...(subject.interrupted ? [takeover(subject.interrupted)] : []),
			subject.prompt.trim(),
			assembled,
		].join("\n\n---\n\n");

	type Fixer = {
		runId: string;
		parent: Task;
		/** In the order to work them. */
		findings: readonly Task[];
		gates: readonly string[];
		interrupted?: Interrupted;
	};

	const listed = (finding: Task): string =>
		`- ${label(finding)} · ${LoopPlan.severityOf(finding) ?? "unrated"} · ${LoopPlan.lensOf(finding) ?? "no lens"} · ${finding.title}`;

	// What runs on the fixer's result once it ends: the gates, or nothing.
	const after = (gates: readonly string[]): string =>
		gates.length > 0
			? `When you end, the run's gates (${gates.map((g) => `\`${g}\``).join(", ")}) run on the result: leave them passing.`
			: "No gates are configured for this run, so nothing runs the project's checks on your result: run the relevant ones yourself before you close a finding.";

	/**
	 * The fixer's prompt: its findings and how to settle each, the attempt it takes over, then the
	 * parent's own brief.
	 */
	export const fixer = (
		{ runId, parent, findings, gates, interrupted }: Fixer,
		assembled: string,
	): string =>
		[
			[
				`You are the fixer session of kabane loop run ${runId} on ${label(parent)} ("${parent.title}"), whose work is done. Its verifier lenses reviewed the result and filed the findings below as child issues of ${label(parent)}. They are all yours, and no other session works in the repository meanwhile. Work through them in this order, most severe first:`,
				findings.map(listed).join("\n"),
				`For each finding: read its brief with kabane_context, fix it, verify the fix, log what you changed with kabane_log on it, then call kabane_done on it. Close only a finding you fixed. If a finding is wrong, already fixed, or outside ${label(parent)}'s scope, do not change code for it and do not close it: say why with kabane_comment on it, then call kabane_edit on it with state "waiting", so it stays open for a human. ${after(gates)}`,
				`Do not file findings. If fixing one turns up other work, add it with kabane_add as a child of ${label(parent)} with kind "issue" instead of doing it.`,
				"When every finding is closed or waiting, end your turn with one line per finding: fixed, or why it was left.",
			].join("\n\n"),
			...(interrupted ? [takeover(interrupted)] : []),
			assembled,
		].join("\n\n---\n\n");

	/** The nudge for a fixer turn that ended with findings it has not settled. */
	export const fixerContinuation = (left: readonly Task[]): string =>
		`${left.map(label).join(", ")} ${left.length === 1 ? "is" : "are"} still open. Continue: fix each and call kabane_done on it, or say why it is left with kabane_comment and call kabane_edit on it with state "waiting".`;

	/** The nudge for a turn that ended with its subtask, or its single issue, still open. */
	export const continuation = (task: Task): string =>
		`${label(task)} is still open. Continue the work. If it is finished and verified, call kabane_done on ${label(task)}. If you are blocked, call kabane_edit on ${label(task)} with state "waiting", explain the blocker with kabane_comment, then end your turn. It stays parked until explicitly moved to state "next".`;
}
