/** Factory-safe helpers and the record activated by a successfully opened context. */
import {
	defineTool,
	err,
	ok,
	registeredTools,
	ScopeUri,
	tryCatch,
	trySync,
	type ToolContext,
} from "@cabane/core";
import { detectScope } from "@cabane/core/scope";
import { Self } from "@cabane/core/self";
import {
	createHostRecord,
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

/** Clear before configuration; publish lazy context only after migration succeeds. */
export const activateHostRecord = (
	home: string,
	context?: () => Promise<ToolContext>,
): void => {
	active = context ? { home, context } : undefined;
};

export const createHost = (home: string): { host: Host; ready: () => void } => {
	let ready = false;
	const host: Host = {
		api: 1,
		kabane: { version, executable: Self.executable() },
		record: createHostRecord(registeredTools, () =>
			ready && active?.home === home ? active.context() : undefined,
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
		ready: () => {
			ready = true;
		},
	};
};
