/** Device extensions are discovered without importing them; only enabled code runs. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { err, ok, type Result, tryCatch, trySync } from "@cabane/core";
import { Self } from "@cabane/core/self";
import {
	failure,
	type Extension,
	type Host,
	type Settings,
} from "@cabane/extension";
import { z } from "zod";
import { version } from "../package.json";
import { ConfigSchema, configPath, loadConfig } from "./config";
import { ConfigLayers } from "./config-layers";

/**
 * By the name `config.json` enables each with, as
 * `loop: async () => (await import("@cabane/loop")).loop`. The import is
 * dynamic so that it stays off the startup path; the bundler emits it as its
 * own chunk, and `scripts/build.ts` fails when a directory under `extensions/`
 * is missing from this list.
 */
const OFFICIAL: Readonly<Record<string, () => Promise<Extension>>> = {
	loop: async () => (await import("@cabane/loop")).loop,
};

const Manifest = z.object({
	kabane: z.object({
		extension: z.string().min(1),
		api: z.number(),
		modules: z.string().optional(),
	}),
});
const Name = z
	.string()
	.min(1)
	.refine((name) => name !== "." && name !== ".." && !/[\\/\0]/.test(name));
const warned = new Set<string>();

export namespace Extensions {
	export const names: readonly string[] = Object.keys(OFFICIAL);
	export type Refusal = { name: string; reason: string };
	export const line = ({ name, reason }: Refusal): string =>
		`Extension ${name}: ${reason}`.replace(/[\r\n]+/g, " ");
	export const report = (refused: readonly Refusal[]): void => {
		for (const refusal of refused) {
			const message = line(refusal);
			if (warned.has(message)) continue;
			warned.add(message);
			console.error(message);
		}
	};
	const directory = (home: string, name: string): string =>
		join(home, "extensions", name);
	const installed = (home: string, name: string): boolean => {
		if (!Name.safeParse(name).success) return false;
		const stat = trySync(() => statSync(directory(home, name)));
		return stat.ok && stat.value.isDirectory();
	};
	/** Directory discovery never reads a manifest or imports disabled code. */
	export const available = (home: string): string[] => {
		const entries = trySync(() => readdirSync(join(home, "extensions")));
		return [
			...new Set([
				...names,
				...(entries.ok
					? entries.value.filter((name) => installed(home, name))
					: []),
			]),
		];
	};
	export const enabled = (home: string): Result<string[]> => {
		if (!existsSync(configPath(home))) return ok([]);
		const config = loadConfig(home);
		return config.ok ? ok([...new Set(config.value.extensions ?? [])]) : config;
	};
	export const unshipped = (named: readonly string[], home: string): string[] =>
		named.filter(
			(name) => !Object.hasOwn(OFFICIAL, name) && !installed(home, name),
		);
	export const missing = (name: string, home: string): Refusal => ({
		name,
		reason: `not installed; put it in ${directory(home, name)}/`,
	});

