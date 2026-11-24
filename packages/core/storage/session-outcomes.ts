/**
 * Storage — what core's session tables held, moved onto the record (JCAB-343).
 *
 * Core kept agent sessions in `agent_sessions` and `agent_activities`, which
 * never replicated. Nothing writes them since the loop keeps its own sessions
 * (JCAB-340). This step keeps what they hold about the issue: each durable
 * outcome becomes a timeline entry, and each session a `session:` ref in its
 * issue's work log, both shared and replicated. The stream (progress,
 * questions, answers, withdrawals, any other type) stays behind and goes when
 * the migration drops the tables.
 *
 * Every column of a row written here is a function of the source rows alone:
 * its id is the source row's, its author, `updated_by` and times come from the
 * activity and its session, never from the device's actor or clock. So two
 * devices that migrate copies of one database write identical rows, which the
 * append-only sync family keeps once, and a re-run writes nothing.
 *
 * Nothing is lost quietly. A database missing one of the two tables, or one
 * that already holds a different row under an id this step would write, fails
 * the migration with what to fix; its transaction rolls back and nothing is
 * dropped.
 *
 * The tables are retired, so they are named as strings (`migrations.ts`). One
 * statement per row, few parameters each: the hub's engine refuses `BEGIN`,
 * `SAVEPOINT` and more than 100 bound parameters.
 */

import type { Db } from "../db/port";
import { parseQuestionBody } from "../schemas";

const SESSIONS = "agent_sessions";
const ACTIVITIES = "agent_activities";

/**
 * The entry kind of each durable activity type, the ones the brief kept. These
 * are the kinds `@kabane/outcome` and `@kabane/handoff` declare, written as
 * literals: core cannot import a module, and an entry's kind is a soft string
 * stored whether or not a module declares it.
 */
const KINDS = new Map<string, string>([
	["response", "outcome.summary"],
	["decision", "outcome.decision"],
	["finding", "outcome.finding"],
	["verification", "outcome.verification"],
	["handoff", "handoff"],
]);

type ActivityRow = {
	id: string;
	session_id: string;
	type: string;
	severity: string | null;
	category: string | null;
	context: string | null;
	body: string;
	author: string | null;
	created_at: string;
	task_id: string;
	agent: string;
};

type SessionRow = {
	id: string;
	task_id: string;
	agent: string;
	external_ref: string | null;
	started_at: string;
};

const ANSWERS = "answers ";

const AGENT_ACTOR = "cabane://actor/agent/";

/** An author as an actor URI: one already a URI as it is, an agent's name as that agent. */
const actorOf = (author: string): string =>
	author.startsWith("cabane://") ? author : `${AGENT_ACTOR}${author}`;

/** Fail the migration: thrown inside its transaction, which rolls back. */
const refuse = (what: string): never => {
	throw new Error(
		`session-outcomes: ${what}; nothing was changed. Back up kabane.db, fix that, then open kabane again.`,
	);
};

/** The text of the question a decision answers in its own session, if it answers one. */
const answeredQuestion = (db: Db, a: ActivityRow): string | undefined => {
	if (a.context === null || !a.context.startsWith(ANSWERS)) return undefined;
	const question = db
		.query<{ body: string }, [string, string]>(
			`SELECT body FROM ${ACTIVITIES}
			  WHERE id = ? AND session_id = ? AND type = 'question'`,
		)
		.get(a.context.slice(ANSWERS.length), a.session_id);
	return question ? parseQuestionBody(question.body).question : undefined;
};

/**
 * Who wrote an outcome. A decision names its author when one is on record (the
 * actor that answered a question), typed `ai` only for an agent's URI, as
 * `authorTypeOf` in `mcp/tools.ts` types an actor; everything else is the
 * session's agent.
 */
const authorOf = (
	a: ActivityRow,
): { author: string; authorType: "human" | "ai" } =>
	a.type === "decision" && a.author
		? {
				author: a.author,
				authorType: a.author.startsWith(AGENT_ACTOR) ? "ai" : "human",
			}
		: { author: a.agent, authorType: "ai" };

const contentOf = (db: Db, a: ActivityRow): string => {
	if (a.type === "response") return a.body;
	if (a.type === "decision") {
		const question = answeredQuestion(db, a);
		return question === undefined ? a.body : `${question}\n→ ${a.body}`;
	}
	return [
		...(a.severity ? [`Severity: ${a.severity}`] : []),
		...(a.category ? [`Category: ${a.category}`] : []),
		a.body,
		...(a.context ? [`\nContext: ${a.context}`] : []),
	].join("\n");
};

