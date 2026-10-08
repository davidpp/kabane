import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { err, ok, type Result } from "@cabane/core";
import { z } from "zod";
import { runUpdateProcess } from "./update-process";

export const StableVersionSchema = z
	.string()
	.max(64)
	.regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
	.refine((version) =>
		version.split(".").every((part) => Number.isSafeInteger(Number(part))),
	);
const ManifestSchema = z.object({
	name: z.literal("kabane"),
	version: StableVersionSchema,
	private: z.literal(false).optional(),
	bin: z.object({ kabane: z.literal("bin/kabane.js") }),
});
const RegistrationSchema = z.object({ dependencies: z.record(z.string()) });
const LockSchema = z.object({
	lockfileVersion: z.literal(2),
	configVersion: z.literal(1),
	workspaces: z.object({ "": RegistrationSchema }),
	packages: z.record(z.unknown()),
});
const ResolutionSchema = z.tuple([
	z.string(),
	z.string(),
	z
		.object({ bin: z.object({ kabane: z.literal("bin/kabane.js") }) })
		.passthrough(),
	z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/),
]);
const DirectorySettingsSchema = z.object({
	install: z
		.object({
			globalDir: z.string().optional(),
			globalBinDir: z.string().optional(),
			dryRun: z.boolean().optional(),
		})
		.optional(),
});

export type UpdateHost = { bin: string; bun: string; env: NodeJS.ProcessEnv };
export type RegistryInstall = {
	globalDir: string;
	bin: string;
	version: string;
	dryRun: boolean;
};
const UNSUPPORTED =
	"Unsupported installation; update only supports positively verified hoisted Bun global registry installs. For source links, review/update your checkout manually and follow the contributor build/link instructions; otherwise inspect your Bun global installation manually. No automatic repair or replacement was attempted.";

const directory = (value: string, home: string): Result<string, string> => {
	const expanded =
		value === "~"
			? home
			: value.startsWith("~/")
				? join(home, value.slice(2))
				: value;
	return isAbsolute(expanded) ? ok(resolve(expanded)) : err(UNSUPPORTED);
};

/** Read only directory settings; Bun itself owns registry/auth/proxy/age configuration. */
const globalDirectories = (
	env: NodeJS.ProcessEnv,
): Result<{ globalDir: string; binDir: string; dryRun: boolean }, string> => {
	try {
		const home = env.HOME ?? homedir();
		const files = [
			...new Set([
				join(home, ".bunfig.toml"),
				join(env.XDG_CONFIG_HOME ?? home, ".bunfig.toml"),
			]),
		];
		let globalDir: string | undefined;
		let binDir: string | undefined;
		let dryRun = false;
		for (const file of files) {
			if (!existsSync(file)) continue;
			if (lstatSync(file).size > 65_536) return err(UNSUPPORTED);
			const settings = DirectorySettingsSchema.safeParse(
				Bun.TOML.parse(readFileSync(file, "utf8")),
			);
			if (!settings.success) return err(UNSUPPORTED);
			dryRun ||= settings.data.install?.dryRun === true;
			const nextGlobal = settings.data.install?.globalDir;
			const nextBin = settings.data.install?.globalBinDir;
			// Ambiguous HOME/XDG directory precedence is not ownership evidence.
			if (
				(globalDir && nextGlobal && globalDir !== nextGlobal) ||
				(binDir && nextBin && binDir !== nextBin)
			)
				return err(UNSUPPORTED);
			globalDir ??= nextGlobal;
			binDir ??= nextBin;
		}
		const base = env.BUN_INSTALL ?? join(home, ".bun");
		const global = directory(
			env.BUN_INSTALL_GLOBAL_DIR ?? globalDir ?? join(base, "install/global"),
			home,
		);
		const bin = directory(
			env.BUN_INSTALL_BIN ?? binDir ?? join(base, "bin"),
			home,
		);
		if (!global.ok) return global;
		if (!bin.ok) return bin;
		return ok({ globalDir: global.value, binDir: bin.value, dryRun });
	} catch {
		return err(UNSUPPORTED);
	}
};

