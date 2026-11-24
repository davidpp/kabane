/**
 * Migration 14: today's task tables move onto the 2.0 record (ADR 0006,
 * JCAB-660), and the task read becomes a view over it.
 *
 * - `tasks` → `threads`; every task column that left the thread row becomes an
 *   attribute under its own column name (counter 0: written with its thread),
 *   `discovered_by` is the thread's `created_by`, and a `parent` or `child`
 *   link folds into the child's parent, the link's own fields kept in the
 *   child's `parent_links` attribute.
 * - `task_comments` → `entries`, kind kept, `author_type` (and `updated_at`
 *   when set) in `data`; `task_work_log` → `entries` of kind `log`, the refs
 *   in `data`.
 * - `task_links` → `refs` to `kabane://thread/<target>`, the link type as kind;
 *   `task_context_refs` → `refs` of their own kind, the label as title;
 *   `upstream_links` → `refs` of kind `upstream` whose URI is
 *   `<provider>:<external id>`. Each keeps its old id in `data`; what it is
 *   follows from its URI and kind (`families.ts`).
 *
 * Every value is taken from the source row, never this device's clock or
 * actor, so two copies migrated apart write the same rows; a clock is written
 * in `toISOString` form and a REAL as text that reads back as the same
 * binary64, which is checked. The migration refuses, changing nothing and
 * naming the rows: a source column it does not place, a time that names no
 * fixed instant, a row whose URI or kind is another family's, two rows that
 * would land on one ref key, a child whose links name two parents, a fold that
 * would change what replicates, and a value that would not read back.
 *
 * `tasks` itself is renamed to `retired_tasks`, not dropped. It is no backup:
 * its foreign keys still act (a project delete nulls its `project_id`), and
 * nothing reads it. With `foreign_keys = ON` a DROP deletes every row first,
 * and each data module table that references `tasks(id) ON DELETE CASCADE`
 * would lose its rows; renamed, those references follow the table and the
 * rows stay. Each module drops its reference in a migration of its own, which
 * runs after core's.
 *
 * Then `task_rows` is a view of every thread's old task row, and `tasks` the
 * visible ones over the record's visibility rule (`VISIBLE_THREADS_SQL`), so a
 * deleted thread and everything under it reads as gone; a point read takes
 * `task_rows` with one thread's ancestry (`task-rows.ts`). `tasks_fts` indexes
 * threads, kept in step by triggers so a pulled row is searchable too.
 */

import type { Db } from "../db/port";
import { TABLES } from "../db/tables";
import { RecordKey } from "../schemas";
import { RESERVED_REF_KINDS, UPSTREAM_KIND, WORK_LOG_KIND } from "./families";
import { VISIBLE_THREADS_SQL } from "./record";

/** Each task column that leaves the thread row, as an attribute of that name. */
const TASK_ATTRIBUTES = [
	"priority",
	"scope_refs",
	"deadline",
	"defer_until",
	"completed_at",
	"source",
	"source_id",
	"source_url",
	"discovered_at",
	"confidence",
	"project_id",
	"needs_review",
	"reviewed_at",
	"reviewed_by",
	"evidence",
	"verification",
	"tags",
	"context",
] as const;

/**
 * Every column of each source table this migration places somewhere. A ref's
 * identity is its thread, URI and kind, so the old ULID of a link, context ref
 * or upstream link is kept in its `data` as `id`, a stored value and nothing
 * more. A folded `parent` or `child` link keeps nothing but the parent it
 * names.
 */
const PLACED: Record<string, readonly string[]> = {
	tasks: [
		"id",
		"short_id",
		"title",
		"description",
		"kind",
		"state",
		"scope_uri",
		"discovered_by",
		"assignee",
		"parent_task_id",
		"updated_by",
		"version",
		"visibility",
		"created_at",
		"updated_at",
		...TASK_ATTRIBUTES,
	],
	task_comments: [
		"id",
		"task_id",
		"author",
		"author_type",
		"content",
		"updated_by",
		"version",
		"visibility",
		"created_at",
		"updated_at",
		"kind",
	],
	task_work_log: [
		"id",
		"task_id",
		"refs",
		"note",
		"updated_by",
		"version",
		"visibility",
		"created_at",
	],
	task_links: [
		"id",
		"source_id",
		"target_id",
		"type",
		"note",
		"updated_by",
		"version",
		"visibility",
		"created_at",
	],
	task_context_refs: [
		"id",
		"task_id",
		"uri",
		"kind",
		"label",
		"note",
		"added_by",
		"added_by_type",
		"added_at",
		"updated_by",
		"version",
		"visibility",
	],
	upstream_links: [
		"id",
		"task_id",
		"provider",
		"external_id",
		"identifier",
		"url",
		"title",
		"created_at",
		"updated_at",
		"visibility",
		"updated_by",
		"version",
	],
};

