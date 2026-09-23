/**
 * Test wiring — NOT part of the public API.
 *
 * Importing this module configures the runtime with the bun:sqlite provider
 * and plain table names, which is what every core test runs against. Tests
 * that need a prefix call `Runtime.configure` themselves afterwards. The
 * owner's timezone is pinned to UTC so a test that takes "today" does not
 * depend on the machine's zone or the hour it runs; a test about zones passes
 * one explicitly.
 */

import { SqliteDb } from "@cabane/sqlite";
import { Runtime, type RuntimeConfig } from "./runtime";

export const TEST_DB_NAME = "kabane.db";

export const configureTestRuntime = (
	tablePrefix = "",
	extra: Partial<Omit<RuntimeConfig, "provider" | "tablePrefix">> = {},
): void => {
	Runtime.configure({
		provider: SqliteDb.provider({ dbName: TEST_DB_NAME }),
		tablePrefix,
		timezone: () => "UTC",
		...extra,
	});
};

configureTestRuntime();
