/** Real record helpers with pinned scope data for disposable test repositories. */
import { readFileSync, realpathSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type ProjectScope,
	registeredTools,
	Runtime,
	ok,
	err,
	tryCatch,
	trySync,
	defineTool,
	ScopeUri,
} from "@kabane/core";
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
} from "@kabane/extension";
import { z } from "zod";
import { Kabane } from "./result";

Kabane.bind({ result: { ok, err, tryCatch, trySync } });

/** Scope data shared by the fixture repository and its host. Detection is tested in the CLI. */
export const pinTestScope = (root: string): void => {
	mkdirSync(join(root, ".kabane"), { recursive: true });
	writeFileSync(join(root, ".kabane/scope"), "loop-test\n");
};

export const testScope = (root: string): ProjectScope | null => {
	try {
		const scopeId = readFileSync(join(root, ".kabane/scope"), "utf8").trim();
		return {
			root: realpathSync(root),
			scopeId,
			name: scopeId,
			extensions: {},
			scopeUri: ScopeUri.format({ scopeId }),
		};
	} catch {
		return null;
	}
};

export const testHost = (
	basePath: string,
	actor = Runtime.actor(),
	project?: ProjectScope | null,
): Host => ({
	api: 1,
	kabane: { version: "test", executable: "/nonexistent/kabane" },
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
		detect: async (dir) => {
			const resolved = trySync(() => realpathSync(dir));
			const path = resolved.ok ? resolved.value : dir;
			return ok(
				project &&
					(path === project.root || path.startsWith(`${project.root}/`))
					? project
					: testScope(dir),
			);
		},
		idOf: ScopeUri.getScopeId,
	},
	harnessMode: "auto",
	device: "test",
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
