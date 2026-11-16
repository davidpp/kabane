/** Real host helpers and tool-backed record for a disposable test database. */
import {
	registeredTools,
	Runtime,
	ok,
	err,
	tryCatch,
	trySync,
	defineTool,
	ScopeUri,
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
	success,
	conciseSuccess,
	failure,
	usage,
	Settings,
} from "@cabane/extension";
import { z } from "zod";
import { Kabane } from "./result";

Kabane.bind({ result: { ok, err, tryCatch, trySync } });

export const testHost = (basePath: string, actor = Runtime.actor()): Host => ({
	api: 1,
	kabane: { version: "test", executable: Self.executable() },
	record: createHostRecord(registeredTools, {
		basePath,
		actor,
		scopeRequired: false,
	}),
	store: createHostStore(
		() => basePath,
		() => [],
		"loop test",
	),
	scope: {
		detect: (dir) =>
			tryCatch(() =>
				detectScope(dir, { home: basePath, detectExtensions: false }),
			),
		idOf: ScopeUri.getScopeId,
	},
	harnessMode: "auto",
	z,
	result: { ok, err, tryCatch, trySync },
	args: { flagBool, flagCsv, flagList, flagString },
	outcome: { success, conciseSuccess, failure, usage },
	settings: {
		fields: Settings.fields,
		groupsOf: Settings.groupsOf,
		lookOf: Settings.lookOf,
		options: Settings.options,
	},
	defineTool,
});