/** Refuse a source column `PLACED` does not name: it would be dropped unread. */
const refuseUnplaced = (db: Db): void => {
	for (const [table, placed] of Object.entries(PLACED)) {
		const unplaced = db
			.query<{ name: string }, []>(`PRAGMA table_info(${table})`)
			.all()
			.map(({ name }) => name)
			.filter((name) => !placed.includes(name));
		if (unplaced.length > 0)
			throw new Error(
				`${table} has columns this migration does not place (${unplaced.join(", ")}); nothing was changed`,
			);
	}
};

/**
 * The record compares clocks as strings, so each is written in the one form
 * that sorts as it reads (`toISOString`: UTC, milliseconds, `Z`). SQLite reads
 * the other ISO forms a build may have stored, an offset included, and gives
 * NULL for what it cannot read.
 */
const clock = (column: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${column})`;

/** Every source clock that becomes a register clock or an entry's time. */
const CLOCKS: Record<string, readonly string[]> = {
	tasks: ["created_at", "updated_at"],
	task_comments: ["created_at"],
	task_work_log: ["created_at"],
	task_links: ["created_at"],
	task_context_refs: ["added_at"],
	upstream_links: ["updated_at"],
};

/**
 * Refuse a clock that names no fixed instant, naming its row: one SQLite
 * cannot read, and one it reads relative to now (`now`) or as a day number,
 * which two copies migrated apart would turn into two different clocks. A
 * fixed instant is written as a date first.
 */
const refuseUnreadableClocks = (db: Db): void => {
	for (const [table, columns] of Object.entries(CLOCKS))
		for (const column of columns) {
			const rows = db
				.query<{ id: string }, []>(
					`SELECT id FROM ${table}
					  WHERE ${clock(column)} IS NULL OR typeof(${column}) <> 'text'
					     OR ${column} NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'`,
				)
				.all();
			if (rows.length > 0)
				throw new Error(
					`${table}.${column} holds a time no instant can be read from (${rows.map(({ id }) => id).join(", ")}); nothing was changed`,
				);
		}
};

/**
 * Refuse a row whose URI or kind is another family's (`families.ts`): a
 * context ref to a thread or under a link type or `upstream`, and a comment of
 * kind `log`. Each family then has keys of its own.
 */
const refuseCrossFamilyRows = (db: Db): void => {
	const reserved = RESERVED_REF_KINDS.map((kind) => `'${kind}'`).join(", ");
	const rows = db
		.query<{ id: string }, []>(
			`SELECT id FROM task_context_refs
			  WHERE substr(uri, 1, ${RecordKey.THREAD_URI_PREFIX.length}) = '${RecordKey.THREAD_URI_PREFIX}'
			     OR kind IN (${reserved})
			 UNION SELECT id FROM task_comments WHERE kind = '${WORK_LOG_KIND}'
			 ORDER BY id`,
		)
		.all();
	if (rows.length > 0)
		throw new Error(
			`rows whose URI or kind is another family's: a context ref to a thread or under a link or upstream kind, a comment of kind log (${rows.map(({ id }) => id).join(", ")}); nothing was changed`,
		);
};

/**
 * Refuse two source rows that would land on one ref key, naming both. With
 * the families apart only two linked issues can, when the provider and the
 * external id run together (`a:b` + `c`, `a` + `b:c`).
 */
