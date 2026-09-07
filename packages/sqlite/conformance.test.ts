/**
 * The Db port conformance suite over bun:sqlite. The Durable Object adapter
 * runs the identical cases under vitest, which is what keeps the two engines
 * from drifting on the details storage relies on.
 */

import { afterAll, describe, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { conformanceCases } from "@cabane/core";
import { SqliteDb } from "./index";

const base = join(tmpdir(), `cabane-conformance-${crypto.randomUUID()}`);
mkdirSync(base, { recursive: true });

// The provider ignores nothing here: every case shares one file so the cases
// that create scratch tables see the same engine state a real device would.
const provider = SqliteDb.provider({ dbName: "conformance.db" });
const bound = {
	withDb: <T>(_: string, fn: Parameters<typeof provider.withDb<T>>[1]) =>
		provider.withDb(base, fn),
};

afterAll(() => {
	rmSync(base, { recursive: true, force: true });
});

describe("Db port conformance over bun:sqlite", () => {
	for (const c of conformanceCases()) {
		it(c.name, () => c.run(bound));
	}
});
