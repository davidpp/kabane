import {
	atomic,
	Events,
	PLANNER_EVENTS,
	type Task,
	type Db,
	err,
	normalizeScopeUri,
	ok,
	Planner,
	type Result,
	Runtime,
	scopeClause,
	type SqlValue,
	TABLES,
	withDb,
} from "@kabane/core";
import { validateAnswer } from "./answer";
import { formatDecisionBody, parseDecisionBody } from "./body";
import { ANSWER_KIND, ASK_KIND, REPLY_KINDS, WITHDRAW_KIND } from "./kinds";
import {
	AnswerSchema,
	AskSchema,
	type AnswerInput,
	type AskInput,
	type QuestionStatus,
	type QuestionView,
} from "./schema";

/**
 * A question is an entry of kind `questions.ask` on its issue, addressed to
 * the human asked; an answer or a withdrawal is an entry that replies to it
 * (`re`). The newest reply decides its status, answer and reasoning, so a
 * second answer overwrites the first as it did when a row held them.
 */
const REPLIES = REPLY_KINDS.map((kind) => `'${kind}'`).join(", ");

const dataOf = (data: string | null): Record<string, string | undefined> =>
	data === null ? {} : (JSON.parse(data) as Record<string, string>);

const statusOf = (kind: string | null): QuestionStatus =>
	kind === ANSWER_KIND
		? "answered"
		: kind === WITHDRAW_KIND
			? "withdrawn"
			: "open";

type AskRow = {
	id: string;
	thread_id: string;
	author: string;
	body: string;
	data: string | null;
	visibility: string;
	created_at: string;
	updated_by: string | null;
	short_id: string | null;
	title: string;
	priority: string;
	state: string;
	ordinal: number;
	replies: number;
	reply_kind: string | null;
	reply_author: string | null;
	reply_body: string | null;
	reply_data: string | null;
	reply_at: string | null;
	reply_by: string | null;
};

/** Ordinals include closed questions, so answering never renumbers handles. */
const selectQuestions = (
	db: Db,
	filter: {
		taskId?: string;
		scopeUri?: string;
		status?: "open" | "all";
		id?: string;
	} = {},
): QuestionView[] => {
	const where: string[] = [`a.kind = '${ASK_KIND}'`];
	const params: SqlValue[] = [];
	if (filter.id !== undefined) {
		where.push("a.id = ?");
		params.push(filter.id);
	}
	if (filter.taskId !== undefined) {
		where.push("a.thread_id = ?");
		params.push(filter.taskId);
	}
	if (filter.scopeUri !== undefined) {
		const scope = scopeClause(filter.scopeUri, "t.scope_uri");
		where.push(scope.sql);
		params.push(...scope.params);
	}
	if (filter.status === "open") where.push("r.id IS NULL");
	return db
		.query<AskRow, SqlValue[]>(
			`SELECT a.id, a.thread_id, a.author, a.body, a.data, a.visibility, a.created_at, a.updated_by,
			        t.short_id, t.title, t.priority, t.state,
			        (SELECT COUNT(*) FROM ${TABLES.entries} p
			          WHERE p.thread_id = a.thread_id AND p.kind = '${ASK_KIND}' AND p.id <= a.id) AS ordinal,
			        (SELECT COUNT(*) FROM ${TABLES.entries} c
			          WHERE c.thread_id = a.thread_id AND c.re = a.id AND c.kind IN (${REPLIES})) AS replies,
			        r.kind AS reply_kind, r.author AS reply_author, r.body AS reply_body,
			        r.data AS reply_data, r.created_at AS reply_at, r.updated_by AS reply_by
			   FROM ${TABLES.entries} a JOIN ${TABLES.tasks} t ON t.id = a.thread_id
			   LEFT JOIN ${TABLES.entries} r ON r.id = (
			     SELECT x.id FROM ${TABLES.entries} x
			      WHERE x.thread_id = a.thread_id AND x.re = a.id AND x.kind IN (${REPLIES})
			      ORDER BY x.created_at DESC, x.id DESC LIMIT 1)
			  WHERE ${where.join(" AND ")}
			  ORDER BY a.thread_id, a.id`,
		)
		.all(...params)
		.map((row) => {
			const ask = dataOf(row.data);
			const reply = dataOf(row.reply_data);
			const status = statusOf(row.reply_kind);
			return {
				id: row.id,
				taskId: row.thread_id,
				status,
				askedBy: row.author,
				answeredBy: row.reply_author ?? undefined,
				answeredAt: row.reply_at ?? undefined,
				createdAt: row.created_at,
				updatedAt: row.reply_at ?? row.created_at,
				updatedBy: row.reply_by ?? row.updated_by ?? row.author,
				version: 1 + row.replies,
				visibility: row.visibility,
				body: row.body,
				why: ask.why,
				answer:
					status === "answered" ? (row.reply_body ?? undefined) : undefined,
				reasoning: reply.reasoning,
				handle: `${row.short_id ?? row.thread_id}:${row.ordinal}`,
				ordinal: row.ordinal,
				title: row.title,
				priority: row.priority,
				state: row.state,
				shortId: row.short_id ?? undefined,
			};
		});
};

