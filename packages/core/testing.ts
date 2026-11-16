/**
 * Test wiring — NOT part of the public API.
 *
 * Importing this module configures the runtime with the bun:sqlite provider,
 * which is what every core test runs against. The owner's timezone is pinned
 * to UTC so a test that takes "today" does not
 * depend on the machine's zone or the hour it runs; a test about zones passes
 * one explicitly.
 */

import { existsSync, readFileSync } from "node:fs";
import { SqliteDb } from "@cabane/sqlite";
import { Runtime, type FileReader, type RuntimeConfig } from "./runtime";

/** Read real test files through the runtime port without a CLI dependency. */
export const testFileReader: FileReader = async (path, cap) => {
	if (!existsSync(path)) return { status: "missing" };
	const bytes = readFileSync(path);
	return {
		status: "read",
		size: bytes.length,
		head: bytes.subarray(0, cap).toString(),
	};
};

export const TEST_DB_NAME = "kabane.db";

export const configureTestRuntime = (
	extra: Partial<Omit<RuntimeConfig, "provider">> = {},
): void => {
	Runtime.configure({
		provider: SqliteDb.provider({ dbName: TEST_DB_NAME }),
		timezone: () => "UTC",
		...extra,
	});
};

configureTestRuntime();

// CLI regression tests apply real sync batches before checking cursor invalidation.
export { Apply } from "./sync/apply";