const refuseSharedRefKeys = (db: Db): void => {
	const rows = db
		.query<{ id: string }, []>(
			`WITH keyed(id, thread_id, uri, kind) AS (
			   SELECT id, source_id, '${RecordKey.THREAD_URI_PREFIX}' || target_id, type
			     FROM task_links WHERE type NOT IN ('parent', 'child')
			   UNION ALL SELECT id, task_id, uri, kind FROM task_context_refs
			   UNION ALL SELECT id, task_id, provider || ':' || external_id, '${UPSTREAM_KIND}'
			     FROM upstream_links)
			 SELECT k.id FROM keyed k
			  WHERE (SELECT COUNT(*) FROM keyed o
			          WHERE o.thread_id = k.thread_id AND o.uri = k.uri AND o.kind = k.kind) > 1
			  ORDER BY k.id`,
		)
		.all();
	if (rows.length > 0)
		throw new Error(
			`rows that would land on one ref key (${rows.map(({ id }) => id).join(", ")}); nothing was changed`,
		);
};

/** Each parent or child link with the child and parent it names. */
const FOLDS = `
  SELECT l.id, l.visibility,
         CASE l.type WHEN 'parent' THEN l.target_id ELSE l.source_id END AS child_id,
         CASE l.type WHEN 'parent' THEN l.source_id ELSE l.target_id END AS parent_id
    FROM task_links l WHERE l.type IN ('parent', 'child')`;

/**
 * A fold sets the child's parent, so it must name one parent and change no
 * row's visibility. Refused: a child whose links (and its own parent) name
 * two parents, and a link whose visibility is not its child's.
 */
const refuseUnsafeFolds = (db: Db): void => {
	const ambiguous = db
		.query<{ id: string }, []>(
			`WITH folds AS (${FOLDS}),
			      named AS (
			        SELECT child_id, parent_id FROM folds
			        UNION SELECT id, parent_task_id FROM tasks
			         WHERE parent_task_id IS NOT NULL AND id IN (SELECT child_id FROM folds))
			 SELECT f.id FROM folds f
			  WHERE (SELECT COUNT(DISTINCT parent_id) FROM named n WHERE n.child_id = f.child_id) > 1
			  ORDER BY f.id`,
		)
		.all();
	if (ambiguous.length > 0)
		throw new Error(
			`parent links name two parents for one child (${ambiguous.map(({ id }) => id).join(", ")}); nothing was changed`,
		);
	const exposing = db
		.query<{ id: string }, []>(
			`WITH folds AS (${FOLDS})
			 SELECT f.id FROM folds f JOIN tasks c ON c.id = f.child_id
			  WHERE f.visibility <> c.visibility ORDER BY f.id`,
		)
		.all();
	if (exposing.length > 0)
		throw new Error(
			`parent links whose visibility is not their child's would change what replicates (${exposing.map(({ id }) => id).join(", ")}); nothing was changed`,
		);
};

/**
 * A REAL keeps every bit as text: 17 significant digits read back as the same
 * binary64. Every other value is stored as it was.
 */
const asText = (column: string) =>
	`CASE typeof(${column}) WHEN 'real' THEN printf('%!.17g', ${column}) ELSE ${column} END`;

/** Refuse an attribute that does not read back as its source value. */
const refuseChangedValues = (db: Db): void => {
	for (const key of TASK_ATTRIBUTES) {
		const changed = db
			.query<{ id: string }, []>(
				`SELECT t.id FROM tasks t
				   JOIN ${TABLES.attributes} a ON a.thread_id = t.id AND a.key = '${key}'
				  WHERE CASE typeof(t.${key})
				          WHEN 'real' THEN CAST(a.value AS REAL) <> t.${key}
				          WHEN 'integer' THEN CAST(a.value AS INTEGER) <> t.${key}
				          ELSE a.value IS NOT t.${key} END`,
			)
			.all();
		if (changed.length > 0)
			throw new Error(
				`tasks.${key} does not read back as stored (${changed.map(({ id }) => id).join(", ")}); nothing was changed`,
			);
	}
};

