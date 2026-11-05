import { createHash, randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { version as sourceVersion } from "../package.json";
import { runUpdateProcess } from "./update-process";

export const UPDATE_SOURCE = sourceVersion;
/** The next release on the source's own channel: the next patch, or the next beta.N. */
export const UPDATE_TARGET = sourceVersion.replace(
	/\d+$/,
	(last) => `${Number(last) + 1}`,
);
const ROOT = resolve(import.meta.dir, "../../..");
type FixtureOptions = {
	isolated?: boolean;
	age?: number;
	young?: boolean;
	failScript?: boolean;
	removeBin?: boolean;
	configured?: boolean;
	/** The version `archive` carries, installed first; the target is what the registry offers. */
	source?: string;
	target?: string;
};
/** A target install script that fails, or that removes the global bin it installed. */
const targetScripts = (options: FixtureOptions) =>
	options.failScript
		? { scripts: { postinstall: "bun -e 'process.exit(7)'" } }
		: options.removeBin
			? {
					scripts: {
						postinstall: `bun -e 'require("node:fs").rmSync(process.env.BUN_INSTALL + "/bin/kabane", {force:true})'`,
					},
				}
			: {};
/** Files a correct update never opens: the tracker's database and config, and a harness config. */
const writeSentinels = (tracker: string, home: string): void => {
	writeFileSync(join(tracker, "config.json"), "NOT_VALID_JSON_DO_NOT_READ");
	writeFileSync(join(tracker, "kabane.db"), "NOT_A_DATABASE_DO_NOT_OPEN");
	writeFileSync(join(tracker, "kabane.db-wal"), "WAL_SENTINEL");
	writeFileSync(join(tracker, "kabane.db-shm"), "SHM_SENTINEL");
	writeFileSync(join(home, ".claude.json"), "HARNESS_CONFIG_SENTINEL");
};

/** The target release, packed: a bin that prints its version, and the scripts `options` asks for. */
const packTarget = (work: string, target: string, options: FixtureOptions) => {
	const targetDir = join(work, "target/package");
	mkdirSync(join(targetDir, "bin"), { recursive: true });
	const manifest = {
		name: "kabane",
		version: target,
		type: "module",
		bin: { kabane: "bin/kabane.js" },
		engines: { bun: ">=1.4.0" },
		...targetScripts(options),
	};
	writeFileSync(join(targetDir, "package.json"), JSON.stringify(manifest));
	writeFileSync(
		join(targetDir, "bin/kabane.js"),
		`#!/usr/bin/env bun\nconsole.log(${JSON.stringify(target)});\n`,
		{ mode: 0o755 },
	);
	const tarball = join(work, "target.tgz");
	const packed = Bun.spawnSync(["tar", "-czf", tarball, "package"], {
		cwd: dirname(targetDir),
	});
	return packed.exitCode === 0 ? { manifest, tarball } : null;
};

/**
 * A local registry serving the source and target tarballs and whatever metadata a test sets.
 * Any local process may connect to a loopback listener (a port-watching dashboard probes each
 * new one with `GET /`), so the registry lives under a per-fixture path prefix and `requests`
 * records only paths below it: requests from clients this fixture configured. The bunfig
 * registry ends in `/`, or Bun resolves package paths past the prefix.
 */
const startRegistry = (
	{ source, target }: { source: string; target: string },
	tarballs: Record<string, Buffer<ArrayBuffer>>,
	targetManifest: Record<string, unknown>,
	young: boolean,
) => {
	const requests: string[] = [];
	const prefix = `/${randomUUID()}`;
	let metadata: unknown;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const full = new URL(request.url).pathname;
			if (!full.startsWith(`${prefix}/`))
				return new Response("not this fixture's registry", { status: 404 });
			const path = full.slice(prefix.length);
			requests.push(path);
			if (path === "/kabane") return Response.json(metadata);
			if (path === `/kabane/-/kabane-${source}.tgz`)
				return new Response(tarballs[source]);
			if (path === `/kabane/-/kabane-${target}.tgz`)
				return new Response(tarballs[target]);
			return new Response("unconfigured fixture request", { status: 404 });
		},
	});
	const url = `http://127.0.0.1:${server.port}${prefix}`;
	/** A tag naming the source serves its archive, any other version the target's. */
	const entry = (version: string, engine = ">=1.4.0") => {
		const file = version === source ? source : target;
		return {
			...(version === source
				? { name: "kabane", version, bin: { kabane: "bin/kabane.js" } }
				: { ...targetManifest, version }),
			engines: { bun: engine },
			// External imports use read-only repo modules in this controlled manager fixture;
			// the release smoke separately verifies an unmodified registry dependency install.
			dist: {
				tarball: `${url}/kabane/-/kabane-${file}.tgz`,
				integrity: `sha512-${createHash("sha512")
					.update(tarballs[file] ?? Buffer.alloc(0))
					.digest("base64")}`,
			},
		};
	};
	metadata = {
		name: "kabane",
		"dist-tags": { latest: target },
		time: {
			[source]: "2020-01-01T00:00:00Z",
			[target]: young ? new Date().toISOString() : "2020-01-01T00:00:00Z",
		},
		versions: { [source]: entry(source), [target]: entry(target) },
	};
	return {
		url,
		requests,
		stop: (): Promise<void> => server.stop(true),
		setMetadata: (value: unknown): void => {
			metadata = value;
		},
		setDistTags: (tags: Record<string, string>, engine = ">=1.4.0"): void => {
			metadata = {
				name: "kabane",
				"dist-tags": tags,
				versions: Object.fromEntries(
					[...new Set(Object.values(tags))].map((version) => [
						version,
						entry(version, engine),
					]),
				),
			};
		},
	};
};

