/**
 * Test wiring — NOT part of the public API.
 *
 * Importing this module configures the runtime with the bun:sqlite provider,
 * which is what every core test runs against. The owner's timezone is pinned
 * to UTC so a test that takes "today" does not
 * depend on the machine's zone or the hour it runs; a test about zones passes
 * one explicitly.
 */

import { SqliteDb } from "@cabane/sqlite";
import { Runtime, type RuntimeConfig } from "./runtime";

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
