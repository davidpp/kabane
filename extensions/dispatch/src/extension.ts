// The dispatch extension as a directory extension: the templates and copilot files beside it, one
// `kabane dispatch` command for what a procedure file cannot compute, and the skill checks.
import type { Extension, Host } from "@cabane/extension";
import { DispatchDoctor } from "./doctor";
import { Kabane } from "./result";
import { Templates } from "./templates";

const USAGE = `kabane dispatch stamp   (prints the stamp a filled dispatch skill records: dispatch@<hash12> of the template this extension ships)

To set up dispatch in a project, follow the setup-dispatch skill: kabane_skillGet with name
setup-dispatch, from a session connected to kabane mcp (/setup-dispatch on the board).`;

export const dispatch = (host: Host): Extension => {
	Kabane.bind(host);
	return {
		name: "dispatch",
		commands: [
			{
				name: "dispatch",
				summary: "Print the dispatch template's stamp",
				usage: USAGE,
				// Reads only the extension's own files, never the record.
				standalone: true,
				run: async (args) => {
					const [verb, ...rest] = args.positionals;
					if (verb !== "stamp" || rest.length > 0)
						return host.outcome.usage(
							verb === undefined
								? "dispatch needs a subcommand"
								: `Unknown dispatch arguments: ${args.positionals.join(" ")}`,
							USAGE,
						);
					const stamp = Templates.stamp();
					return stamp.ok
						? host.outcome.success({ stamp: stamp.value }, stamp.value)
						: host.outcome.failure(stamp.error);
				},
			},
		],
		doctor: DispatchDoctor.create(host),
	};
};