/** The process environment with every registry, token and directory override Bun reads replaced by the fixture's. */
const fixtureEnv = (
	work: string,
	{
		home,
		install,
		cache,
		tracker,
	}: Record<"home" | "install" | "cache" | "tracker", string>,
	configured: { globalDir: string; binDir: string } | null,
): NodeJS.ProcessEnv => {
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: home,
		BUN_INSTALL: install,
		BUN_INSTALL_CACHE_DIR: cache,
		BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(work, "transpile-cache"),
		KABANE_HOME: tracker,
		KABANE_HARNESSES: "",
		PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
	};
	for (const key of [
		"BUN_CONFIG_REGISTRY",
		"NPM_CONFIG_REGISTRY",
		"BUN_CONFIG_TOKEN",
		"NPM_CONFIG_TOKEN",
		"NPM_CONFIG_USERCONFIG",
		"BUN_INSTALL_GLOBAL_DIR",
		"BUN_INSTALL_BIN",
	])
		delete env[key];
	if (configured) {
		env.BUN_INSTALL_GLOBAL_DIR = configured.globalDir;
		env.BUN_INSTALL_BIN = configured.binDir;
	}
	return env;
};

export const createUpdateFixture = async (
	archive: string,
	{
		source = UPDATE_SOURCE,
		target = UPDATE_TARGET,
		...options
	}: FixtureOptions = {},
) => {
	const work = mkdtempSync(join(tmpdir(), "kabane-update-test-"));
	const home = join(work, "home"),
		install = join(work, "bun"),
		cache = join(work, "cache"),
		tracker = join(work, "tracker");
	const globalDir = options.configured
		? join(work, "custom-global")
		: join(install, "install/global");
	const binDir = options.configured
		? join(work, "custom-bin")
		: join(install, "bin");
	for (const path of [home, globalDir, tracker])
		mkdirSync(path, { recursive: true });
	writeSentinels(tracker, home);
	const packed = packTarget(work, target, options);
	if (!packed) return { ok: false as const, error: "fixture tar failed" };
	const registry = startRegistry(
		{ source, target },
		{ [source]: readFileSync(archive), [target]: readFileSync(packed.tarball) },
		packed.manifest,
		options.young === true,
	);
	writeFileSync(
		join(home, ".bunfig.toml"),
		`[install]\nregistry = "${registry.url}/"\nminimumReleaseAge = ${options.age ?? 0}\nlinker = "${options.isolated ? "isolated" : "hoisted"}"\n${options.configured ? `globalDir = "${globalDir}"\nglobalBinDir = "${binDir}"\n` : ""}`,
	);
	const env = fixtureEnv(
		work,
		{ home, install, cache, tracker },
		options.configured ? { globalDir, binDir } : null,
	);
	const initial = await runUpdateProcess(
		[process.execPath, "add", "--global", "--exact", `kabane@${source}`],
		home,
		env,
	);
	if (!initial.ok || initial.value.code !== 0) {
		await registry.stop();
		rmSync(work, { recursive: true, force: true });
		return {
			ok: false as const,
			error: "fixture registry installation failed",
		};
	}
	for (const name of ["@opentui/core", "@opentui/react", "react"]) {
		const linked = realpathSync(
			join(ROOT, "packages/board/node_modules", name),
		);
		const dest = join(globalDir, "node_modules", name);
		mkdirSync(dirname(dest), { recursive: true });
		if (!existsSync(dest)) symlinkSync(linked, dest, "dir");
	}
	const bin = join(binDir, "kabane");
	const packageBin = join(globalDir, "node_modules/kabane/bin/kabane.js");
	const run = async (args: string[]) => {
		const child = Bun.spawn(
			[process.execPath, options.isolated ? packageBin : bin, ...args],
			{ cwd: home, env, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		return { ok: true as const, value: { code, stdout, stderr } };
	};
	return {
		ok: true as const,
		work,
		home,
		install,
		globalDir,
		binDir,
		tracker,
		env,
		bin,
		packageBin,
		requests: registry.requests,
		run,
		close: (): void => {
			void registry.stop();
			rmSync(work, { recursive: true, force: true });
		},
		setDistTags: registry.setDistTags,
		stopRegistry: (): void => {
			void registry.stop();
		},
		setMetadata: registry.setMetadata,
		copyBundle: (): void => {
			const extracted = join(work, "original");
			mkdirSync(extracted, { recursive: true });
			Bun.spawnSync(["tar", "-xzf", archive, "-C", extracted]);
			cpSync(join(extracted, "package/bin"), dirname(packageBin), {
				recursive: true,
			});
		},
	};
};

export const updateSnapshot = (root: string): Record<string, string> => {
	const snapshot: Record<string, string> = {};
	const visit = (path: string): void => {
		if (!existsSync(path)) return;
		for (const name of readdirSync(path)) {
			const file = join(path, name),
				stat = lstatSync(file);
			if (stat.isSymbolicLink())
				snapshot[file.slice(root.length)] = `link:${readlinkSync(file)}`;
			else if (stat.isDirectory()) visit(file);
			else
				snapshot[file.slice(root.length)] = createHash("sha256")
					.update(readFileSync(file))
					.digest("hex");
		}
	};
	visit(root);
	return snapshot;
};
