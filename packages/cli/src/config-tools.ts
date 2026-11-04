import { err, ok, type ToolDef } from "@cabane/core";
import { z } from "zod";
import { ConfigSettings } from "./config-settings";
import { Extensions } from "./extensions";

/** Bound to KABANE_HOME, which can differ from the tracker's database path. */
export const configTools = (home: string): ToolDef[] => [
	{
		name: "kabane_configGet",
		description:
			"Read this device's config. Omit key to list all keys, values, defaults, descriptions and read-only flags. Secrets (sync.token, sync.headers) read as <set> when set. Local only; settings are not synced to the hub.",
		input: { key: z.string().min(1).optional() },
		kind: "read",
		handler: async ({ key }) => {
			if (typeof key !== "string") return ConfigSettings.list(home);
			const result = ConfigSettings.get(home, key);
			return result.ok ? ok(result.value ?? null) : result;
		},
	},
	{
		name: "kabane_configSet",
		description:
			"Set a device config key, or remove its override with unset:true. Uses kabane config parsing: strings as text, booleans/numbers as JSON text, arrays comma-separated, headers as a JSON object. Identity keys are read-only. Saved changes need a restart of running board/MCP processes to take effect.",
		input: {
			key: z.string().min(1),
			value: z
				.string()
				.optional()
				.describe("Value in kabane config set syntax."),
			unset: z
				.boolean()
				.optional()
				.describe("Remove the override; omit value."),
		},
		kind: "write",
		handler: async ({ key, value, unset }) => {
			if (
				typeof key !== "string" ||
				(unset === true ? value !== undefined : typeof value !== "string")
			)
				return err(
					new Error("Supply a key and either value or unset:true, not both."),
				);
			const result = ConfigSettings.set(home, key, value);
			if (!result.ok) return result;
			const { ignored } = result.value;
			return ok({
				...result.value,
				restartRequired: true,
				note: `Saved to this device. Restart running board and MCP processes to apply the change; a board already open will not load newly enabled extensions.${ignored ? ` This build does not ship ${ignored.join(", ")}, so ${ignored.length > 1 ? "they load" : "it loads"} nothing; it ships ${Extensions.names.join(", ")}.` : ""}`,
			});
		},
	},
];
