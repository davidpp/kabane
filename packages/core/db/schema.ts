/**
 * Schema DDL and its application.
 *
 * The DDL is written once with LOGICAL table names. `applySchema` rewrites it
 * for the configured prefix and creates the FTS5 tables and their triggers,
 * so "shared database with a prefix" versus "own database with plain names"
 * is configuration, not a fork of the schema.
 *
 * Idempotent: every statement is IF NOT EXISTS, and it re-runs on every
 * `init`. Column additions to existing tables go through `runMigrations` in
 * `storage/helpers.ts`, never here.
 */

import type { Db } from "./port";
import { tablePrefix } from "./tables";

export type FtsTable = {
	/** Virtual table logical name */
	name: string;
	/** Source table logical name */
	sourceTable: string;
	/** Columns to index */
	columns: string[];
};

export const FTS_TABLES: readonly FtsTable[] = [
	{
		name: "tasks_fts",
		sourceTable: "tasks",
		columns: ["title", "description", "tags"],
	},
	{
		name: "proposals_fts",
		sourceTable: "proposals",
		columns: ["summary", "reasoning"],
	},
	{
		name: "task_comments_fts",
		sourceTable: "task_comments",
		columns: ["content"],
	},
];

/**
 * Apply a table-name prefix to DDL.
 *
 * Handles CREATE TABLE, CREATE [UNIQUE] INDEX, REFERENCES x(, and ON x( —
 * NOT CREATE TRIGGER, which is why capture triggers are built in code from
 * the physical names (see storage/oplog.ts).
 */
