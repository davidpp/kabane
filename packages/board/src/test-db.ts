// Test wiring for board tests: the bun:sqlite provider with plain table names and the data modules
// the CLI registers, plus a fresh base directory per test. Importing this module configures
// the runtime once for the process.
import { mkdirSync, rmSync } from "node:fs";
import { checklistModule } from "@cabane/checklist";
import { Planner, Runtime } from "@cabane/core";
import { handoffModule } from "@cabane/handoff";
import { questionsModule } from "@cabane/questions";
import { SqliteDb } from "@cabane/sqlite";

Runtime.configure({
	provider: SqliteDb.provider(),
	modules: [questionsModule, handoffModule, checklistModule],
});

// Wipe and re-create `base`, then apply the schema. Call from beforeEach.
export const freshDb = async (base: string): Promise<void> => {
	rmSync(base, { recursive: true, force: true });
	mkdirSync(base, { recursive: true });
	const init = await Planner.init(base);
	if (!init.ok) throw init.error;
};

export const dropDb = (base: string): void => {
	rmSync(base, { recursive: true, force: true });
};
