// The loop's side of a tracker question it relays for a harness: put it on the claim's core
// session, wait for the human's answer, and close what nobody is left to answer. A question is a
// core `question` activity, so it moves the session to `awaiting_input` and onto `getNeedsInput`
// (the board's `!` and banner); its answer is whatever activity carries `answers <questionId>`.
// The loop never writes an answer: closing a question is a `withdrawn` activity, which every
// queue lets go of as of an answer and which is no decision.
import {
	type AgentActivity,
	answersContext,
	isAnswerTo,
	Planner,
	type Result,
} from "@cabane/core";
import type { RunStore } from "./store";

export namespace Questions {
	export type Deps = {
		basePath: string;
		sessionId: string;
		harness: string;
		/** What the question's `context` says about where it comes from. */
		origin: string;
		/** Aborted when the claim is cancelled or closed: nobody is left to answer for. */
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

	export const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

	export const ask = (
		deps: Deps,
		body: string,
	): Promise<Result<AgentActivity>> =>
		Planner.addActivity(deps.basePath, {
			sessionId: deps.sessionId,
			type: "question",
			context: deps.origin,
			body,
		});

	/**
	 * The latest answer to each of `questionIds` that has one, as soon as one does; undefined when
	 * `signal` aborts first. A failed read is reported once and retried: it is never taken as an
	 * answer.
	 */
	export const awaitAnswers = async (
		deps: Pick<Deps, "basePath" | "sessionId" | "emit" | "pollMs">,
		questionIds: readonly string[],
		signal: AbortSignal,
	): Promise<Map<string, AgentActivity> | undefined> => {
		let reported = "";
		while (!signal.aborted) {
			const activities = await Planner.getActivities(
				deps.basePath,
				deps.sessionId,
			);
			if (activities.ok) {
				const answers = new Map<string, AgentActivity>();
				for (const id of questionIds) {
					const answer = activities.value.findLast((a) =>
						isAnswerTo(a.context, id),
					);
					if (answer) answers.set(id, answer);
				}
				if (answers.size > 0) return answers;
			} else if (activities.error.message !== reported) {
				reported = activities.error.message;
				deps.emit({
					type: "warning",
					summary: `question ${questionIds.join(", ")} not read: ${reported}`,
				});
			}
			await pause(deps.pollMs ?? POLL_MS, signal);
		}
		return undefined;
	};

	/**
	 * Close each of `questionIds` that nothing answers yet with a `withdrawn` activity whose body
	 * is `why`, so no surface keeps asking a human for an answer nobody reads. One the human
	 * answered meanwhile keeps its answer. A session that has ended is already off every queue,
	 * so a close that loses the race to its end is no failure.
	 */
	export const withdraw = async (
		deps: Pick<Deps, "basePath" | "sessionId" | "emit">,
		questionIds: readonly string[],
		why: string,
	): Promise<void> => {
		if (questionIds.length === 0) return;
		const activities = await Planner.getActivities(
			deps.basePath,
			deps.sessionId,
		);
		const answered = (id: string) =>
			activities.ok && activities.value.some((a) => isAnswerTo(a.context, id));
		for (const id of questionIds.filter((q) => !answered(q))) {
			const closed = await Planner.addActivity(deps.basePath, {
				sessionId: deps.sessionId,
				type: "withdrawn",
				context: answersContext(id),
				body: why,
			});
			if (closed.ok || (await ended(deps, deps.sessionId))) continue;
			deps.emit({
				type: "warning",
				summary: `question ${id} not closed (${why}): ${closed.error.message}`,
			});
		}
	};

	const ended = async (
		deps: Pick<Deps, "basePath">,
		sessionId: string,
	): Promise<boolean> => {
		const session = await Planner.getSession(deps.basePath, sessionId);
		return session.ok && session.value?.endedAt !== undefined;
	};

	/** Why a question closed unanswered: the claim stopped, or the harness withdrew it. */
	export const closedBecause = (
		deps: Pick<Deps, "signal" | "harness">,
	): { stopped: boolean; why: string } =>
		deps.signal.aborted
			? { stopped: true, why: "withdrawn: the loop stopped this claim" }
			: { stopped: false, why: `withdrawn by the harness (${deps.harness})` };

	/** Both reasons to stop waiting on a human: the claim stopped, or the harness withdrew. */
	export const either = (
		deps: Pick<Deps, "signal">,
		withdrawn: AbortSignal,
	): AbortSignal => AbortSignal.any([deps.signal, withdrawn]);
}