	const load = async (
		name: string,
		home: string,
	): Promise<Result<Extension>> => {
		if (!Name.safeParse(name).success)
			return err(new Error("invalid extension directory name"));
		let loaded: Result<Extension>;
		if (installed(home, name)) {
			if (Object.hasOwn(OFFICIAL, name))
				report([
					{
						name,
						reason: `directory ${directory(home, name)}/ overrides bundled ${name}`,
					},
				]);
			const manifest = trySync((): unknown =>
				JSON.parse(
					readFileSync(join(directory(home, name), "package.json"), "utf8"),
				),
			);
			if (!manifest.ok) return manifest;
			const parsed = Manifest.safeParse(manifest.value);
			if (!parsed.success)
				return err(
					new Error(
						`invalid package.json kabane manifest: ${parsed.error.message}`,
					),
				);
			const entry = parsed.data.kabane;
			if (entry.api !== 1)
				return err(
					new Error(`requires API ${entry.api}; this kabane supports API 1`),
				);
			if (entry.modules !== undefined)
				return err(new Error("this kabane does not load data modules yet"));
			loaded = await tryCatch(async () => {
				const imported = await import(
					pathToFileURL(Bun.resolveSync(entry.extension, directory(home, name)))
						.href
				);
				const host: Host = {
					api: 1,
					kabane: { version, executable: Self.executable() },
				};
				return imported.default(host) as Extension;
			});
		} else {
			const loader = Object.hasOwn(OFFICIAL, name) ? OFFICIAL[name] : undefined;
			if (!loader) return err(new Error(missing(name, home).reason));
			loaded = await tryCatch(loader);
		}
		if (!loaded.ok) return loaded;
		if (!loaded.value || loaded.value.name !== name)
			return err(new Error(`factory name must be "${name}"`));
		return loaded;
	};
	export const loadAll = async (
		names: readonly string[],
		home: string,
	): Promise<{ loaded: Extension[]; refused: Refusal[] }> => {
		const loaded: Extension[] = [];
		const refused: Refusal[] = [];
		for (const name of new Set(names)) {
			const result = await load(name, home);
			if (result.ok) loaded.push(result.value);
			else refused.push({ name, reason: result.error.message });
		}
		return { loaded, refused };
	};

	// The top-level keys a namespace may not take: device config, the per-scope block, and `db`,
	// a retired device key a config is refused for still holding.
	const RESERVED: ReadonlySet<string> = new Set([
		...Object.keys(ConfigSchema.shape),
		ConfigLayers.SCOPES,
		"db",
	]);

	/**
	 * The settings namespaces `extensions` declare. Refuses a namespace named like a device key,
	 * which would let a project file reach `sync`, and one whose schema refuses an empty
	 * layer, since every layer is partial.
	 */
	export const namespacesOf = (
		extensions: readonly Extension[],
	): Result<Settings.Namespace[]> => {
		const found: Settings.Namespace[] = [];
		for (const { name, settings, looks } of extensions) {
			if (settings === undefined) continue;
			if (RESERVED.has(name))
				return err(
					new Error(
						`Extension ${name}'s settings would take the device config key "${name}"`,
					),
				);
			if (!settings.safeParse({}).success)
				return err(
					new Error(
						`Extension ${name}'s settings need a default or optional for every key`,
					),
				);
			found.push({ name, schema: settings, ...(looks ? { looks } : {}) });
		}
		return ok(found);
	};

	/** Bundled settings remain configurable before enablement; directory code must be enabled. */
	export const namespaces = async (
		home: string,
	): Promise<Result<Settings.Namespace[]>> => {
		const selected = enabled(home);
		if (!selected.ok) return selected;
		const all = await loadAll(selected.value, home);
		// Bundled settings remain known even when a disabled directory shadows that name.
		for (const name of names) {
			if (selected.value.includes(name)) continue;
			const loader = Object.hasOwn(OFFICIAL, name) ? OFFICIAL[name] : undefined;
			if (!loader) continue;
			const bundled = await tryCatch(loader);
			if (bundled.ok) all.loaded.push(bundled.value);
			else all.refused.push({ name, reason: bundled.error.message });
		}
		report(all.refused);
		return namespacesOf(all.loaded);
	};
	export const find = async (
		name: string,
		enabledNames: readonly string[],
		home: string,
	): Promise<Extension.Command | undefined> => {
		const all = await loadAll(enabledNames, home);
		report(all.refused);
		for (const extension of all.loaded) {
			const command = extension.commands?.find(
				(command) => command.name === name,
			);
			if (!command) continue;
			return {
				...command,
				run: async (args, ctx) => {
					const called = await tryCatch(() => command.run(args, ctx));
					return called.ok
						? called.value
						: failure(
								line({ name: extension.name, reason: called.error.message }),
							);
				},
			};
		}
		return undefined;
	};
}
