/**
 * The official extensions. Each is a workspace package under `extensions/`,
 * bundled into the one `kabane` package, and off until `config.json`'s
 * `extensions` names it. One is imported only when a command or the board
 * needs it, so a built-in command such as `kabane list` loads none of them.
 */

import { existsSync } from "node:fs";
import { err, ok, type Result, tryCatch } from "@cabane/core";
import type { Extension } from "@cabane/extension";
import { configPath, loadConfig } from "./config";

/**
 * By the name `config.json` enables each with, as
 * `loop: async () => (await import("@cabane/loop")).loop`. The import is
 * dynamic so that it stays off the startup path; the bundler still inlines the
 * module, and `scripts/build.ts` fails when a directory under `extensions/` is
 * missing from this list.
 */
const OFFICIAL: Readonly<Record<string, () => Promise<Extension>>> = {
	loop: async () => (await import("@cabane/loop")).loop,
};

/** What an unknown command name turned out to be. */
type Lookup =
	| { found: "enabled"; command: Extension.Command }
	| { found: "disabled"; extension: string }
	| { found: "none" };

// Names already warned about, so a process that reads the config twice says it once.
const warnedUnknown = new Set<string>();

export namespace Extensions {
	/** Every official extension this build ships, by the name `extensions` takes. */
	export const names: readonly string[] = Object.keys(OFFICIAL);

	/**
	 * The official extensions this home turns on. No config file is none on;
	 * an unreadable one is the error every other command would report. A name
	 * this build does not ship is skipped, so a config a newer kabane wrote
	 * still opens, with a warning on stderr since it may be a typo.
	 */
	export const enabled = (home: string): Result<string[]> => {
		if (!existsSync(configPath(home))) return ok([]);
		const config = loadConfig(home);
		if (!config.ok) return config;
		const named = config.value.extensions ?? [];
		for (const name of named) {
			if (Object.hasOwn(OFFICIAL, name) || warnedUnknown.has(name)) continue;
			warnedUnknown.add(name);
			console.error(
				`kabane: ignoring "${name}" in "extensions" of ${configPath(home)}: this kabane ships ${Object.keys(OFFICIAL).join(", ")}`,
			);
		}
		return ok(Object.keys(OFFICIAL).filter((name) => named.includes(name)));
	};

	const load = async (name: string): Promise<Result<Extension>> => {
		const loader = OFFICIAL[name];
		if (!loader) return err(new Error(`No official extension "${name}"`));
		const loaded = await tryCatch(loader);
		if (!loaded.ok)
			return err(
				new Error(`Extension ${name} failed to load: ${loaded.error.message}`),
			);
		// The key is what config enables and what prefixes the board ids; the object has to agree.
		return loaded.value.name === name
			? loaded
			: err(
					new Error(
						`Extension listed as "${name}" calls itself "${loaded.value.name}"`,
					),
				);
	};

	export const loadAll = async (
		names: readonly string[],
	): Promise<Result<Extension[]>> => {
		const extensions: Extension[] = [];
		for (const name of names) {
			const loaded = await load(name);
			if (!loaded.ok) return loaded;
			extensions.push(loaded.value);
		}
		return ok(extensions);
	};

	const commandOf = (
		extension: Extension,
		name: string,
	): Extension.Command | undefined =>
		extension.commands?.find((command) => command.name === name);

	/**
	 * A command name no built-in claimed (built-ins always win). Enabled
	 * extensions are searched first; only a miss loads the disabled ones, to
	 * tell the human which extension to turn on. A disabled one that fails to
	 * load just does not own the name: it is off, so it has no say.
	 */
	export const find = async (
		name: string,
		enabledNames: readonly string[],
	): Promise<Result<Lookup>> => {
		const enabled = await loadAll(enabledNames);
		if (!enabled.ok) return enabled;
		for (const extension of enabled.value) {
			const command = commandOf(extension, name);
			if (command) return ok({ found: "enabled", command });
		}
		for (const other of Object.keys(OFFICIAL)) {
			if (enabledNames.includes(other)) continue;
			const extension = await load(other);
			if (extension.ok && commandOf(extension.value, name))
				return ok({ found: "disabled", extension: other });
		}
		return ok({ found: "none" });
	};

	/** Without a config there is no file to edit yet, and init is what writes one. */
	export const enableHint = (
		command: string,
		extension: string,
		home: string,
	): string => {
		const path = configPath(home);
		const off = `\`kabane ${command}\` comes with the ${extension} extension, which is off`;
		return existsSync(path)
			? `${off}; add "${extension}" to "extensions" in ${path}`
			: `${off}; run \`kabane init\`, then add "${extension}" to "extensions" in ${path}`;
	};
}
