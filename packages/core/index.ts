/**
 * @kabane/core
 *
 * Local-first issue tracker core: schemas, storage over the Db port, sync.
 * A host supplies a `DbProvider` through
 * `Runtime.configure` and gets the same behaviour on any SQLite engine.
 */

export {
	CONTEXT_BYTES,
	CONTEXT_SECTIONS,
	ContextSectionSchema,
	ContextPageOptionsSchema,
	ContextPageSchema,
	type ContextSection,
	contextSectionsOf,
	type ContextPage,
	type ContextPageOptions,
} from "./context-output";
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
	SCHEMA_SQL,
} from "./db/schema";
export { TABLES, type TableKey } from "./db/tables";
export { Events, PLANNER_EVENTS, type PlannerEventType } from "./events";
// Data modules: a package's own migrations and replicated tables
export type {
	KabaneModule,
	ModuleContextSection,
	ModuleSyncTable,
} from "./module";
// MCP (tool definitions + stdio / Streamable HTTP servers)
export {
	type AfterWrite,
	authorTypeOf,
	callTool,
	createMcpServer,
	defineTool,
	humanActorOf,
	KABANE_TOOLS,
	type McpServerInfo,
	registeredTools,
	SERVER_INSTRUCTIONS,
	type CoreToolInputShapes,
	type ToolContext,
	type ToolDef,
	type ToolHandler,
} from "./mcp";
export { type TracedOptions, traced } from "./observability";
export {
	ResponseFormatSchema,
	taskReceipt,
	serializedBytes,
} from "./task-output";
export { PageOptionsSchema, type TaskPage } from "./storage/task-pages";
export { fingerprintText } from "./storage/read-fingerprint";
export {
	err,
	flatMap,
	map,
	ok,
	quoted,
	type Result,
	toError,
	tryCatch,
	trySync,
	unwrapOr,
	NotFoundError,
} from "./result";
export { ActorUri } from "./actor";
export {
	type ActorSource,
	ANONYMOUS_ACTOR,
	atomic,
	type Notifier,
	Runtime,
	type RuntimeConfig,
	type FileReader,
	type FileHead,
	type SyncSettingsSource,
	type TimezoneSource,
	type Tracer,
	withDb,
} from "./runtime";
// Schemas
export * from "./schemas";
// Scope URIs and the resolved scope type; the CLI owns detection.
export * from "./scope/schemas";
export { ScopeUri } from "./scope/uri";
// Storage
export { normalizeScopeUri, Planner, scopeClause } from "./storage";
export { ActorScheme } from "./storage/actor-scheme";
export { Migrations } from "./storage/migrations";
export { Oplog } from "./storage/oplog";
export { Portable } from "./portable";
export { RecordRead } from "./storage/record";
export { Replicated } from "./replicated";
// Sync (multi-device replication)
export { Backfill } from "./sync/backfill";
export { type ConnectedSync, SyncDevice } from "./sync/device";
export {
	type FetchLike,
	HttpTransport,
	type HttpTransportConfig,
} from "./sync/http-transport";
export { LocalRelay, type Relay } from "./sync/local-relay";
export type { SyncFamily } from "./sync/resolve";
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