/** The open questions on an issue, oldest first. */
const openOn = (db: Db, taskId: string): QuestionView[] =>
	selectQuestions(db, { taskId, status: "open" });

/** Answer or withdraw one question: a reply to its entry. */
const close = (
	db: Db,
	question: { id: string; taskId: string; visibility: string },
	closing: {
		status: "answered" | "withdrawn";
		answer: string | null;
		reasoning: string | null;
		by: string;
	},
): void => {
	Planner.addEntryIn(db, {
		taskId: question.taskId,
		kind: closing.status === "answered" ? ANSWER_KIND : WITHDRAW_KIND,
		author: closing.by,
		body: closing.answer,
		re: question.id,
		data:
			closing.reasoning === null ? undefined : { reasoning: closing.reasoning },
		// A private question's reply is private too, whatever its issue is.
		private: question.visibility === "private",
	});
};

export namespace Questions {
	/** The reason recorded on each question a closed issue withdraws. */
	export const CLOSED_REASON = "issue closed";
	/** The reasoning on a question `kabane_ask` replaced, before its successor's handle and id. */
	export const REPLACED_REASON = "replaced by";

	/**
	 * The module's `onTaskStateChange`: closing an issue (done or cancelled)
	 * withdraws its open questions, in the closing transaction. Reopening
	 * restores none of them.
	 */
	export const withdrawOnClose = (db: Db, task: Task): Result<void> => {
		if (task.state !== "done" && task.state !== "cancelled")
			return ok(undefined);
		for (const question of openOn(db, task.id))
			close(db, question, {
				status: "withdrawn",
				answer: null,
				reasoning: CLOSED_REASON,
				by: Runtime.actor(),
			});
		return ok(undefined);
	};

	export const list = async (
		basePath: string,
		filter: { id?: string; scopeUri?: string; status?: "open" | "all" } = {},
	): Promise<Result<QuestionView[]>> => {
		let taskId: string | undefined;
		if (filter.id !== undefined) {
			const resolved = await Planner.resolveTaskId(basePath, filter.id);
			if (!resolved.ok) return resolved;
			taskId = resolved.value;
		}
		let scopeUri: string | undefined;
		if (filter.scopeUri !== undefined) {
			const scope = normalizeScopeUri(filter.scopeUri);
			if (!scope.ok) return scope;
			scopeUri = scope.value;
		}
		return withDb(basePath, (db) =>
			selectQuestions(db, { taskId, scopeUri, status: filter.status }),
		);
	};

	/** A question's ULID from its handle (`JCAB-12:1`), its ULID, or `id:<ULID>` as a page prints it. */
	export const resolve = async (
		basePath: string,
		input: string,
	): Promise<Result<string>> => {
		if (input.startsWith("id:")) return ok(input.slice("id:".length));
		const match = input.match(/^(.+):([1-9]\d*)$/);
		if (!match) return ok(input);
		const task = match[1];
		const ordinal = Number(match[2]);
		if (!task || !Number.isSafeInteger(ordinal))
			return err(new Error(`Invalid question handle: ${input}`));
		const rows = await list(basePath, { id: task });
		if (!rows.ok) return rows;
		const question = rows.value[ordinal - 1];
		return question
			? ok(question.id)
			: err(new Error(`No question found: ${input}`));
	};

	export const status = (basePath: string, questionId: string) =>
		withDb(basePath, (db) => {
			const [row] = selectQuestions(db, { id: questionId });
			if (!row) throw new Error(`No question found: ${questionId}`);
			return { taskId: row.taskId, status: row.status };
		});

