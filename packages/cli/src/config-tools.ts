import { err, ok, type ToolDef } from "@cabane/core";
import { z } from "zod";
import { ConfigSettings } from "./config-settings";
import { Extensions } from "./extensions";

/**
 * Bound to KABANE_HOME, which can differ from the tracker's database path, and to where the
 * server was started: the project and scope whose settings it reads and writes.
 */
export const configTools = (
	home: string,
	where: ConfigSettings.Where,
): ToolDef[] => [
	{
		name: "kabane_configGet",
		description:
			"Read this device's config and settings, as they resolve for this server's project: default, then user (config.json), project (the repo's .kabane/<namespace>.json), then scope (the user's settings for this project's scope). Omit key to list all keys, values, the layer each comes from (layer, from), defaults, descriptions, readOnly and protected flags. With a key, its effective value; add layers:true for {key, value, leaves}, every leaf under the key with its value and layer. Secrets (sync.token, sync.headers) read as <set> when set. Local only; settings are not synced to the hub.",
		input: {
			key: z.string().min(1).optional(),
			layers: z
				.boolean()
				.optional()
				.describe(
					"With a key, also name the layer every leaf under it came from.",
				),
		},
		kind: "read",
		handler: async ({ key, layers }) => {
			if (typeof key !== "string") return ConfigSettings.list(home, where);
			const result = await ConfigSettings.get(home, where, key);
			if (!result.ok || layers === true) return result;
			return ok(result.value.value);
		},
	},
	{
		name: "kabane_configSet",
		description:
			"Set a config key in one layer, or remove it from that layer with unset:true. layer: user (config.json, the default), scope (the user's settings for this project's scope, kept in config.json), or project (the repo's checked-in .kabane/<namespace>.json). Device keys (sync, db, identities, copilot, harness, timezone, extensions) are user only. Uses kabane config parsing: strings as text, booleans/numbers as JSON text, arrays comma-separated, headers and other records as a JSON object; one record entry is its own key (loop.gates.test). Identity keys are read-only. Saved changes need a restart of running board/MCP processes to take effect.",
		input: {
			key: z.string().min(1),
			value: z
				.string()
				.optional()
				.describe("Value in kabane config set syntax."),
			unset: z
				.boolean()
				.optional()
				.describe("Remove the key from the layer; omit value."),
			layer: z
				.enum(ConfigSettings.TARGETS)
				.optional()
				.describe("The layer to write: user (default), scope or project."),
		},
		kind: "write",
		handler: async ({ key, value, unset, layer }) => {
			if (
				typeof key !== "string" ||
				(unset === true ? value !== undefined : typeof value !== "string")
			)
				return err(
					new Error("Supply a key and either value or unset:true, not both."),
				);
			const result = await ConfigSettings.set(
				home,
				where,
				key,
				value,
				typeof layer === "string" && ConfigSettings.isTarget(layer)
					? layer
					: "user",
			);
			if (!result.ok) return result;
			const { ignored } = result.value;
			return ok({
				...result.value,
				restartRequired: true,
				note: `Saved to ${result.value.layer === "project" ? "the project's file" : "this device"}. Restart running board and MCP processes to apply the change; a board already open will not load newly enabled extensions.${ignored ? ` This build does not ship ${ignored.join(", ")}, so ${ignored.length > 1 ? "they load" : "it loads"} nothing; it ships ${Extensions.names.join(", ")}.` : ""}`,
			});
		},
	},
];
