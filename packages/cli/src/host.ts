/** Factory-safe helpers and the record activated by a successfully opened context. */
import {
	defineTool,
	err,
	type KabaneModule,
	ok,
	registeredTools,
	type Result,
	ScopeUri,
	tryCatch,
	trySync,
	type ToolContext,
} from "@cabane/core";
import { detectScope } from "@cabane/core/scope";
import { Self } from "@cabane/core/self";
import {
	createHostRecord,
	createHostStore,
	type Host,
	flagBool,
	flagCsv,
	flagList,
	flagString,
	conciseSuccess,
	failure,
	success,
	usage,
	Settings,
} from "@cabane/extension";
import { z } from "zod";
import { version } from "../package.json";
import { type Config, harnessMode, loadConfig } from "./config";

const modes = new Map<string, Host["harnessMode"]>();

/** One mode per device invocation, shared with the command context. */
export const hostHarnessMode = (
	home: string,
	config?: Config,
): Host["harnessMode"] => {
	const cached = modes.get(home);
	if (cached !== undefined) return cached;
	const loaded = config ? ok(config) : loadConfig(home);
	// A config-less standalone context (including doctor diagnosing broken config) uses auto.
	const mode = loaded.ok ? harnessMode(loaded.value) : "auto";
	modes.set(home, mode);
	return mode;
};

let active: { home: string; context: () => Promise<ToolContext> } | undefined;

/**
 * Clear before configuration; publish lazy context only after migration succeeds. `record` and
 * `store` of every host on `home` work while it is published.
 */
export const activateHostRecord = (
	home: string,
	context?: () => Promise<ToolContext>,
): void => {
	active = context ? { home, context } : undefined;
};

/** A host and what the loader does with it. */
export type StagedHost = {
	host: Host;
	/**
	 * Run one of the extension's factories with `host`. `record` and `store` refuse calls while a
	 * factory runs and until one has returned.
	 */
	build: <T>(factory: (host: Host) => T | Promise<T>) => Promise<Result<T>>;
	/** The modules the extension's modules entry built: `store` captures only their tables. */
	own: (modules: readonly KabaneModule[]) => void;
};

/** `name` is the extension's, for the messages its writes give. */
export const createHost = (home: string, name = "an extension"): StagedHost => {
	let returned = false;
	let building = 0;
	let tables: readonly string[] = [];
	const live = () => returned && building === 0 && active?.home === home;
	const host: Host = {
		api: 1,
		kabane: { version, executable: Self.executable() },
		record: createHostRecord(registeredTools, () =>
			live() ? active?.context() : undefined,
		),
		store: createHostStore(
			() => (live() ? home : undefined),
			() => tables,
			`extension ${name}`,
		),
		scope: {
			detect: (dir) =>
				tryCatch(() => detectScope(dir, { home, detectExtensions: false })),
			idOf: (uri) => {
				const parsed = trySync(() => ScopeUri.getScopeId(uri));
				return parsed.ok ? parsed.value : parsed;
			},
		},
		get harnessMode() {
			return hostHarnessMode(home);
		},
		z,
		result: { ok, err, tryCatch, trySync },
		args: { flagBool, flagString, flagList, flagCsv },
		outcome: { success, conciseSuccess, failure, usage },
		settings: {
			fields: Settings.fields,
			groupsOf: Settings.groupsOf,
			lookOf: Settings.lookOf,
			options: Settings.options,
		},
		defineTool,
	};
	return {
		host,
		build: async (factory) => {
			building++;
			const built = await tryCatch(async () => factory(host));
			building--;
			if (built.ok) returned = true;
			return built;
		},
		own: (modules) => {
			tables = modules.flatMap((module) =>
				(module.syncTables ?? []).map((spec) => spec.table),
			);
		},
	};
};

const hosts = new Map<string, StagedHost>();

/**
 * The one host of extension `name` on `home` in this process, so its modules entry and its main
 * entry receive the same object.
 */
export const hostFor = (home: string, name: string): StagedHost => {
	const key = `${home}\0${name}`;
	const cached = hosts.get(key);
	if (cached) return cached;
	const staged = createHost(home, name);
	hosts.set(key, staged);
	return staged;
};