const moveThreads = (db: Db): void => {
	db.run(
		`INSERT INTO ${TABLES.threads}
		   (id, short_id, kind, kind_version, title, body, scope, parent_id,
		    created_by, created_at, visibility, updated_at, updated_by,
		    updated_device, version, state, assignee, state_updated_at,
		    state_updated_by, state_updated_device, state_version, deleted_at,
		    deleted_device)
		 SELECT id, short_id, kind, NULL, title, description, scope_uri, parent_task_id,
		        discovered_by, ${clock("created_at")}, visibility, ${clock("updated_at")}, updated_by,
		        '', version, state, assignee, ${clock("updated_at")},
		        updated_by, '', 1, NULL, NULL
		   FROM tasks`,
	);
	// A `parent` link's source is the parent; a `child` link's target is.
	db.run(
		`WITH folds AS (${FOLDS})
		 UPDATE ${TABLES.threads}
		    SET parent_id = (SELECT parent_id FROM folds WHERE child_id = ${TABLES.threads}.id)
		  WHERE parent_id IS NULL AND id IN (SELECT child_id FROM folds)`,
	);
	// Attributes written with the thread count no write of their own: their
	// counter starts at 0, so the task's version is its own.
	for (const key of TASK_ATTRIBUTES) {
		db.run(
			`INSERT INTO ${TABLES.attributes}
			   (thread_id, key, value, removed_at, visibility, updated_at, updated_by, updated_device, version)
			 SELECT id, '${key}', ${asText(key)}, NULL, visibility, ${clock("updated_at")}, updated_by, '', 0
			   FROM tasks WHERE ${key} IS NOT NULL`,
		);
	}
	// What a folded link held besides the parent stays on its child, with the
	// child's visibility, which the fold has already checked is the link's.
	db.run(
		`INSERT INTO ${TABLES.attributes}
		   (thread_id, key, value, removed_at, visibility, updated_at, updated_by, updated_device, version)
		 SELECT c.id, 'parent_links',
		        json_group_array(json_object('id', l.id, 'source_id', l.source_id,
		          'target_id', l.target_id, 'type', l.type, 'note', l.note,
		          'updated_by', l.updated_by, 'version', l.version,
		          'visibility', l.visibility, 'created_at', l.created_at)),
		        NULL, c.visibility, ${clock("c.updated_at")}, c.updated_by, '', 0
		   FROM task_links l
		   JOIN tasks c ON c.id = CASE l.type WHEN 'parent' THEN l.target_id ELSE l.source_id END
		  WHERE l.type IN ('parent', 'child')
		  GROUP BY c.id`,
	);
};

const moveEntries = (db: Db): void => {
	db.run(
		`INSERT INTO ${TABLES.entries}
		   (id, thread_id, kind, kind_version, author, body, addressed_to, re, data,
		    visibility, created_at, updated_by, created_device, version)
		 SELECT id, task_id, kind, NULL, author, content, NULL, NULL,
		        CASE WHEN updated_at IS NULL
		             THEN json_object('author_type', author_type)
		             ELSE json_object('author_type', author_type, 'updated_at', updated_at) END,
		        visibility, ${clock("created_at")}, updated_by, '', version
		   FROM task_comments`,
	);
	db.run(
		`INSERT INTO ${TABLES.entries}
		   (id, thread_id, kind, kind_version, author, body, addressed_to, re, data,
		    visibility, created_at, updated_by, created_device, version)
		 SELECT id, task_id, '${WORK_LOG_KIND}', NULL, COALESCE(updated_by, ''), note, NULL, NULL,
		        json_object('refs', json(refs)),
		        visibility, ${clock("created_at")}, updated_by, '', version
		   FROM task_work_log`,
	);
};

const REF_COLUMNS = `(thread_id, uri, kind, kind_version, title, data, removed_at,
  visibility, updated_at, updated_by, updated_device, version)`;

const moveRefs = (db: Db): void => {
	db.run(
		`INSERT INTO ${TABLES.refs} ${REF_COLUMNS}
		 SELECT source_id, '${RecordKey.THREAD_URI_PREFIX}' || target_id, type, NULL, NULL,
		        json_object('id', id, 'note', note, 'created_at', created_at),
		        NULL, visibility, ${clock("created_at")}, updated_by, '', version
		   FROM task_links WHERE type NOT IN ('parent', 'child')`,
	);
	db.run(
		`INSERT INTO ${TABLES.refs} ${REF_COLUMNS}
		 SELECT task_id, uri, kind, NULL, label,
		        json_object('id', id, 'note', note, 'added_by', added_by,
		                    'added_by_type', added_by_type, 'added_at', added_at),
		        NULL, visibility, ${clock("added_at")}, updated_by, '', version
		   FROM task_context_refs`,
	);
	db.run(
		`INSERT INTO ${TABLES.refs} ${REF_COLUMNS}
		 SELECT task_id, provider || ':' || external_id, 'upstream', NULL, title,
		        json_object('id', id, 'provider', provider, 'external_id', external_id,
		                    'identifier', identifier, 'url', url, 'created_at', created_at),
		        NULL, visibility, ${clock("updated_at")}, updated_by, '', version
		   FROM upstream_links`,
	);
};

