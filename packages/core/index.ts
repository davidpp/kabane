/**
 * @cabane/core
 *
 * Local-first issue tracker core: schemas, storage over the Db port, sync,
 * plan lint, and commit linking. A host supplies a `DbProvider` through
 * `Runtime.configure` and gets the same behaviour on any SQLite engine.
 */

export type { GitCommit, ScanResult } from "./commit-linker/namespace";
// Commit Linker
export { CommitLinker } from "./commit-linker/namespace";
export {
	hasCloseKeyword,
	PATTERNS,
	parseAllTaskIds,
	parseCloseKeywords,
	parseConventionalCommit,
	parseReferences,
	TASK_ID_PATTERN,
} from "./commit-linker/patterns";
// Ports and runtime wiring
export type {
	Changes,
	Db,
	DbProvider,
	DbStatement,
	Row,
	SqlValue,
} from "./db/port";
export {
	applySchema,
	FTS_TABLES,
	type FtsTable,
	generateFtsSql,
	prefixSql,
	SCHEMA_SQL,
} from "./db/schema";
export {
	LOGICAL_TABLES,
	physicalTable,
	TABLES,
	type TableKey,
	tablePrefix,
} from "./db/tables";
export { Events, PLANNER_EVENTS, type PlannerEventType } from "./events";
// Lint (plan quality checks)
export * from "./lint";
export { type TracedOptions, traced } from "./observability";
export {
	err,
	flatMap,
	map,
	ok,
	type Result,
	toError,
	tryCatch,
	trySync,
	unwrapOr,
} from "./result";
export {
	type ActorSource,
	ANONYMOUS_ACTOR,
	atomic,
	type Notifier,
	Runtime,
	type RuntimeConfig,
	type ScopeResolver,
	type SyncSettingsSource,
	type Tracer,
	withDb,
} from "./runtime";
// Schemas
export * from "./schemas";
// Scope URIs (parse/format only — resolution is the host's job)
export * from "./scope/schemas";
export { ScopeUri } from "./scope/uri";
// Storage
export { normalizeScopeUri, Planner } from "./storage";
export { Oplog } from "./storage/oplog";
// Sync (multi-device replication)
export { Backfill } from "./sync/backfill";
export { type ConnectedSync, SyncDevice } from "./sync/device";
export {
	type FetchLike,
	HttpTransport,
	type HttpTransportConfig,
} from "./sync/http-transport";
export { LocalRelay, type Relay } from "./sync/local-relay";
export {
	type PullResult,
	type PushResult,
	Sync,
	type SyncOpts,
} from "./sync/namespace";
export type {
	PullPage,
	PushAck,
	RelayOp,
	SyncTransport,
} from "./sync/transport";