/** Each durable activity as a shared timeline entry with the activity's id. */
const moveOutcomes = (db: Db): void => {
	const activities = db
		.query<ActivityRow, []>(
			`SELECT a.id, a.session_id, a.type, a.severity, a.category, a.context,
			        a.body, a.author, a.created_at, s.task_id, s.agent
			   FROM ${ACTIVITIES} a
			   JOIN ${SESSIONS} s ON s.id = a.session_id
			  WHERE a.ephemeral = 0
			    AND a.type IN (${[...KINDS.keys()].map((t) => `'${t}'`).join(", ")})
			  ORDER BY a.created_at, a.id`,
		)
		.all();
	for (const a of activities) {
		const kind = KINDS.get(a.type);
		if (kind === undefined) continue;
		const { author, authorType } = authorOf(a);
		const content = contentOf(db, a);
		// An id already taken is this entry (an earlier run, or a device that
		// migrated a copy and synced it here) or another row, whose outcome would
		// be lost under it.
		const held = db
			.query<{ task_id: string; kind: string; content: string }, [string]>(
				`SELECT task_id, kind, content FROM task_comments WHERE id = ?`,
			)
			.get(a.id);
		if (held) {
			if (
				held.task_id !== a.task_id ||
				held.kind !== kind ||
				held.content !== content
			)
				refuse(
					`task_comments already holds a different row with id ${a.id}, the id of the ${a.type} it would keep from session ${a.session_id}`,
				);
			continue;
		}
		db.run(
			`INSERT INTO task_comments
			   (id, task_id, kind, author, author_type, content, updated_by, visibility, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'shared', ?)`,
			[
				a.id,
				a.task_id,
				kind,
				author,
				authorType,
				content,
				actorOf(author),
				a.created_at,
			],
		);
		// Not captured: these tables stopped replicating at migration 14, which
		// runs right after and drops this device's ops on them.
	}
};

/** The uris of a work-log row's refs; none when the column is not the JSON array it should be. */
const refUris = (raw: string): string[] => {
	try {
		const refs: unknown = JSON.parse(raw);
		return Array.isArray(refs)
			? refs.flatMap((ref: unknown) =>
					typeof ref === "object" &&
					ref !== null &&
					"uri" in ref &&
					typeof ref.uri === "string"
						? [ref.uri]
						: [],
				)
			: [];
	} catch {
		// Not JSON: it names no session, so the session still gets its ref.
		return [];
	}
};

/**
 * Each session as a `session:` ref in its issue's work log, unless the log
 * already names it. A task's refs are read once, the first time one of its
 * sessions comes up, and the set grows with what is written: an issue with
 * thousands of sessions costs one read, not one per session.
 */
const moveSessions = (db: Db): void => {
	const sessions = db
		.query<SessionRow, []>(
			`SELECT id, task_id, agent, external_ref, started_at
			   FROM ${SESSIONS} ORDER BY started_at, id`,
		)
		.all();
	const named = new Map<string, Set<string>>();
	const namedOn = (taskId: string): Set<string> => {
		const known = named.get(taskId);
		if (known) return known;
		const uris = new Set(
			db
				.query<{ refs: string }, [string]>(
					`SELECT refs FROM task_work_log WHERE task_id = ?`,
				)
				.all(taskId)
				.flatMap((row) => refUris(row.refs)),
		);
		named.set(taskId, uris);
		return uris;
	};
	for (const s of sessions) {
		const uri = `session:${s.id}`;
		const uris = namedOn(s.task_id);
		if (uris.has(uri)) continue;
		const refs = JSON.stringify([
			{
				uri,
				label: s.agent,
				addedAt: s.started_at,
				addedBy: s.external_ref ?? s.agent,
				addedByType: "ai",
			},
		]);
		// A row under the session's id that names it on this task is in `uris`;
		// any other would lose the session's ref under it.
		const taken = db
			.query<{ one: number }, [string]>(
				`SELECT 1 AS one FROM task_work_log WHERE id = ?`,
			)
			.get(s.id);
		if (taken)
			refuse(
				`task_work_log already holds a different row with id ${s.id}, the id of session ${s.id}'s ref`,
			);
		db.run(
			`INSERT INTO task_work_log
			   (id, task_id, refs, updated_by, visibility, created_at)
			 VALUES (?, ?, ?, ?, 'shared', ?)`,
			[s.id, s.task_id, refs, actorOf(s.agent), s.started_at],
		);
		// Not captured, as above.
		uris.add(uri);
	}
};

/** Which of the two tables the database lacks; migration 1 created both. */
const missingTables = (db: Db): string[] => {
	const present = new Set(
		db
			.query<{ name: string }, []>(
				`SELECT name FROM sqlite_master
				  WHERE type = 'table' AND name IN ('${SESSIONS}', '${ACTIVITIES}')`,
			)
			.all()
			.map((row) => row.name),
	);
	return [SESSIONS, ACTIVITIES].filter((table) => !present.has(table));
};

export namespace SessionOutcomes {
	/**
	 * Move the outcomes and the sessions onto the record. The migration drops
	 * the tables right after, in the same transaction. A database without both
	 * tables is refused rather than read as having no sessions: migration 1
	 * creates both, so one is missing only by damage, and dropping the other
	 * would lose what it holds.
	 */
	export const migrate = (db: Db): void => {
		const missing = missingTables(db);
		if (missing.length > 0)
			refuse(
				`this database has no ${missing.join(" and no ")} table, which migration 1 creates`,
			);
		moveOutcomes(db);
		moveSessions(db);
	};
}
