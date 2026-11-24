/**
 * Migration 14: today's task tables move onto the 2.0 record (ADR 0006,
 * JCAB-660), and the task read becomes a view over it.
 *
 * - `tasks` → `threads`; every task column that left the thread row becomes an
 *   attribute under its own column name, `discovered_by` is the thread's
 *   `created_by`, and a `parent` or `child` link folds into the thread's
 *   parent.
 * - `task_comments` → `entries`, kind kept, `author_type` (and `updated_at`
 *   when set) in `data`; `task_work_log` → `entries` of kind `log`, the refs
 *   in `data`.
 * - `task_links` → `refs` to `kabane://thread/<target>`, the link type as kind;
 *   `task_context_refs` → `refs` of their own kind, the label as title;
 *   `upstream_links` → `refs` of kind `upstream` whose URI is
 *   `<provider>:<external id>`.
 *
 * Every value is taken from the source row, never this device's clock or
 * actor, so two copies migrated apart write the same rows. A source column
 * this file does not place fails the migration, and so does a parent link
 * that disagrees with the child's own parent: nothing is dropped unread.
 *
 * `tasks` itself is renamed to `retired_tasks`, not dropped. With
 * `foreign_keys = ON` a DROP deletes every row first, and each data module
 * table that references `tasks(id) ON DELETE CASCADE` would lose its rows;
 * renamed, those references follow the table and the rows stay. Each module
 * drops its reference in a migration of its own, which runs after core's.
 *
 * Then `tasks` is a view: the old task row, assembled from the thread and its
 * attributes, over the record's visibility rule (`VISIBLE_THREADS_SQL`), so a
 * deleted thread and everything under it reads as gone. `tasks_fts` indexes
 * threads, kept in step by triggers so a pulled row is searchable too.
 */

import type { Db } from "../db/port";
import { TABLES } from "../db/tables";
import { RecordKey } from "../schemas";
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
 * Every column of each source table this migration places somewhere. The ids
 * of links, context refs and upstream links are not carried over: a ref's
 * identity is its thread, URI and kind.
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

/** A parent or child link whose child already has a different parent cannot fold. */
const refuseParentConflicts = (db: Db): void => {
	const conflicts = db
		.query<{ id: string }, []>(
			`SELECT l.id FROM task_links l
			   JOIN tasks c ON c.id = CASE l.type WHEN 'parent' THEN l.target_id ELSE l.source_id END
			  WHERE l.type IN ('parent', 'child')
			    AND c.parent_task_id IS NOT NULL
			    AND c.parent_task_id <> CASE l.type WHEN 'parent' THEN l.source_id ELSE l.target_id END`,
		)
		.all();
	if (conflicts.length > 0)
		throw new Error(
			`parent links disagree with their child's parent (${conflicts.map(({ id }) => id).join(", ")}); nothing was changed`,
		);
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
		        discovered_by, created_at, visibility, updated_at, updated_by,
		        '', version, state, assignee, updated_at,
		        updated_by, '', 1, NULL, NULL
		   FROM tasks`,
	);
	// A `parent` link's source is the parent; a `child` link's target is.
	db.run(
		`UPDATE ${TABLES.threads}
		    SET parent_id = (
		      SELECT CASE l.type WHEN 'parent' THEN l.source_id ELSE l.target_id END
		        FROM task_links l
		       WHERE l.type IN ('parent', 'child')
		         AND ${TABLES.threads}.id = CASE l.type WHEN 'parent' THEN l.target_id ELSE l.source_id END)
		  WHERE parent_id IS NULL
		    AND id IN (SELECT CASE type WHEN 'parent' THEN target_id ELSE source_id END
		                 FROM task_links WHERE type IN ('parent', 'child'))`,
	);
	for (const key of TASK_ATTRIBUTES) {
		db.run(
			`INSERT INTO ${TABLES.attributes}
			   (thread_id, key, value, removed_at, visibility, updated_at, updated_by, updated_device, version)
			 SELECT id, '${key}', ${key}, NULL, visibility, updated_at, updated_by, '', 1
			   FROM tasks WHERE ${key} IS NOT NULL`,
		);
	}
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
		        visibility, created_at, updated_by, '', version
		   FROM task_comments`,
	);
	db.run(
		`INSERT INTO ${TABLES.entries}
		   (id, thread_id, kind, kind_version, author, body, addressed_to, re, data,
		    visibility, created_at, updated_by, created_device, version)
		 SELECT id, task_id, 'log', NULL, COALESCE(updated_by, ''), note, NULL, NULL,
		        json_object('refs', json(refs)),
		        visibility, created_at, updated_by, '', version
		   FROM task_work_log`,
	);
};

