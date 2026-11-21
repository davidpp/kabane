// The modules entry: the run table and the job table, registered by every process that opens the
// database while the extension is enabled. It imports only the storage modules. The rename from
// `recipes` comes first, so the two modules after it find their tables and versions moved.
import type { KabaneModule } from "@kabane/extension";
import { FromRecipes } from "./src/from-recipes";
import { Jobs } from "./src/jobs";
import { Runs } from "./src/runs";

export default (): KabaneModule[] => [
	FromRecipes.module(),
	Runs.module(),
	Jobs.module(),
];