const OLD_TABLES = [
	"tasks",
	"task_comments",
	"task_work_log",
	"task_links",
	"task_context_refs",
	"upstream_links",
];

/**
 * Nothing syncs through the hub today, so this device's own ops on the old
 * tables are dropped rather than translated, with whatever waits on them.
 */
const clearOldOps = (db: Db): void => {
	const list = OLD_TABLES.map((table) => `'${table}'`).join(", ");
	for (const table of [
		TABLES.sync_oplog,
		TABLES.sync_parked,
		TABLES.sync_parked_deletes,
		TABLES.sync_quarantine,
	])
		db.run(`DELETE FROM ${table} WHERE tbl IN (${list})`);
};

const retireOldTables = (db: Db): void => {
	for (const trigger of ["tasks_fts_ai", "tasks_fts_ad", "tasks_fts_au"])
		db.run(`DROP TRIGGER IF EXISTS ${trigger}`);
	db.run("DROP TABLE IF EXISTS tasks_fts");
	db.run("DROP TABLE IF EXISTS task_comments_fts");
	for (const table of OLD_TABLES.slice(1)) db.run(`DROP TABLE ${table}`);
	db.run(`ALTER TABLE tasks RENAME TO ${TABLES.retired_tasks}`);
};

/** The value of attribute `key` on thread `t`, unless removed. */
const attr = (key: string) =>
	`(SELECT a.value FROM ${TABLES.attributes} a
	   WHERE a.thread_id = t.id AND a.key = '${key}' AND a.removed_at IS NULL)`;

/**
 * The old task row, as `task_rows` holds it for every thread: no visibility,
 * the stored parent. `version` counts every write to the thread's registers
 * and attributes (an attribute written with its thread has counter 0), so a
 * migrated task keeps its own; `updated_at` is the latest of them, and
 * `updated_by` the writer of the latest, the thread's own registers first on
 * a tie.
 */
const TASK_ROWS_VIEW_SQL = `
CREATE VIEW ${TABLES.task_rows} AS
SELECT t.rowid AS rowid, t.id, t.short_id, t.title, t.body AS description, t.kind, t.state,
       COALESCE(${attr("priority")}, 'normal') AS priority,
       t.scope AS scope_uri, ${attr("scope_refs")} AS scope_refs,
       ${attr("deadline")} AS deadline, ${attr("defer_until")} AS defer_until,
       ${attr("completed_at")} AS completed_at,
       COALESCE(${attr("source")}, 'human') AS source,
       ${attr("source_id")} AS source_id, ${attr("source_url")} AS source_url,
       COALESCE(${attr("discovered_at")}, t.created_at) AS discovered_at,
       t.created_by AS discovered_by,
       CAST(${attr("confidence")} AS REAL) AS confidence,
       t.assignee, t.parent_id AS parent_task_id, ${attr("project_id")} AS project_id,
       COALESCE(CAST(${attr("needs_review")} AS INTEGER), 0) AS needs_review,
       ${attr("reviewed_at")} AS reviewed_at, ${attr("reviewed_by")} AS reviewed_by,
       COALESCE(${attr("evidence")}, '[]') AS evidence, ${attr("verification")} AS verification,
       COALESCE(${attr("tags")}, '[]') AS tags, ${attr("context")} AS context,
       (SELECT w.writer FROM (
          SELECT t.updated_at AS at, t.updated_by AS writer, 0 AS rank
          UNION ALL SELECT t.state_updated_at, t.state_updated_by, 1
          UNION ALL SELECT a.updated_at, a.updated_by, 2 FROM ${TABLES.attributes} a
                     WHERE a.thread_id = t.id AND a.version > 0) w
         ORDER BY w.at DESC, w.rank LIMIT 1) AS updated_by,
       t.version + t.state_version - 1
         + COALESCE((SELECT SUM(a.version) FROM ${TABLES.attributes} a WHERE a.thread_id = t.id), 0)
         AS version,
       t.visibility, t.created_at,
       MAX(t.updated_at, t.state_updated_at,
           COALESCE((SELECT MAX(a.updated_at) FROM ${TABLES.attributes} a WHERE a.thread_id = t.id), ''))
         AS updated_at
  FROM ${TABLES.threads} t`;

