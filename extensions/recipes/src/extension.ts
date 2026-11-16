// The recipes extension: `kabane run` and `kabane runs`, its one setting and its doctor check.
import type { Extension, Host } from "@cabane/extension";
import { Kabane, ok } from "./result";
import { runCommand } from "./run-command";
import { runsCommand } from "./runs-command";
import { HcRuntime } from "./runtime-hc";

export const recipes = (host: Host): Extension => {
	Kabane.bind(host);
	const settings = host.z
		.object({
			// The argv the prompt is appended to as its last argument.
			harness: host.z.array(host.z.string().min(1)).min(1).default(["claude"]),
		})
		.strict();
	const runtime = HcRuntime.runtime(host.z);
	return {
		name: "recipes",
		settings,
		commands: [runCommand(host, settings, runtime), runsCommand(host, runtime)],
		doctor: async () => {
			const missing = runtime.missing();
			return ok(
				missing === undefined
					? []
					: [
							{
								id: "hc-missing",
								severity: "mention" as const,
								summary: missing,
							},
						],
			);
		},
	};
};
