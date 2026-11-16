// The modules entry: the run table, registered by every process that opens the database while the
// extension is enabled. It imports only the storage module.
import type { KabaneModule } from "@cabane/extension";
import { Runs } from "./src/runs";

export default (): KabaneModule[] => [Runs.module()];