	/**
	 * File questions on an issue, addressed to `to`: the human asked, or none
	 * when the asking surface knows no human.
	 */
	export const ask = async (
		basePath: string,
		input: AskInput,
		actor = Runtime.actor(),
		{ to }: { to?: readonly string[] } = {},
	): Promise<Result<QuestionView[]>> => {
		const parsed = AskSchema.safeParse(input);
		if (!parsed.success)
			return err(new Error(`Invalid questions: ${parsed.error.message}`));
		const resolved = await Planner.resolveTaskId(basePath, parsed.data.id);
		if (!resolved.ok) return resolved;
		// Each question's predecessor, resolved as `answer` resolves a handle.
		const replaced: (string | undefined)[] = [];
		for (const { replaces } of parsed.data.questions) {
			const id =
				replaces === undefined
					? ok(undefined)
					: await resolve(basePath, replaces);
			if (!id.ok) return id;
			replaced.push(id.value);
		}
		const written = await atomic(basePath, (db) => {
			const task = db
				.query<{ kind: string; state: string }>(
					`SELECT kind, state FROM ${TABLES.tasks} WHERE id = ?`,
				)
				.get(resolved.value);
			if (!task || task.kind !== "issue")
				throw new Error(`Questions require an issue: ${input.id}`);
			if (task.state === "done" || task.state === "cancelled")
				throw new Error(
					`Cannot ask questions on a ${task.state} issue; reopen it first.`,
				);
			const now = new Date().toISOString();
			const ids: string[] = [];
			for (const [
				index,
				{ question, why, replaces, ...meta },
			] of parsed.data.questions.entries()) {
				const predecessor = replaced[index];
				if (predecessor !== undefined) {
					const [old] = selectQuestions(db, { id: predecessor });
					if (!old) throw new Error(`No question found: ${replaces}`);
					if (old.taskId !== resolved.value)
						throw new Error(
							`${replaces} is on another issue; ask its replacement on that issue.`,
						);
					if (old.status !== "open")
						throw new Error(
							`${replaces} is ${old.status}; only an open question can be replaced.`,
						);
					if (replaced.indexOf(predecessor) !== index)
						throw new Error(`${replaces} is replaced twice in one call.`);
				}
				const id = Planner.addEntryIn(db, {
					taskId: resolved.value,
					kind: ASK_KIND,
					author: actor,
					body: formatDecisionBody(question, meta),
					to,
					data: why === undefined ? undefined : { why },
					createdAt: now,
				});
				ids.push(id);
			}
			const rows = selectQuestions(db, { taskId: resolved.value }).filter(
				(row) => ids.includes(row.id),
			);
			// Withdrawn in the transaction that opens its successor, so the issue never leaves waiting.
			replaced.forEach((predecessor, index) => {
				const successor = rows.find((row) => row.id === ids[index]);
				if (predecessor === undefined || !successor) return;
				const [replacedQuestion] = selectQuestions(db, { id: predecessor });
				if (!replacedQuestion) return;
				close(db, replacedQuestion, {
					status: "withdrawn",
					answer: null,
					reasoning: `${REPLACED_REASON} ${successor.handle} id:${successor.id}`,
					by: actor,
				});
			});
			let changedTask: Task | null = null;
			if (parsed.data.waiting && task.state !== "waiting") {
				const moved = Planner.updateTaskIn(db, resolved.value, {
					state: "waiting",
				});
				if (!moved.ok) throw moved.error;
				changedTask = moved.value;
			}
			return { rows, changedTask };
		});
		if (!written.ok) return written;
		if (written.value.changedTask)
			await Events.emit(PLANNER_EVENTS.TASK_UPDATED, written.value.changedTask);
		return ok(written.value.rows);
	};

	export const answer = async (
		basePath: string,
		input: AnswerInput,
		actor = Runtime.actor(),
	): Promise<Result<{ question: QuestionView; moved: boolean }>> => {
		const parsed = AnswerSchema.safeParse(input);
		if (!parsed.success)
			return err(new Error(`Invalid answer: ${parsed.error.message}`));
		const resolved = await resolve(basePath, parsed.data.question);
		if (!resolved.ok) return resolved;
		const written = await atomic(basePath, (db) => {
			const [question] = selectQuestions(db, { id: resolved.value });
			if (!question) throw new Error(`No question found: ${input.question}`);
			const answer = parsed.data.withdraw
				? ok(null)
				: validateAnswer(
						parseDecisionBody(question.body),
						parsed.data.answer ?? "",
					);
			if (!answer.ok) throw answer.error;
			close(db, question, {
				status: parsed.data.withdraw ? "withdrawn" : "answered",
				answer: answer.value,
				reasoning: parsed.data.reasoning ?? null,
				by: actor,
			});
			let changedTask: Task | null = null;
			const open = openOn(db, question.taskId).length > 0;
			const task = db
				.query<{ state: string }>(
					`SELECT state FROM ${TABLES.tasks} WHERE id = ?`,
				)
				.get(question.taskId);
			if (question.status === "open" && !open && task?.state === "waiting") {
				const moved = Planner.updateTaskIn(db, question.taskId, {
					state: "next",
				});
				if (!moved.ok) throw moved.error;
				changedTask = moved.value;
			}
			const updated = selectQuestions(db, { taskId: question.taskId }).find(
				(row) => row.id === question.id,
			);
			if (!updated) throw new Error(`Question disappeared: ${question.id}`);
			return { question: updated, changedTask };
		});
		if (!written.ok) return written;
		if (written.value.changedTask)
			await Events.emit(PLANNER_EVENTS.TASK_UPDATED, written.value.changedTask);
		return ok({
			question: written.value.question,
			moved: written.value.changedTask !== null,
		});
	};
}
