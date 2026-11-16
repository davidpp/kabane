/** Device extensions are discovered without importing them; only enabled code runs. */
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { err, ok, type Result, tryCatch, trySync } from "@cabane/core";
import {
	type Doctor,
	failure,
	type Extension,
	type Host,
	type Settings,
} from "@cabane/extension";
import { z } from "zod";
import { ConfigSchema, configPath, loadConfig } from "./config";
import { ConfigLayers } from "./config-layers";
import { createHost, hostHarnessMode } from "./host";

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
const callable = <T extends (...args: never[]) => unknown>() =>
	z.custom<T>((value) => typeof value === "function", "must be a function");
const Factory = callable<(host: Host) => unknown>();
const zodType = z.custom<z.ZodType>(
	(value) => value instanceof z.ZodType,
	(value) => ({
		message:
			typeof value === "object" &&
			value !== null &&
			"_def" in value &&
			"safeParse" in value &&
			typeof value.safeParse === "function"
				? "must be built with host.z"
				: "must be a Zod schema",
	}),
);
const ExtensionShape = z.object({
	name: z.string(),
	commands: z
		.array(
			z.object({
				name: z.string(),
				usage: z.string(),
				summary: z.string(),
				standalone: z.boolean().optional(),
				run: callable<Extension.Command["run"]>(),
			}),
		)
		.optional(),
	settings: zodType.optional(),
	looks: z
		.record(
			z.object({
				label: z.string(),
				group: z.string(),
				options: z
					.union([
						z.array(z.union([z.string(), z.number()])),
						callable<(at: Settings.At) => readonly (string | number)[]>(),
					])
					.optional(),
				none: z.string().optional(),
			}),
		)
		.optional(),
	board: callable<NonNullable<Extension["board"]>>().optional(),
	mcp: callable<NonNullable<Extension["mcp"]>>().optional(),
	doctor: callable<NonNullable<Extension["doctor"]>>().optional(),
});
const Findings = z.array(
	z.object({
		id: z.string().min(1),
		path: z.string().optional(),
		severity: z.enum(["auto", "mention", "suggest", "route"]),
		summary: z.string(),
		fix: callable<NonNullable<Doctor.Finding["fix"]>>().optional(),
		route: z.string().optional(),
	}),
);
const DoctorReport = z.union([
	z.object({ ok: z.literal(true), value: Findings }),
	z.object({ ok: z.literal(false), error: z.instanceof(Error) }),
]);
const Name = z
	.string()
	.min(1)
	.refine((name) => name !== "." && name !== ".." && !/[\\/\0]/.test(name));
const warned = new Set<string>();