export const prefixSql = (sql: string, prefix: string): string => {
	if (prefix === "") return sql;
	return sql
		.replace(
			/CREATE TABLE IF NOT EXISTS (\w+)/gi,
			`CREATE TABLE IF NOT EXISTS ${prefix}$1`,
		)
		.replace(
			/CREATE INDEX IF NOT EXISTS (\w+)/gi,
			`CREATE INDEX IF NOT EXISTS ${prefix}$1`,
		)
		.replace(
			/CREATE UNIQUE INDEX IF NOT EXISTS (\w+)/gi,
			`CREATE UNIQUE INDEX IF NOT EXISTS ${prefix}$1`,
		)
		.replace(/REFERENCES (\w+)\(/gi, `REFERENCES ${prefix}$1(`)
		.replace(/\bON (\w+)\(/gi, `ON ${prefix}$1(`);
};

/** FTS5 virtual table plus the three triggers that keep it in step. */
export const generateFtsSql = (prefix: string, fts: FtsTable): string => {
	const ftsTableName = `${prefix}${fts.name}`;
	const sourceTableName = `${prefix}${fts.sourceTable}`;
	const columns = fts.columns.join(", ");
	const newColumns = fts.columns.map((c) => `NEW.${c}`).join(", ");
	const oldColumns = fts.columns.map((c) => `OLD.${c}`).join(", ");

	return `
CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTableName} USING fts5(
  ${columns},
  content='${sourceTableName}',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS ${ftsTableName}_ai AFTER INSERT ON ${sourceTableName} BEGIN
  INSERT INTO ${ftsTableName}(rowid, ${columns})
  VALUES (NEW.rowid, ${newColumns});
END;

CREATE TRIGGER IF NOT EXISTS ${ftsTableName}_ad AFTER DELETE ON ${sourceTableName} BEGIN
  INSERT INTO ${ftsTableName}(${ftsTableName}, rowid, ${columns})
  VALUES ('delete', OLD.rowid, ${oldColumns});
END;

CREATE TRIGGER IF NOT EXISTS ${ftsTableName}_au AFTER UPDATE ON ${sourceTableName} BEGIN
  INSERT INTO ${ftsTableName}(${ftsTableName}, rowid, ${columns})
  VALUES ('delete', OLD.rowid, ${oldColumns});
  INSERT INTO ${ftsTableName}(rowid, ${columns})
  VALUES (NEW.rowid, ${newColumns});
END;
`;
};

/** Create every base table, index, and FTS table for the configured prefix. */
export const applySchema = (db: Db): void => {
	const prefix = tablePrefix();
	db.exec(prefixSql(SCHEMA_SQL, prefix));
	for (const fts of FTS_TABLES) {
		db.exec(generateFtsSql(prefix, fts));
	}
};

export const SCHEMA_SQL = `
-- ============================================================
-- TASKS (main table)
-- ============================================================

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,              -- ULID (internal, immutable)
  short_id TEXT UNIQUE,             -- Human-friendly ID (JDES-123, JJAK-45)
  title TEXT NOT NULL,
  description TEXT,

  -- Item kind: 'task' (personal GTD) or 'issue' (agent work)
  kind TEXT NOT NULL DEFAULT 'task',

  -- GTD workflow state (validated by Zod, not DB constraint)
  state TEXT NOT NULL DEFAULT 'inbox',

  -- Priority (validated by Zod)
  priority TEXT NOT NULL DEFAULT 'normal',

  -- Scoping (ADR-010 Core Scope system)
  scope_uri TEXT,                   -- jake://scope/<scopeId>?extensions
  scope_refs TEXT,                  -- JSON array of {scopeUri, role}

  -- Time
  deadline TEXT,                    -- ISO datetime
  defer_until TEXT,                 -- ISO datetime
  completed_at TEXT,                -- ISO datetime

  -- Provenance (all TEXT for flexibility)
  source TEXT NOT NULL DEFAULT 'human',
  source_id TEXT,
  source_url TEXT,
  discovered_at TEXT NOT NULL,
  discovered_by TEXT,
  confidence REAL,                  -- 0-1 for AI-created

  -- Ownership
  assignee TEXT,                    -- Freeform: agent name, "me", email

  -- Subtasks
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,

  -- Project (flat grouping layer)
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,

  -- Review (for agent-owned tasks)
  needs_review INTEGER DEFAULT 0,   -- boolean
  reviewed_at TEXT,
  reviewed_by TEXT,

  -- Evidence & Verification (for agent-owned tasks)
  evidence TEXT DEFAULT '[]',       -- JSON array of Evidence objects
  verification TEXT,                -- JSON object (Verification schema)

  -- Context
  tags TEXT,                        -- JSON array
  context TEXT,                     -- GTD context like @home

  -- Replication (see the sync section of CLAUDE.md)
  updated_by TEXT,                  -- actor URI of the last local writer
  version INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'shared',  -- shared | private; private never enters the oplog

  -- Timestamps
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Common query indexes
CREATE INDEX IF NOT EXISTS idx_tasks_kind ON tasks(kind);
CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
CREATE INDEX IF NOT EXISTS idx_tasks_scope ON tasks(scope_uri);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source);
CREATE INDEX IF NOT EXISTS idx_tasks_source_ref ON tasks(source, source_id);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline ON tasks(deadline);
CREATE INDEX IF NOT EXISTS idx_tasks_defer ON tasks(defer_until);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_review ON tasks(needs_review) WHERE needs_review = 1;
-- NOTE: idx_tasks_short_id and idx_tasks_project created by migration
-- (helpers.ts runMigrations) to avoid boot-order issues on existing DBs

-- Composite index for active tasks view
CREATE INDEX IF NOT EXISTS idx_tasks_active ON tasks(state, priority, deadline);

-- ============================================================
-- PROJECTS (flat grouping layer between scope and tasks)
-- ============================================================

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,              -- ULID (internal, immutable)
  short_id TEXT UNIQUE,             -- Human-friendly ID (JPRJ-1)
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'active',  -- active, someday, done, archived
  scope_uri TEXT,                   -- Canonical, branch-agnostic scope
  updated_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'shared',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_state ON projects(state);
CREATE INDEX IF NOT EXISTS idx_projects_scope ON projects(scope_uri);
CREATE INDEX IF NOT EXISTS idx_projects_short_id ON projects(short_id);

-- ============================================================
-- TASK LINKS (N:N relationships)
-- ============================================================

CREATE TABLE IF NOT EXISTS task_links (
  id TEXT PRIMARY KEY,              -- ULID
  source_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,               -- parent, child, blocks, etc.
  note TEXT,
  updated_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'shared',
  created_at TEXT NOT NULL,

  -- Prevent duplicate links of same type
  UNIQUE(source_id, target_id, type)
);

CREATE INDEX IF NOT EXISTS idx_links_source ON task_links(source_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON task_links(target_id);
CREATE INDEX IF NOT EXISTS idx_links_type ON task_links(type);

-- ============================================================
-- FOCUS LISTS (daily/weekly planning)
-- Two persistent buckets (daily/weekly), no date - just period discriminator
-- ============================================================

CREATE TABLE IF NOT EXISTS focus_lists (
  id TEXT PRIMARY KEY,              -- ULID
  period TEXT NOT NULL UNIQUE,      -- daily or weekly (one per period)
  items TEXT NOT NULL DEFAULT '[]', -- JSON array of FocusItem
  theme TEXT,
  reflection TEXT,
  updated_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'shared',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_focus_period ON focus_lists(period);

-- ============================================================
-- PROPOSALS (AI suggestions queue)
-- ============================================================

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,              -- ULID
  action TEXT NOT NULL,             -- create_task, update_task, etc.
  status TEXT NOT NULL DEFAULT 'pending',
  confidence REAL NOT NULL,         -- 0-1
  summary TEXT NOT NULL,
  reasoning TEXT,
  payload TEXT NOT NULL,            -- JSON (discriminated union)
  session_id TEXT,
  task_id TEXT,                     -- Optional: links proposal to a task/issue for inline display
  context TEXT,
  expires_at TEXT,
  reviewed_at TEXT,
  review_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
CREATE INDEX IF NOT EXISTS idx_proposals_action ON proposals(action);
CREATE INDEX IF NOT EXISTS idx_proposals_expires ON proposals(expires_at);
CREATE INDEX IF NOT EXISTS idx_proposals_task ON proposals(task_id);

-- Pending proposals view helper
CREATE INDEX IF NOT EXISTS idx_proposals_pending ON proposals(status, created_at)
  WHERE status = 'pending';

-- ============================================================
-- SEQUENCES (for Linear-style short IDs)
-- ============================================================
-- Per-prefix incrementing sequence for human-friendly task IDs.
-- Example: JDES-1, JDES-2, JJAK-1, JJAK-2, JALL-1, etc.

CREATE TABLE IF NOT EXISTS sequences (
  prefix TEXT PRIMARY KEY,            -- Uppercase 4-char prefix (J + 3 chars, e.g., JDES)
  next_number INTEGER NOT NULL DEFAULT 1,
  scope_uri TEXT,                     -- Optional: scope this prefix is derived from
  created_at TEXT NOT NULL
);

-- ============================================================
-- TASK COMMENTS (editable, human-facing discussions)
-- ============================================================

CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,              -- ULID
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author TEXT NOT NULL,             -- User name or agent identifier
  author_type TEXT NOT NULL,        -- 'human' or 'ai'
  content TEXT NOT NULL,            -- Markdown content
  updated_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'shared',
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_comments_task ON task_comments(task_id);
CREATE INDEX IF NOT EXISTS idx_comments_created ON task_comments(created_at DESC);

-- ============================================================
-- TASK WORK LOG (URI references to work accomplished)
-- ============================================================

CREATE TABLE IF NOT EXISTS task_work_log (
  id TEXT PRIMARY KEY,              -- ULID
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  refs TEXT NOT NULL,               -- JSON array of WorkRef
  note TEXT,                        -- Optional context/summary
  updated_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'shared',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_work_log_task ON task_work_log(task_id);
CREATE INDEX IF NOT EXISTS idx_work_log_created ON task_work_log(created_at DESC);

-- ============================================================
-- TASK ACTIVITY (audit trail for field changes)
-- ============================================================

CREATE TABLE IF NOT EXISTS task_activity (
  id TEXT PRIMARY KEY,              -- ULID
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,         -- created, state_changed, assigned, etc.
  actor TEXT NOT NULL,              -- Who triggered the event
  actor_type TEXT NOT NULL,         -- 'human' or 'ai'
  timestamp TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_task ON task_activity(task_id);
CREATE INDEX IF NOT EXISTS idx_activity_timestamp ON task_activity(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_activity_type ON task_activity(event_type);

-- ============================================================
-- TASK CONTEXT REFS (curated input context registry, S2)
-- ============================================================
-- The input side of an issue: a curated set of context refs (PRD, ADR,
-- research, transcripts). Distinct from the append-only work log.
-- Re-promoting the same (task_id, uri) upserts kind/label/note/added_at.

CREATE TABLE IF NOT EXISTS task_context_refs (
  id TEXT PRIMARY KEY,              -- ULID
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  uri TEXT NOT NULL,
  kind TEXT NOT NULL,               -- soft string (PRD, ADR, research, ...)
  label TEXT,
  note TEXT,
  added_by TEXT,
  added_by_type TEXT,               -- 'human' or 'ai'
  added_at TEXT NOT NULL,
  updated_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'shared',

  UNIQUE(task_id, uri)
);

CREATE INDEX IF NOT EXISTS idx_context_refs_task ON task_context_refs(task_id);

-- ============================================================
-- UPSTREAM LINKS (private external work-item snapshots)
-- ============================================================
-- Local-only relationship between a Jake implementation root and an external
-- team work item. Explicit snapshot columns prevent provider payloads or
-- credentials from leaking into Planner storage.

CREATE TABLE IF NOT EXISTS upstream_links (
  id TEXT PRIMARY KEY,              -- ULID
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,           -- soft string; Linear is the first known value
  external_id TEXT NOT NULL,        -- stable opaque provider ID
  identifier TEXT,                  -- human-readable key such as ENG-123
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT,
  external_updated_at TEXT,
  refreshed_at TEXT NOT NULL,       -- Jake-local snapshot refresh time
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- The privacy invariant as schema, not prose: no writer sets this to
  -- 'shared', so capture can never admit an upstream link to the oplog.
  visibility TEXT NOT NULL DEFAULT 'private',

  UNIQUE(task_id, provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_upstream_links_external ON upstream_links(provider, external_id);

-- ============================================================
-- AGENT SESSIONS (S4a — the container for agent work)
-- ============================================================
-- A session with a lifecycle, keyed to the subtask being worked. Sessions are
-- OPTIONAL FOREVER: nothing on the task/comment/work-log paths depends on them.
-- last_activity_at is bumped on every activity/transition and drives staleness.

CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,              -- ULID
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,              -- freeform: agent name, model, wave id
  state TEXT NOT NULL DEFAULT 'active',  -- soft string (pending|active|awaiting_input|complete|error|stale)
  external_ref TEXT,                -- loop state file / Claude session id / wave id
  summary TEXT,                     -- final-response excerpt (S5 card reads it)
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,   -- bumped on every activity/transition
  ended_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_task ON agent_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_state ON agent_sessions(state);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_last_activity ON agent_sessions(last_activity_at DESC);

-- ============================================================
-- AGENT ACTIVITIES (S4a — typed activities within a session)
-- ============================================================
-- Append-only. Ephemeral rows (e.g. a spinner) are folded at query time
-- (durable + latest ephemeral only) and compacted on session close.
-- NOTE: first planner-internal FK between two NEW tables. prefixSql rewrites
-- the REFERENCES target agent_sessions to planner_agent_sessions (verified
-- against packages/core/db/registry.ts prefixSql; the rewrite is content-
-- agnostic, so new-to-new works exactly like new-to-existing).

CREATE TABLE IF NOT EXISTS agent_activities (
  id TEXT PRIMARY KEY,              -- ULID
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,               -- soft string (progress|action|finding|verification|decision|handoff|response|error|question)
  ephemeral INTEGER NOT NULL DEFAULT 0,
  severity TEXT,                    -- P1|P2|P3 (finding/verification)
  category TEXT,
  context TEXT,                     -- THE one context field (self-contained for question/decision)
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_activities_session ON agent_activities(session_id);
-- Durable activities are the common read; partial index keeps it tight.
CREATE INDEX IF NOT EXISTS idx_agent_activities_durable ON agent_activities(session_id, created_at) WHERE ephemeral = 0;

-- ============================================================
-- SYNC OPLOG (captured row mutations awaiting replication)
-- ============================================================
-- Append-only queue written by the capture triggers in storage/oplog.ts.
-- seq is the local total order and the only ordering that matters here;
-- op_id is the remote idempotency key, so a retried push is a no-op.
-- NOTE: the triggers that write this table are built in TypeScript, not here —
-- prefixSql does not rewrite CREATE TRIGGER, so raw trigger DDL in this string
-- would reference unprefixed tables that do not exist.

CREATE TABLE IF NOT EXISTS sync_oplog (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  op_id TEXT NOT NULL UNIQUE,       -- idempotency key (random hex, minted at capture)
  device_id TEXT NOT NULL,
  tbl TEXT NOT NULL,                -- logical (unprefixed) table name
  row_id TEXT NOT NULL,
  op TEXT NOT NULL,                 -- soft string: insert|update|delete
  row_updated_at TEXT,              -- LWW clock; NULL for deletes and clock-less tables
  payload TEXT,                     -- JSON row snapshot; NULL for delete
  captured_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_oplog_row ON sync_oplog(tbl, row_id);

-- ============================================================
-- SYNC STATE (singleton row keyed 'local')
-- ============================================================
-- Presence of the 'local' row is what ARMS capture: with no row, the storage
-- layer's capture step returns early and write cost stays at baseline for
-- anyone who never enables sync. apply_guard is legacy from trigger-based
-- capture (the applier writes rows directly and never enters the capture
-- path); the column stays so existing databases keep booting.
-- No CHECK constraint on the singleton key — house style forbids them.

CREATE TABLE IF NOT EXISTS sync_state (
  id TEXT PRIMARY KEY,              -- always 'local'
  device_id TEXT NOT NULL,
  last_pushed_seq INTEGER NOT NULL DEFAULT 0,   -- local sync_oplog.seq watermark
  last_applied_seq INTEGER NOT NULL DEFAULT 0,  -- remote server_seq watermark
  apply_guard INTEGER NOT NULL DEFAULT 0,       -- boolean: suppress capture
  last_sync_at TEXT,
  updated_at TEXT NOT NULL
);

-- ============================================================
-- SYNC QUARANTINE (ops the remote will never accept)
-- ============================================================
-- The remote batch is atomic, so a single op it refuses — an oversized row is
-- the reachable case, since task descriptions are PRDs — fails every retry that
-- includes it and sync stalls SILENTLY FOREVER. The transport isolates such an
-- op, records it here, and lets the watermark move past it. A visible skipped
-- op is recoverable; an invisible permanent stall is not.
-- Machine-local, like upstream_links: NOT in SYNC_TABLES, so no capture
-- triggers are built for it and it never replicates.

CREATE TABLE IF NOT EXISTS sync_quarantine (
  op_id TEXT PRIMARY KEY,           -- the refused op; its row stays in sync_oplog
  tbl TEXT NOT NULL,                -- logical table, for finding what didn't replicate
  row_id TEXT NOT NULL,
  bytes INTEGER NOT NULL,           -- serialized size; usually the reason
  reason TEXT NOT NULL,             -- what the remote said, verbatim
  quarantined_at TEXT NOT NULL
);

-- ============================================================
-- SHORT ID HISTORY (alias trail for renamed labels)
-- ============================================================
-- Two machines can independently allocate the same short ID offline. The
-- rename protocol keeps one and reassigns the other, recording the old label
-- here as an AUDIT TRAIL. Not a lookup fallback: the winner keeps the label
-- live, so resolving it finds the winner's real row and never reaches this
-- table. See the short_id ruling in packages/planner/CLAUDE.md.

CREATE TABLE IF NOT EXISTS short_id_history (
  old_short_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  superseded_at TEXT NOT NULL
);
`;
