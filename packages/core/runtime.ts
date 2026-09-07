/**
 * Runtime wiring — the ports a host plugs into the core.
 *
 * Storage functions take a `basePath` string, not a database handle, so they
 * need one place to turn that string into a `Db`. This is that place. A host
 * (the CLI, Jake, the Worker) calls `Runtime.configure` once at startup; core
 * code calls `withDb` and never learns which engine is underneath.
 *
 * Every port has a default that does nothing, so the core is usable with only
 * a `DbProvider` configured. The tracer and notifier are cross-cutting hooks a
 * host may wire to its own observability and event bus.
 */

import type { Db, DbProvider } from "./db/port";
import { setTablePrefix } from "./db/tables";
import { err, ok, type Result } from "./result";
import { type SyncConfig, SyncConfigSchema } from "./schemas/config";

// ============================================================
// Port types
// ============================================================

export type TracedOptions<TArgs extends unknown[], TReturn> = {
	/** Extract attributes from input args */
	attrs?: (...args: TArgs) => Record<string, string | number | boolean>;
	/** Extract attributes from a successful result */
	resultAttrs?: (result: TReturn) => Record<string, string | number | boolean>;
};

/** Wraps an orchestration function in a span. Identity by default. */
export type Tracer = <TArgs extends unknown[], TReturn>(
	spanName: string,
	fn: (...args: TArgs) => Promise<Result<TReturn>>,
	options?: TracedOptions<TArgs, TReturn>,
) => (...args: TArgs) => Promise<Result<TReturn>>;

/** Receives domain events (task created, updated, deleted). No-op by default. */
export type Notifier = (type: string, payload: unknown) => Promise<void>;

/**
 * Resolves a working directory to a stable project identity for the
 * session-defaults fallback key. Returns null when the host has no notion of
 * project identity, which is the default.
 */
export type ScopeResolver = (cwd: string) => Promise<string | null>;

/** Where the sync block comes from. Default: sync disabled. */
export type SyncSettingsSource = () => Promise<Result<SyncConfig>>;

/**
 * Who is writing. Returns an actor URI (`cabane://actor/human/david`,
 * `cabane://actor/agent/claude`) stamped into `updated_by` on every local
 * write. A function rather than a value so a host serving several identities
 * (the hub) can answer per request. Default: an anonymous actor.
 */
export type ActorSource = () => string;

export const ANONYMOUS_ACTOR = "cabane://actor/unknown";

export type RuntimeConfig = {
	provider: DbProvider;
	/** Physical table-name prefix, e.g. "planner_". Default: none. */
	tablePrefix?: string;
	tracer?: Tracer;
	notifier?: Notifier;
	scopeResolver?: ScopeResolver;
	syncSettings?: SyncSettingsSource;
	actor?: ActorSource;
};

// ============================================================
// Defaults
// ============================================================

const identityTracer: Tracer = (_name, fn) => fn;
const silentNotifier: Notifier = async () => {};
const noScope: ScopeResolver = async () => null;
const anonymous: ActorSource = () => ANONYMOUS_ACTOR;
const syncDisabled: SyncSettingsSource = async () => {
	const parsed = SyncConfigSchema.safeParse({});
	return parsed.success
		? ok(parsed.data)
		: err(new Error(parsed.error.message));
};

const unconfigured: DbProvider = {
	withDb: async () =>
		err(
			new Error(
				"No Db provider configured. Call Runtime.configure({ provider }) before using storage.",
			),
		),
};

type Ports = Required<Omit<RuntimeConfig, "tablePrefix">>;

let ports: Ports = {
	provider: unconfigured,
	tracer: identityTracer,
	notifier: silentNotifier,
	scopeResolver: noScope,
	syncSettings: syncDisabled,
	actor: anonymous,
};

// ============================================================
// Runtime namespace
// ============================================================

export namespace Runtime {
	export const configure = (config: RuntimeConfig): void => {
		ports = {
			provider: config.provider,
			tracer: config.tracer ?? identityTracer,
			notifier: config.notifier ?? silentNotifier,
			scopeResolver: config.scopeResolver ?? noScope,
			syncSettings: config.syncSettings ?? syncDisabled,
			actor: config.actor ?? anonymous,
		};
		setTablePrefix(config.tablePrefix ?? "");
	};

	export const tracer = (): Tracer => ports.tracer;
	export const notifier = (): Notifier => ports.notifier;
	export const scopeResolver = (): ScopeResolver => ports.scopeResolver;
	export const syncSettings = (): SyncSettingsSource => ports.syncSettings;
	/** The actor URI to stamp on a local write, resolved now. */
	export const actor = (): string => ports.actor();
}

/** Run `fn` against the database behind `basePath`. The one storage entry. */
export const withDb = <T>(
	basePath: string,
	fn: (db: Db) => T | Promise<T>,
): Promise<Result<T>> => ports.provider.withDb(basePath, fn);

/**
 * Run `fn` inside one write transaction, so a multi-step apply either lands
 * whole or not at all. `fn` may await between statements — this is why it is
 * BEGIN/COMMIT by hand rather than `db.transaction`, which is synchronous.
 * A provider that cannot issue BEGIN (Durable Object SQLite) supplies its own
 * `atomic`.
 */
export const atomic = <T>(
	basePath: string,
	fn: (db: Db) => T | Promise<T>,
): Promise<Result<T>> => {
	if (ports.provider.atomic) return ports.provider.atomic(basePath, fn);
	return ports.provider.withDb(basePath, async (db) => {
		db.run("BEGIN IMMEDIATE");
		try {
			const value = await fn(db);
			db.run("COMMIT");
			return value;
		} catch (e) {
			db.run("ROLLBACK");
			throw e;
		}
	});
};