/**
 * Every column of `task_rows` but the parent, which `tasks` reads as the
 * record places it: null at the root or where a cycle breaks.
 */
const TASK_COLUMNS = [
	"rowid",
	"id",
	"short_id",
	"title",
	"description",
	"kind",
	"state",
	"priority",
	"scope_uri",
	"scope_refs",
	"deadline",
	"defer_until",
	"completed_at",
	"source",
	"source_id",
	"source_url",
	"discovered_at",
	"discovered_by",
	"confidence",
	"assignee",
	"project_id",
	"needs_review",
	"reviewed_at",
	"reviewed_by",
	"evidence",
	"verification",
	"tags",
	"context",
	"updated_by",
	"version",
	"visibility",
	"created_at",
	"updated_at",
];

/** The visible task rows, for a listing: one walk over the whole record. */
const TASKS_VIEW_SQL = `
CREATE VIEW ${TABLES.tasks} AS
${VISIBLE_THREADS_SQL}
SELECT ${TASK_COLUMNS.map((c) => `r.${c} AS ${c}`).join(", ")}, v.parent_id AS parent_task_id
  FROM ${TABLES.task_rows} r JOIN visible_threads v ON v.id = r.id`;

/** One thread's indexed text: title, body and its `tags` attribute. */
const ftsRow = (threadId: string) =>
	`INSERT INTO ${TABLES.tasks_fts}(rowid, title, description, tags)
	 SELECT t.rowid, t.title, t.body,
	        (SELECT value FROM ${TABLES.attributes}
	          WHERE thread_id = t.id AND key = 'tags' AND removed_at IS NULL)
	   FROM ${TABLES.threads} t WHERE t.id = ${threadId};`;

const ftsRefresh = (threadId: string) =>
	`DELETE FROM ${TABLES.tasks_fts}
	  WHERE rowid = (SELECT rowid FROM ${TABLES.threads} WHERE id = ${threadId});
	 ${ftsRow(threadId)}`;

/**
 * `tasks_fts` keeps its own copy of the text, so a row is replaced by rowid
 * without the old values. Threads and attributes are never deleted, only
 * tombstoned, and the view hides a deleted thread's match.
 */
const FTS_SQL = `
CREATE VIRTUAL TABLE ${TABLES.tasks_fts} USING fts5(title, description, tags);
CREATE TRIGGER threads_fts_ai AFTER INSERT ON ${TABLES.threads} BEGIN
  ${ftsRow("NEW.id")}
END;
CREATE TRIGGER threads_fts_au AFTER UPDATE OF title, body ON ${TABLES.threads} BEGIN
  ${ftsRefresh("NEW.id")}
END;
CREATE TRIGGER attributes_fts_ai AFTER INSERT ON ${TABLES.attributes} WHEN NEW.key = 'tags' BEGIN
  ${ftsRefresh("NEW.thread_id")}
END;
CREATE TRIGGER attributes_fts_au AFTER UPDATE ON ${TABLES.attributes} WHEN NEW.key = 'tags' BEGIN
  ${ftsRefresh("NEW.thread_id")}
END;
INSERT INTO ${TABLES.tasks_fts}(rowid, title, description, tags)
SELECT t.rowid, t.title, t.body,
       (SELECT value FROM ${TABLES.attributes}
         WHERE thread_id = t.id AND key = 'tags' AND removed_at IS NULL)
  FROM ${TABLES.threads} t;
`;

export namespace RecordMigration {
	export const migrate = (db: Db): void => {
		refuseUnplaced(db);
		refuseUnreadableClocks(db);
		refuseCrossFamilyRows(db);
		refuseSharedRefKeys(db);
		refuseUnsafeFolds(db);
		moveThreads(db);
		refuseChangedValues(db);
		moveEntries(db);
		moveRefs(db);
		clearOldOps(db);
		retireOldTables(db);
		db.exec(TASK_ROWS_VIEW_SQL);
		db.exec(TASKS_VIEW_SQL);
		db.exec(FTS_SQL);
	};
}