export namespace Extensions {
	export const zodSchema = zodType;
	/** Keep the author's first line, excluding Bun's call-expression annotation. */
	export const cause = (error: Error): string => {
		const first = (error.message.split(/[\r\n]/, 1)[0] ?? "").replace(
			/\s*\(In '[\s\S]*$/,
			"",
		);
		return first.length > 200 ? `${first.slice(0, 199)}…` : first;
	};
	export const invalid = (error: z.ZodError): string => {
		const issue = error.issues[0];
		if (!issue) return "value does not match the extension contract";
		const path =
			issue.path.reduce<string>(
				(text, part) =>
					typeof part === "number"
						? `${text}[${part}]`
						: `${text}${text ? "." : ""}${part}`,
				"",
			) || "value";
		if (issue.code === "invalid_type") {
			const article = /^[aeiou]/.test(issue.expected) ? "an" : "a";
			return `${path} must be ${article} ${issue.expected}`;
		}
		if (issue.code === "invalid_union")
			return [...new Set(issue.unionErrors.map(invalid))].join(" or ");
		if (issue.code === "invalid_enum_value")
			return `${path} must be ${issue.options.map(String).join(" or ")}`;
		return `${path} ${issue.message}`;
	};
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
	export const installed = (home: string, name: string): boolean => {
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
	export const disabledAdvice =
		"or remove it from extensions with `kabane config set extensions <names> --layer global`.";
	const refusal = (reason: string): string => `${reason}; ${disabledAdvice}`;
	export const missing = (name: string, home: string): Refusal => ({
		name,
		reason: refusal(`not installed; put it in ${directory(home, name)}/`),
	});

	const load = async (
		name: string,
		home: string,
	): Promise<Result<Extension>> => {
		if (!Name.safeParse(name).success)
			return err(
				new Error(
					"invalid extension directory name; use a single directory name",
				),
			);
		let loaded: Result<unknown>;
		if (installed(home, name)) {
			const dir = directory(home, name);
			if (Object.hasOwn(OFFICIAL, name))
				report([
					{ name, reason: `directory ${dir}/ overrides bundled ${name}` },
				]);
			const file = join(dir, "package.json");
			const contents = trySync(() => readFileSync(file, "utf8"));
			if (!contents.ok)
				return err(
					new Error(
						existsSync(file)
							? `${file} cannot be read; make it readable`
							: `${file} is missing; add a package.json manifest`,
					),
				);
			const manifest = trySync((): unknown => JSON.parse(contents.value));
			if (!manifest.ok)
				return err(
					new Error(`${file} contains invalid JSON; correct its JSON`),
				);
			const parsed = Manifest.safeParse(manifest.value);
			if (!parsed.success)
				return err(
					new Error(
						`${file} needs "kabane": { "extension": "<entry>", "api": 1 }`,
					),
				);
			const entry = parsed.data.kabane;
			if (entry.api !== 1)
				return err(
					new Error(
						`requires API ${entry.api}; this kabane supports API 1; install an API 1 version of the extension`,
					),
				);
			if (entry.modules !== undefined)
				return err(
					new Error(
						"this kabane does not load data modules yet; install a version without data modules",
					),
				);
			const resolved = trySync(() => ({
				root: realpathSync(dir),
				entry: realpathSync(Bun.resolveSync(entry.extension, dir)),
			}));
			if (!resolved.ok)
				return err(
					new Error(
						`${file} names an entry that cannot be resolved; correct kabane.extension`,
					),
				);
			if (!resolved.value.entry.startsWith(`${resolved.value.root}${sep}`))
				return err(
					new Error(
						`${file} names an entry outside its extension directory; move the entry inside that directory`,
					),
				);
			const imported = await tryCatch(
				() => import(pathToFileURL(resolved.value.entry).href),
			);
			if (!imported.ok)
				return err(
					new Error(
						`the entry could not be imported: ${cause(imported.error)}; repair the entry and its dependencies`,
					),
				);
			const factory = Factory.safeParse(imported.value.default);
			if (!factory.success)
				return err(
					new Error(
						"the entry's default export must be a factory (host) => Extension",
					),
				);
			const { host, ready } = createHost(home);
			loaded = await tryCatch(async () => factory.data(host));
			if (loaded.ok) ready();
		} else {
			const loader = Object.hasOwn(OFFICIAL, name) ? OFFICIAL[name] : undefined;
			if (!loader)
				return err(
					new Error(`not installed; put it in ${directory(home, name)}/`),
				);
			loaded = await tryCatch(loader);
		}
		if (!loaded.ok)
			return err(
				new Error(
					`the factory failed: ${cause(loaded.error)}; repair the extension's factory`,
				),
			);
		const parsed = ExtensionShape.safeParse(loaded.value);
		if (!parsed.success)
			return err(
				new Error(
					`the factory returned an invalid Extension: ${invalid(parsed.error)}`,
				),
			);
		if (parsed.data.name !== name)
			return err(
				new Error(
					`factory name must be "${name}"; got ${JSON.stringify(parsed.data.name)}; correct the factory's name`,
				),
			);
		return ok(loaded.value as Extension);
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
			else refused.push({ name, reason: refusal(result.error.message) });
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

	/**
	 * Bundled settings remain configurable before enablement; directory code must be enabled.
	 * `selected` stands in for the config's list when that config may not parse (doctor's case).
	 */
	export const namespaces = async (
		home: string,
		selected: Result<string[]> = enabled(home),
	): Promise<Result<Settings.Namespace[]>> => {
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
	export const commands = (
		loaded: readonly Extension[],
		builtinNames: readonly string[],
	): { commands: Extension.Command[]; refused: Refusal[] } => {
		const contributions = loaded.flatMap((extension) =>
			(extension.commands ?? []).map((command) => ({
				owner: extension.name,
				command,
			})),
		);
		const commands: Extension.Command[] = [];
		const refused: Refusal[] = [];
		for (const { owner, command } of contributions) {
			const conflict = builtinNames.includes(command.name)
				? "a built-in command"
				: contributions.filter((entry) => entry.command.name === command.name)
							.length > 1
					? "another enabled extension command"
					: undefined;
			if (conflict) {
				refused.push({
					name: owner,
					reason: refusal(
						`command "${command.name}" conflicts with ${conflict}; rename the extension command`,
					),
				});
				continue;
			}
			commands.push({
				...command,
				run: async (args, ctx) => {
					const called = await tryCatch(() =>
						command.run(args, {
							...ctx,
							harnessMode: hostHarnessMode(ctx.home),
						}),
					);
					return called.ok
						? called.value
						: failure(line({ name: owner, reason: called.error.message }));
				},
			});
		}
		return { commands, refused };
	};

	/**
	 * Each extension's doctor as a check source. What one returns is checked against the finding
	 * shape, so a malformed report, like a throw, becomes that extension's failed check.
	 */
	export const doctors = (loaded: readonly Extension[]): Doctor.Source[] =>
		loaded.flatMap(({ name, doctor }) =>
			doctor === undefined
				? []
				: [
						{
							name,
							doctor: async (ctx: Extension.Ctx) => {
								const parsed = DoctorReport.safeParse(await doctor(ctx));
								return parsed.success
									? parsed.data
									: err(
											new Error(
												`returned an invalid report: ${invalid(parsed.error)}; repair the extension's doctor`,
											),
										);
							},
						},
					],
		);
}
