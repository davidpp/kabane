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
	type SqlValue,
	TABLES,
	withDb,
} from "@cabane/core";
import { monotonicFactory } from "ulid";
import { validateAnswer } from "./answer";
import { formatDecisionBody, parseDecisionBody } from "./body";
import { QUESTIONS_TABLE, questionsTable } from "./migrations";
import {
	AnswerSchema,
	AskSchema,
	type AnswerInput,
	type AskInput,
	type Question,
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
		where.push("t.scope_uri = ?");
		params.push(filter.scopeUri);
	}
	if (filter.status === "open") where.push("q.status = 'open'");
	return db
		.query<
			Omit<QuestionView, "handle">
		>(`SELECT q.*, t.short_id, t.title, t.priority, t.state,
		(SELECT COUNT(*) FROM ${questionsTable()} preceding WHERE preceding.task_id = q.task_id AND preceding.id <= q.id) AS ordinal
		FROM ${questionsTable()} q JOIN ${TABLES.tasks} t ON t.id = q.task_id
		${where.length ? `WHERE ${where.join(" AND ")}` : ""}
		ORDER BY q.task_id, q.id`)
		.all(...params)
		.map((row) => ({
			...row,
			handle: `${row.short_id ?? row.task_id}:${row.ordinal}`,
		}));
};

export namespace Questions {
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

	export const resolve = async (
		basePath: string,
		input: string,
	): Promise<Result<string>> => {
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
		const written = await atomic(basePath, (db) => {
			const task = db
				.query<{ kind: string; visibility: string }>(
					`SELECT kind, visibility FROM ${TABLES.tasks} WHERE id = ?`,
				)
				.get(resolved.value);
			if (!task || task.kind !== "issue")
				throw new Error(`Questions require an issue: ${input.id}`);
			const now = new Date().toISOString();
			const ids: string[] = [];
			for (const { question, why, ...meta } of parsed.data.questions) {
				const id = generateId();
				db.run(
					`INSERT INTO ${questionsTable()} (id, task_id, asked_by, created_at, updated_at, updated_by, visibility, body, why) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			let changedTask: Task | null = null;
			if (parsed.data.waiting) {
				const moved = Planner.updateTaskIn(db, resolved.value, {
					state: "waiting",
				});
				if (!moved.ok) throw moved.error;
				changedTask = moved.value;
			}
			return {
				rows: selectQuestions(db, { taskId: resolved.value }).filter((row) =>
					ids.includes(row.id),
				),
				changedTask,
			};
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
				.query<Question>(`SELECT * FROM ${questionsTable()} WHERE id = ?`)
				.get(resolved.value);
			if (!question) throw new Error(`No question found: ${input.question}`);
			const answer = parsed.data.withdraw
				? ok(null)
				: validateAnswer(
						parseDecisionBody(question.body),
						parsed.data.answer ?? "",
					);
			if (!answer.ok) throw answer.error;
			const now = new Date().toISOString();
			db.run(
				`UPDATE ${questionsTable()} SET status = ?, answer = ?, reasoning = ?, answered_by = ?, answered_at = ?, updated_at = ?, updated_by = ?, version = version + 1 WHERE id = ?`,
				[
					parsed.data.withdraw ? "withdrawn" : "answered",
					answer.value,
					parsed.data.reasoning ?? null,
					actor,
					now,
					now,
					Runtime.actor(),
					question.id,
				],
			);
			Oplog.afterWrite(db, QUESTIONS_TABLE, "update", question.id);
			let changedTask: Task | null = null;
			const open = db
				.query<{ id: string }>(
					`SELECT id FROM ${questionsTable()} WHERE task_id = ? AND status = 'open' LIMIT 1`,
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
