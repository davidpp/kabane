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
import { harnessMode, loadConfig } from "./config";

let active: { home: string; context: ToolContext } | undefined;

/** Clear before configuration, publish only after migration and scope resolution succeed. */
export const activateHostRecord = (
	home: string,
	context?: ToolContext,
): void => {
	active = context ? { home, context } : undefined;
};

export const createHost = (home: string): Host => ({
	api: 1,
	kabane: { version, executable: Self.executable() },
	record: createHostRecord(registeredTools, () =>
		active?.home === home ? active.context : undefined,
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
		const config = loadConfig(home);
		return config.ok ? harnessMode(config.value) : "auto";
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
});
