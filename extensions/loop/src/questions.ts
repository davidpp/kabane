// Questions belong to the run. Only the runner writes their journal; human surfaces append answers to its inbox.
import type { Result } from "@cabane/core";
import type { Host } from "@cabane/extension";
import { answersContext, isAnswerTo, parseQuestionBody } from "./question-body";
import { ok } from "./result";
import { RunStore } from "./store";

export namespace Questions {
	export type Deps = {
		home: string;
		runId: string;
		record: Host.Record;
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
	): Promise<Result<RunStore.QuestionEntry>> =>
		Promise.resolve(
			RunStore.recordQuestion(deps.home, deps.runId, {
				sessionId: deps.sessionId,
				type: "question",
				context: deps.origin,
				body,
			}),
		);

	/** Commit human submissions in inbox order, once, before handing them to a harness. */
	const accept = async (
		deps: Pick<Deps, "home" | "runId" | "record" | "sessionId" | "emit">,
	): Promise<Result<void>> => {
		const inbox = RunStore.readInbox(deps.home, deps.runId, 0);
		if (!inbox.ok) return inbox;
		const run = RunStore.readRaw(deps.home, deps.runId);
		if (!run.ok) return run;
		const claim = run.value.claims.find((c) => c.sessionId === deps.sessionId);
		if (!claim || claim.endedAt !== undefined) return ok(undefined);
		for (const entry of inbox.value.entries) {
			if (entry.kind !== "answered" || entry.answer === undefined) continue;
			const current = RunStore.questionEntries(deps.home, deps.runId);
			if (!current.ok) return current;
			const question = current.value.find(
				(q) =>
					q.id === entry.questionId &&
					q.sessionId === deps.sessionId &&
					q.type === "question",
			);
			if (
				!question ||
				current.value.some((a) => isAnswerTo(a.context, question.id))
			)
				continue;
			const parsed = parseQuestionBody(question.body);
			const written = RunStore.recordQuestion(deps.home, deps.runId, {
				sessionId: deps.sessionId,
				type: parsed.permission ? "answer" : "decision",
				body: entry.answer,
				context: answersContext(question.id),
				by: entry.by,
			});
			if (!written.ok) return written;
			if (!parsed.permission) {
				const outcome = await deps.record.comment({
					id: claim.taskId,
					kind: "outcome.decision",
					body: `${parsed.question}\n→ ${entry.answer}`,
				});
				if (!outcome.ok)
					deps.emit({
						type: "warning",
						summary: `decision not recorded: ${outcome.error.message}`,
					});
			}
		}
		return ok(undefined);
	};

	/**
	 * The latest answer to each of `questionIds` that has one, as soon as one does; undefined when
	 * `signal` aborts first, or when one of them is closed as withdrawn with no answer, which
	 * nobody is then left to give. A withdrawal is never taken as an answer, nor is a failed read,
	 * which is reported once and retried.
	 */
	export const awaitAnswers = async (
		deps: Pick<
			Deps,
			"home" | "runId" | "record" | "sessionId" | "emit" | "pollMs"
		>,
		questionIds: readonly string[],
		signal: AbortSignal,
	): Promise<Map<string, RunStore.QuestionEntry> | undefined> => {
		let reported = "";
		while (!signal.aborted) {
			const run = RunStore.readRaw(deps.home, deps.runId);
			if (
				run.ok &&
				run.value.claims.find((c) => c.sessionId === deps.sessionId)
					?.endedAt !== undefined
			)
				return undefined;
			const accepted = await accept(deps);
			const activities = accepted.ok
				? RunStore.questionEntries(deps.home, deps.runId)
				: accepted;
			if (activities.ok) {
				const answers = new Map<string, RunStore.QuestionEntry>();
				let withdrawn = false;
				for (const id of questionIds) {
					const closing = activities.value.filter((a) =>
						isAnswerTo(a.context, id),
					);
					const answer = closing.findLast((a) => a.type !== "withdrawn");
					if (answer) answers.set(id, answer);
					else if (closing.length > 0) withdrawn = true;
				}
				if (answers.size > 0) return answers;
				if (withdrawn) return undefined;
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
		deps: Pick<Deps, "home" | "runId" | "record" | "sessionId" | "emit">,
		questionIds: readonly string[],
		why: string,
	): Promise<void> => {
		if (questionIds.length === 0) return;
		const accepted = await accept(deps);
		if (!accepted.ok) {
			deps.emit({
				type: "warning",
				summary: `questions not closed: ${accepted.error.message}`,
			});
			return;
		}
		const activities = RunStore.questionEntries(deps.home, deps.runId);
		if (!activities.ok) {
			deps.emit({
				type: "warning",
				summary: `questions not read: ${activities.error.message}`,
			});
			return;
		}
		const answered = (id: string) =>
			activities.value.some((a) => isAnswerTo(a.context, id));
		for (const id of questionIds.filter((q) => !answered(q))) {
			const closed = RunStore.recordQuestion(deps.home, deps.runId, {
				sessionId: deps.sessionId,
				type: "withdrawn",
				context: answersContext(id),
				body: why,
			});
			if (closed.ok) continue;
			deps.emit({
				type: "warning",
				summary: `question ${id} not closed (${why}): ${closed.error.message}`,
			});
		}
	};

	/**
	 * Why a question closed unanswered: the claim stopped, the harness withdrew it (`withdrawn`),
	 * or neither, when something outside this claim closed it (a surface that took the runner for
	 * dead).
	 */
	export const closedBecause = (
		deps: Pick<Deps, "signal" | "harness">,
		withdrawn: AbortSignal,
	): { stopped: boolean; why: string } =>
		deps.signal.aborted
			? { stopped: true, why: "withdrawn: the loop stopped this claim" }
			: withdrawn.aborted
				? { stopped: false, why: `withdrawn by the harness (${deps.harness})` }
				: { stopped: false, why: "withdrawn outside this claim" };

	/** Both reasons to stop waiting on a human: the claim stopped, or the harness withdrew. */
	export const either = (
		deps: Pick<Deps, "signal">,
		withdrawn: AbortSignal,
	): AbortSignal => AbortSignal.any([deps.signal, withdrawn]);
}
