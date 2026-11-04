// A harness permission request, relayed to the human unchanged. The loop is a thin wrapper over
// the user's own harness: whatever their settings make it ask in an interactive session, it asks
// here, and the human answers. The loop never approves or declines on its own.
//
// The request becomes a `question` activity on the asking claim's core session, carrying the
// harness's options verbatim, which moves the session to `awaiting_input` and onto
// `getNeedsInput` (the board's `!` and banner). The relay then waits for the answer
// `Planner.answerQuestion` writes, maps it back to the harness's option id, and answers the
// harness with it. A run that stops while it waits, or a harness that withdraws the request,
// cancels it through ACP instead and closes the question as withdrawn (`questions.ts`).
import type { AcpClient } from "@cabane/acp";
import {
	err,
	formatQuestionBody,
	ok,
	type PermissionRequestMeta,
	type Result,
} from "@cabane/core";
import { Questions } from "./questions";

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

	/**
	 * Put `request` to the human and wait for their answer: the harness's option id, or an error
	 * when the claim is cancelled first or the harness withdraws the request (`withdrawn`), which
	 * the ACP client sends as `cancelled`. Either way the question closes as withdrawn rather
	 * than waiting on a human for an answer nobody reads. An answer that names no option is asked
	 * again rather than guessed at.
	 */
	export const relay = async (
		deps: Questions.Deps,
		request: AcpClient.PermissionRequest,
		withdrawn: AbortSignal,
	): Promise<Result<string>> => {
		const text = body(deps.harness, request);
		const options: Option[] = request.options.map((o) => ({
			id: o.id,
			label: o.name,
			kind: o.kind,
		}));
		const waiting = Questions.either(deps, withdrawn);
		const askedAt = deps.now().getTime();
		let question = await Questions.ask(deps, text);
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
			const answer = (
				await Questions.awaitAnswers(deps, [questionId], waiting)
			)?.get(questionId);
			const waitedMs = deps.now().getTime() - askedAt;
			if (!answer) {
				const closed = Questions.closedBecause(deps, withdrawn);
				await Questions.withdraw(deps, [questionId], closed.why);
				deps.emit(
					closed.stopped
						? {
								type: "permission_cancelled",
								summary: `${request.title}: the run stopped after ${Questions.seconds(waitedMs)} waiting on a human; the request is cancelled, not answered`,
								data: { questionId, toolCallId: request.toolCallId, waitedMs },
							}
						: {
								type: "permission_withdrawn",
								summary: `${request.title}: ${closed.why} after ${Questions.seconds(waitedMs)}; its question is closed, not answered`,
								data: { questionId, toolCallId: request.toolCallId, waitedMs },
							},
				);
				return err(new Error(closed.why));
			}
			const chosen = choose(options, answer.body);
			if (chosen) {
				const by = deps.answeredBy(questionId) ?? "unrecorded";
				deps.emit({
					type: "permission_answered",
					summary: `${request.title}: ${chosen.label} (${chosen.kind}) by ${by} after ${Questions.seconds(waitedMs)}`,
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
			question = await Questions.ask(deps, text);
		}
	};
}
