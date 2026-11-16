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
	return {
		name: "recipes",
		settings,
		commands: [
			runCommand(host, settings, HcRuntime.runtime),
			runsCommand(host, HcRuntime.runtime),
		],
		doctor: async () => {
			const missing = HcRuntime.runtime.missing();
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