const REF_COLUMNS = `(thread_id, uri, kind, kind_version, title, data, removed_at,
  visibility, updated_at, updated_by, updated_device, version)`;

const moveRefs = (db: Db): void => {
	db.run(
		`INSERT INTO ${TABLES.refs} ${REF_COLUMNS}
		 SELECT source_id, '${RecordKey.THREAD_URI_PREFIX}' || target_id, type, NULL, NULL,
		        CASE WHEN note IS NULL
		             THEN json_object('created_at', created_at)
		             ELSE json_object('note', note, 'created_at', created_at) END,
		        NULL, visibility, created_at, updated_by, '', version
		   FROM task_links WHERE type NOT IN ('parent', 'child')`,
	);
	db.run(
		`INSERT INTO ${TABLES.refs} ${REF_COLUMNS}
		 SELECT task_id, uri, kind, NULL, label,
		        json_object('note', note, 'added_by', added_by,
		                    'added_by_type', added_by_type, 'added_at', added_at),
		        NULL, visibility, added_at, updated_by, '', version
		   FROM task_context_refs`,
	);
	db.run(
		`INSERT INTO ${TABLES.refs} ${REF_COLUMNS}
		 SELECT task_id, provider || ':' || external_id, 'upstream', NULL, title,
		        json_object('provider', provider, 'external_id', external_id,
		                    'identifier', identifier, 'url', url, 'created_at', created_at),
		        NULL, visibility, updated_at, updated_by, '', version
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
 * The old task row. `version` counts every write to the thread's registers
 * and attributes, so a migrated task keeps its own; `updated_at` is the latest
 * of them; `updated_by` the writer of the later register.
 */
const TASKS_VIEW_SQL = `
CREATE VIEW ${TABLES.tasks} AS
${VISIBLE_THREADS_SQL}
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
       t.assignee, v.parent_id AS parent_task_id, ${attr("project_id")} AS project_id,
       COALESCE(CAST(${attr("needs_review")} AS INTEGER), 0) AS needs_review,
       ${attr("reviewed_at")} AS reviewed_at, ${attr("reviewed_by")} AS reviewed_by,
       COALESCE(${attr("evidence")}, '[]') AS evidence, ${attr("verification")} AS verification,
       COALESCE(${attr("tags")}, '[]') AS tags, ${attr("context")} AS context,
       CASE WHEN t.state_updated_at > t.updated_at THEN t.state_updated_by ELSE t.updated_by END AS updated_by,
       t.version + t.state_version - 1
         + COALESCE((SELECT SUM(a.version - 1) FROM ${TABLES.attributes} a WHERE a.thread_id = t.id), 0)
         AS version,
       t.visibility, t.created_at,
       MAX(t.updated_at, t.state_updated_at,
           COALESCE((SELECT MAX(a.updated_at) FROM ${TABLES.attributes} a WHERE a.thread_id = t.id), ''))
         AS updated_at
  FROM ${TABLES.threads} t JOIN visible_threads v ON v.id = t.id`;

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
		refuseParentConflicts(db);
		moveThreads(db);
		moveEntries(db);
		moveRefs(db);
		clearOldOps(db);
		retireOldTables(db);
		db.exec(TASKS_VIEW_SQL);
		db.exec(FTS_SQL);
	};
}
