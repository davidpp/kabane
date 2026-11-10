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
			"Read this device's config and settings, as they resolve for this server's project: default, then global (config.json, every project), shared (the repo's checked-in .kabane/<namespace>.json), then local (the human's settings for this project on this device, outside the repo; a legacy scopes.<id> block in config.json reads as local too). Omit key to list all keys, values, the layer each comes from (layer, from), defaults, descriptions, readOnly and protected flags. With a key, its effective value; add layers:true for {key, value, leaves}, every leaf under the key with its value and layer. Secrets (sync.token, sync.headers) read as <set> when set. Local only; settings are not synced to the hub.",
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
			"Set a config key in one layer, or remove it from that layer with unset:true. layer: local (this project only, for this human on this device, kept outside the repo; the default inside a project), global (config.json, every project; the default outside a project), or shared (the repo's checked-in .kabane/<namespace>.json). Device keys (sync, db, identities, copilot, harness, timezone, extensions) are global only, and go there by default. Uses kabane config parsing: strings as text, booleans/numbers as JSON text, arrays comma-separated, headers and other records as a JSON object; one record entry is its own key (loop.gates.test). Identity keys are read-only. Saved changes need a restart of running board/MCP processes to take effect.",
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
				.string()
				.refine((name) => ConfigSettings.targetOf(name) !== undefined, {
					message: `one of ${ConfigSettings.TARGETS.join(", ")}`,
				})
				.optional()
				.describe(
					"The layer to write: local, global or shared. Omitted: local inside a project, global outside one or for a device key.",
				),
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
				typeof layer === "string" ? ConfigSettings.targetOf(layer) : undefined,
			);
			if (!result.ok) return result;
			const { ignored } = result.value;
			return ok({
				...result.value,
				restartRequired: true,
				note: `Saved to ${result.value.layer === "shared" ? "the project's checked-in file" : "this device"} (${result.value.from}). Restart running board and MCP processes to apply the change; a board already open will not load newly enabled extensions.${ignored ? ` This build does not ship ${ignored.join(", ")}, so ${ignored.length > 1 ? "they load" : "it loads"} nothing; it ships ${Extensions.names.join(", ")}.` : ""}`,
			});
		},
	},
];