const registeredVersion = (specifier: string, version: string): boolean => {
	const match =
		/^(\^|~)?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(specifier);
	if (!match) return false;
	const base = match[2];
	if (!base) return false;
	if (!match[1]) return base === version;
	const a = base.split(".").map(Number),
		b = version.split(".").map(Number);
	if (
		a.some((part) => !Number.isSafeInteger(part)) ||
		b.some((part) => !Number.isSafeInteger(part))
	)
		return false;
	if (a[0] !== b[0] || ((match[1] === "~" || a[0] === 0) && a[1] !== b[1]))
		return false;
	const aMinor = a[1],
		bMinor = b[1],
		aPatch = a[2],
		bPatch = b[2];
	if (
		aMinor === undefined ||
		bMinor === undefined ||
		aPatch === undefined ||
		bPatch === undefined
	)
		return false;
	return bMinor > aMinor || (bMinor === aMinor && bPatch >= aPatch);
};

/** No metadata network request is made until bin, registration and registry lock agree. */
export const inspectRegistryInstall = async (
	host: UpdateHost,
): Promise<Result<RegistryInstall, string>> => {
	try {
		const directories = globalDirectories(host.env);
		if (!directories.ok) return directories;
		const globalDir = realpathSync(directories.value.globalDir);
		const slot = join(globalDir, "node_modules/kabane");
		// In particular, do not mistake an isolated internal bin for an owned global bin.
		if (!lstatSync(slot).isDirectory() || lstatSync(slot).isSymbolicLink())
			return err(UNSUPPORTED);
		const bin = join(directories.value.binDir, "kabane");
		if (!lstatSync(bin).isSymbolicLink()) return err(UNSUPPORTED);
		const expected = realpathSync(join(slot, "bin/kabane.js"));
		if (realpathSync(bin) !== expected || realpathSync(host.bin) !== expected)
			return err(UNSUPPORTED);
		for (const file of [
			join(slot, "package.json"),
			join(globalDir, "package.json"),
			join(globalDir, "bun.lock"),
			join(globalDir, "bunfig.toml"),
		]) {
			if (!existsSync(file)) continue;
			const stat = lstatSync(file);
			if (!stat.isFile() || stat.size > 1_048_576) return err(UNSUPPORTED);
		}
		const manifest = ManifestSchema.safeParse(
			JSON.parse(readFileSync(join(slot, "package.json"), "utf8")),
		);
		const registration = RegistrationSchema.safeParse(
			JSON.parse(readFileSync(join(globalDir, "package.json"), "utf8")),
		);
		const lock = LockSchema.safeParse(
			Bun.JSON5.parse(readFileSync(join(globalDir, "bun.lock"), "utf8")),
		);
		if (!manifest.success || !registration.success || !lock.success)
			return err(UNSUPPORTED);
		const version = manifest.data.version;
		const specifier = registration.data.dependencies.kabane;
		if (
			!specifier ||
			!registeredVersion(specifier, version) ||
			lock.data.workspaces[""].dependencies.kabane !== specifier
		)
			return err(UNSUPPORTED);
		const entry = ResolutionSchema.safeParse(lock.data.packages.kabane);
		if (
			!entry.success ||
			entry.data[0] !== `kabane@${version}` ||
			(entry.data[1] !== "" && !/^https?:\/\//.test(entry.data[1]))
		)
			return err(UNSUPPORTED);
		// Reject directory redirection by a global-root local config rather than guessing.
		let dryRun = directories.value.dryRun;
		const local = join(globalDir, "bunfig.toml");
		if (existsSync(local)) {
			const settings = DirectorySettingsSchema.safeParse(
				Bun.TOML.parse(readFileSync(local, "utf8")),
			);
			if (
				!settings.success ||
				settings.data.install?.globalDir ||
				settings.data.install?.globalBinDir
			)
				return err(UNSUPPORTED);
			dryRun ||= settings.data.install?.dryRun === true;
		}
		const reported = await runUpdateProcess(
			[host.bun, "pm", "bin", "-g"],
			globalDir,
			host.env,
		);
		if (
			!reported.ok ||
			reported.value.code !== 0 ||
			realpathSync(reported.value.stdout.trim()) !==
				realpathSync(directories.value.binDir)
		)
			return err(UNSUPPORTED);
		return ok({ globalDir, bin, version, dryRun });
	} catch {
		return err(UNSUPPORTED);
	}
};
