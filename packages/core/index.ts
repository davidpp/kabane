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
// Db port conformance (adapter test suites run these)
export { type ConformanceCase, conformanceCases } from "./db/conformance";
// Schema migrations: the runner and the list it applies
export { Migrate } from "./db/migrate";
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
// MCP (tool definitions + stdio / Streamable HTTP servers)
export {
	type AfterWrite,
	authorTypeOf,
	createMcpServer,
	handleHttpRequest,
	KABANE_TOOLS,
	type McpServerInfo,
	SERVER_INSTRUCTIONS,
	serveStdio,
	type ToolContext,
	type ToolDef,
	type ToolHandler,
} from "./mcp";
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
	type TimezoneSource,
	type Tracer,
	withDb,
} from "./runtime";
// Schemas
export * from "./schemas";
// Scope URIs (parse/format only). Resolving a cwd to a scope lives in
// `@cabane/core/scope`, kept off the barrel because it needs git and a
// filesystem — neither of which the Worker runtime has.
export * from "./scope/schemas";
export { ScopeUri } from "./scope/uri";
// Storage
export { normalizeScopeUri, Planner } from "./storage";
export { Migrations } from "./storage/migrations";
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
