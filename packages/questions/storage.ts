import {
	atomic,
	Events,
	PLANNER_EVENTS,
	type Task,
	type Db,
	err,
	normalizeScopeUri,
	ok,
	Oplog,
	Planner,
	type Result,
	Runtime,
	scopeClause,
	type SqlValue,
	TABLES,
	withDb,
} from "@cabane/core";
import { monotonicFactory } from "ulid";
import { validateAnswer } from "./answer";
import { formatDecisionBody, parseDecisionBody } from "./body";
import { QUESTIONS_TABLE } from "./migrations";
import {
	AnswerSchema,
	AskSchema,
	type AnswerInput,
	type AskInput,
	type Question,
	type QuestionStatus,
	type QuestionView,
} from "./schema";

const generateId = monotonicFactory();

/** Ordinals include closed questions, so answering never renumbers handles. */
const selectQuestions = (
	db: Db,
	filter: { taskId?: string; scopeUri?: string; status?: "open" | "all" } = {},
): QuestionView[] => {
	const where: string[] = [];
	const params: SqlValue[] = [];
	if (filter.taskId !== undefined) {
		where.push("q.task_id = ?");
		params.push(filter.taskId);
	}
	if (filter.scopeUri !== undefined) {
		const scope = scopeClause(filter.scopeUri, "t.scope_uri");
		where.push(scope.sql);
		params.push(...scope.params);
	}
	if (filter.status === "open") where.push("q.status = 'open'");
	return db
		.query<
			Question &
				Pick<QuestionView, "ordinal" | "title" | "priority" | "state"> & {
					short_id: string | null;
				}
		>(`SELECT q.*, t.short_id, t.title, t.priority, t.state,
		(SELECT COUNT(*) FROM ${QUESTIONS_TABLE} preceding WHERE preceding.task_id = q.task_id AND preceding.id <= q.id) AS ordinal
		FROM ${QUESTIONS_TABLE} q JOIN ${TABLES.tasks} t ON t.id = q.task_id
		${where.length ? `WHERE ${where.join(" AND ")}` : ""}
		ORDER BY q.task_id, q.id`)
		.all(...params)
		.map((row) => ({
			id: row.id,
			taskId: row.task_id,
			status: row.status,
			askedBy: row.asked_by,
			answeredBy: row.answered_by ?? undefined,
			answeredAt: row.answered_at ?? undefined,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
			updatedBy: row.updated_by,
			version: row.version,
			visibility: row.visibility,
			body: row.body,
			why: row.why ?? undefined,
			answer: row.answer ?? undefined,
			reasoning: row.reasoning ?? undefined,
			handle: `${row.short_id ?? row.task_id}:${row.ordinal}`,
			ordinal: row.ordinal,
			title: row.title,
			priority: row.priority,
			state: row.state,
			shortId: row.short_id ?? undefined,
		}));
};

/** Answer or withdraw one question, and capture it. */
const close = (
	db: Db,
	id: string,
	closing: {
		status: "answered" | "withdrawn";
		answer: string | null;
		reasoning: string | null;
		by: string;
	},
): void => {
	const now = new Date().toISOString();
	db.run(
		`UPDATE ${QUESTIONS_TABLE} SET status = ?, answer = ?, reasoning = ?, answered_by = ?, answered_at = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?`,
		[
			closing.status,
			closing.answer,
			closing.reasoning,
			closing.by,
			now,
			now,
			Runtime.actor(),
			id,
		],
	);
	Oplog.afterWrite(db, QUESTIONS_TABLE, "update", id);
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
		const open = db
			.query<{ id: string }>(
				`SELECT id FROM ${QUESTIONS_TABLE} WHERE task_id = ? AND status = 'open' ORDER BY id`,
			)
			.all(task.id);
		for (const { id } of open)
			close(db, id, {
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

	export const ask = async (
		basePath: string,
		input: AskInput,
		actor = Runtime.actor(),
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
				.query<{ kind: string; visibility: string; state: string }>(
					`SELECT kind, visibility, state FROM ${TABLES.tasks} WHERE id = ?`,
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
					const old = db
						.query<{ task_id: string; status: QuestionStatus }>(
							`SELECT task_id, status FROM ${QUESTIONS_TABLE} WHERE id = ?`,
						)
						.get(predecessor);
					if (!old) throw new Error(`No question found: ${replaces}`);
					if (old.task_id !== resolved.value)
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
				const id = generateId();
				db.run(
					`INSERT INTO ${QUESTIONS_TABLE} (id, task_id, asked_by, created_at, updated_at, updated_by, visibility, body, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						id,
						resolved.value,
						actor,
						now,
						now,
						Runtime.actor(),
						task.visibility,
						formatDecisionBody(question, meta),
						why ?? null,
					],
				);
				Oplog.afterWrite(db, QUESTIONS_TABLE, "insert", id);
				ids.push(id);
			}
			const rows = selectQuestions(db, { taskId: resolved.value }).filter(
				(row) => ids.includes(row.id),
			);
			// Withdrawn in the transaction that opens its successor, so the issue never leaves waiting.
			replaced.forEach((predecessor, index) => {
				const successor = rows.find((row) => row.id === ids[index]);
				if (predecessor === undefined || !successor) return;
				close(db, predecessor, {
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
			const question = db
				.query<Question>(`SELECT * FROM ${QUESTIONS_TABLE} WHERE id = ?`)
				.get(resolved.value);
			if (!question) throw new Error(`No question found: ${input.question}`);
			const answer = parsed.data.withdraw
				? ok(null)
				: validateAnswer(
						parseDecisionBody(question.body),
						parsed.data.answer ?? "",
					);
			if (!answer.ok) throw answer.error;
			close(db, question.id, {
				status: parsed.data.withdraw ? "withdrawn" : "answered",
				answer: answer.value,
				reasoning: parsed.data.reasoning ?? null,
				by: actor,
			});
			let changedTask: Task | null = null;
			const open = db
				.query<{ id: string }>(
					`SELECT id FROM ${QUESTIONS_TABLE} WHERE task_id = ? AND status = 'open' LIMIT 1`,
				)
				.get(question.task_id);
			const task = db
				.query<{ state: string }>(
					`SELECT state FROM ${TABLES.tasks} WHERE id = ?`,
				)
				.get(question.task_id);
			if (question.status === "open" && !open && task?.state === "waiting") {
				const moved = Planner.updateTaskIn(db, question.task_id, {
					state: "next",
				});
				if (!moved.ok) throw moved.error;
				changedTask = moved.value;
			}
			const updated = selectQuestions(db, { taskId: question.task_id }).find(
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
