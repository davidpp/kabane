// A harness permission request, relayed to the human unchanged. The loop is a thin wrapper over
// the user's own harness: whatever their settings make it ask in an interactive session, it asks
// here, and the human answers. The loop never approves or declines on its own.
//
// The request becomes a `question` activity on the asking claim's core session, carrying the
// harness's options verbatim, which moves the session to `awaiting_input` and onto
// `getNeedsInput` (the board's `!` and banner). The relay then waits for the `decision`
// `Planner.answerQuestion` writes, maps it back to the harness's option id, and answers the
// harness with it. A run that stops while it waits cancels the request through ACP instead.
import type { AcpClient } from "@cabane/acp";
import {
	type AgentActivity,
	err,
	formatQuestionBody,
	isAnswerTo,
	ok,
	type PermissionRequestMeta,
	Planner,
	type Result,
} from "@cabane/core";
import type { RunStore } from "./store";

export namespace Permission {
	type Option = PermissionRequestMeta["options"][number];

	/** The question body: the tool call's title, the harness's options verbatim, their labels as choices. */
	export const body = (
		harness: string,
		request: AcpClient.PermissionRequest,
	): string => {
		const options = request.options.map((o) => ({
			id: o.id,
			label: o.name,
			kind: o.kind,
		}));
		return formatQuestionBody(`${harness} asks to run: ${request.title}`, {
			choices: options.map((o) => o.label),
			multiSelect: false,
			allowFreeform: false,
			permission: {
				toolCallId: request.toolCallId,
				title: request.title,
				options,
			},
		});
	};

	/**
	 * The choice an answer names: its id, its label in any case, or its 1-based position, in
	 * that order. Undefined when it names none, which is never read as a refusal.
	 */
	export const choose = <T extends { label: string; id?: string }>(
		choices: readonly T[],
		answer: string,
	): T | undefined => {
		const given = answer.trim();
		const position = /^[1-9]\d*$/.test(given) ? Number(given) : 0;
		return (
			choices.find((c) => c.id === given) ??
			choices.find((c) => c.label.toLowerCase() === given.toLowerCase()) ??
			choices[position - 1]
		);
	};

	type Deps = {
		basePath: string;
		sessionId: string;
		harness: string;
		/** What the question's `context` says about where it comes from. */
		origin: string;
		/** Aborted when the claim is cancelled or closed: the request is then cancelled, not answered. */
		signal: AbortSignal;
		emit: (
			draft: Omit<RunStore.EventDraft, "lane" | "session" | "task">,
		) => void;
		/** Who answered a question, when the answering surface noted it in the run's inbox. */
		answeredBy: (questionId: string) => string | undefined;
		now: () => Date;
		pollMs?: number;
	};

	const POLL_MS = 1_000;

	// Resolves after `ms`, or as soon as `signal` aborts.
	const pause = (ms: number, signal: AbortSignal): Promise<void> =>
		new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			signal.addEventListener("abort", done, { once: true });
		});

	/**
	 * The latest `decision` answering `questionId`, once there is one; undefined when `signal`
	 * aborts first. A failed read is reported once and retried: it is never taken as an answer.
	 */
	const awaitAnswer = async (
		deps: Pick<Deps, "basePath" | "sessionId" | "signal" | "emit" | "pollMs">,
		questionId: string,
	): Promise<AgentActivity | undefined> => {
		let reported = "";
		while (!deps.signal.aborted) {
			const activities = await Planner.getActivities(
				deps.basePath,
				deps.sessionId,
			);
			if (activities.ok) {
				const answer = activities.value.findLast(
					(a) => a.type === "decision" && isAnswerTo(a.context, questionId),
				);
				if (answer) return answer;
			} else if (activities.error.message !== reported) {
				reported = activities.error.message;
				deps.emit({
					type: "warning",
					summary: `question ${questionId} not read: ${reported}`,
				});
			}
			await pause(deps.pollMs ?? POLL_MS, deps.signal);
		}
		return undefined;
	};

	const ask = (deps: Deps, text: string): Promise<Result<AgentActivity>> =>
		Planner.addActivity(deps.basePath, {
			sessionId: deps.sessionId,
			type: "question",
			context: deps.origin,
			body: text,
		});

	const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

	/**
	 * Put `request` to the human and wait for their answer: the harness's option id, or an error
	 * when the claim is cancelled first, which the ACP client sends as `cancelled`. An answer that
	 * names no option is asked again rather than guessed at.
	 */
	export const relay = async (
		deps: Deps,
		request: AcpClient.PermissionRequest,
	): Promise<Result<string>> => {
		const text = body(deps.harness, request);
		const options: Option[] = request.options.map((o) => ({
			id: o.id,
			label: o.name,
			kind: o.kind,
		}));
		const askedAt = deps.now().getTime();
		let question = await ask(deps, text);
		for (;;) {
			if (!question.ok) {
				deps.emit({
					type: "error",
					summary: `permission not relayed, so the request is cancelled: ${request.title}: ${question.error.message}`,
				});
				return question;
			}
			const questionId = question.value.id;
			deps.emit({
				type: "permission_asked",
				summary: `${request.title}: ${options.map((o) => o.label).join(" / ")} (question ${questionId})`,
				data: {
					questionId,
					toolCallId: request.toolCallId,
					options: options.map((o) => `${o.id}:${o.kind}`).join(","),
				},
			});
			const answer = await awaitAnswer(deps, questionId);
			const waitedMs = deps.now().getTime() - askedAt;
			if (!answer) {
				deps.emit({
					type: "permission_cancelled",
					summary: `${request.title}: the run stopped after ${seconds(waitedMs)} waiting on a human; the request is cancelled, not answered`,
					data: { questionId, toolCallId: request.toolCallId, waitedMs },
				});
				return err(new Error("cancelled while waiting on a human"));
			}
			const chosen = choose(options, answer.body);
			if (chosen) {
				const by = deps.answeredBy(questionId) ?? "unrecorded";
				deps.emit({
					type: "permission_answered",
					summary: `${request.title}: ${chosen.label} (${chosen.kind}) by ${by} after ${seconds(waitedMs)}`,
					data: {
						questionId,
						toolCallId: request.toolCallId,
						optionId: chosen.id,
						optionKind: chosen.kind,
						by,
						waitedMs,
					},
				});
				return ok(chosen.id);
			}
			deps.emit({
				type: "warning",
				summary: `answer "${answer.body}" to question ${questionId} names none of ${options.map((o) => o.label).join(" / ")}; asked again`,
			});
			question = await ask(deps, text);
		}
	};
}
