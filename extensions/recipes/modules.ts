// The modules entry: the run table and the job table, registered by every process that opens the
// database while the extension is enabled. It imports only the storage modules.
import type { KabaneModule } from "@cabane/extension";
import { Jobs } from "./src/jobs";
import { Runs } from "./src/runs";

export default (): KabaneModule[] => [Runs.module(), Jobs.module()];
