import { createHash } from "node:crypto";
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
export const UPDATE_TARGET = sourceVersion
	.split(".")
	.map((part, index) => (index === 2 ? Number(part) + 1 : part))
	.join(".");
const ROOT = resolve(import.meta.dir, "../../..");
export const createUpdateFixture = async (
	archive: string,
	options: {
		isolated?: boolean;
		age?: number;
		young?: boolean;
		failScript?: boolean;
		removeBin?: boolean;
		configured?: boolean;
	} = {},
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
	writeFileSync(join(tracker, "config.json"), "NOT_VALID_JSON_DO_NOT_READ");
	writeFileSync(join(tracker, "kabane.db"), "NOT_A_DATABASE_DO_NOT_OPEN");
	writeFileSync(join(tracker, "kabane.db-wal"), "WAL_SENTINEL");
	writeFileSync(join(tracker, "kabane.db-shm"), "SHM_SENTINEL");
	writeFileSync(join(home, ".claude.json"), "HARNESS_CONFIG_SENTINEL");
	const targetDir = join(work, "target/package");
	mkdirSync(join(targetDir, "bin"), { recursive: true });
	const targetManifest = {
		name: "kabane",
		version: UPDATE_TARGET,
		type: "module",
		bin: { kabane: "bin/kabane.js" },
		engines: { bun: ">=1.4.0" },
		...(options.failScript
			? { scripts: { postinstall: "bun -e 'process.exit(7)'" } }
			: options.removeBin
				? {
						scripts: {
							postinstall: `bun -e 'require("node:fs").rmSync(process.env.BUN_INSTALL + "/bin/kabane", {force:true})'`,
						},
					}
				: {}),
	};
	writeFileSync(
		join(targetDir, "package.json"),
		JSON.stringify(targetManifest),
	);
	writeFileSync(
		join(targetDir, "bin/kabane.js"),
		`#!/usr/bin/env bun\nconsole.log(${JSON.stringify(UPDATE_TARGET)});\n`,
		{ mode: 0o755 },
	);
	const targetTar = join(work, "target.tgz");
	const packed = Bun.spawnSync(["tar", "-czf", targetTar, "package"], {
		cwd: dirname(targetDir),
	});
	if (packed.exitCode !== 0)
		return { ok: false as const, error: "fixture tar failed" };
	const tarballs = {
		[UPDATE_SOURCE]: readFileSync(archive),
		[UPDATE_TARGET]: readFileSync(targetTar),
	};
	const requests: string[] = [];
	let metadata: unknown;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			requests.push(path);
			if (path === "/kabane") return Response.json(metadata);
			if (path === `/kabane/-/kabane-${UPDATE_SOURCE}.tgz`)
				return new Response(tarballs[UPDATE_SOURCE]);
			if (path === `/kabane/-/kabane-${UPDATE_TARGET}.tgz`)
				return new Response(tarballs[UPDATE_TARGET]);
			return new Response("unconfigured fixture request", { status: 404 });
		},
	});
	const registry = `http://127.0.0.1:${server.port}`;
	metadata = {
		name: "kabane",
		"dist-tags": { latest: UPDATE_TARGET },
		time: {
			[UPDATE_SOURCE]: "2020-01-01T00:00:00Z",
			[UPDATE_TARGET]: options.young
				? new Date().toISOString()
				: "2020-01-01T00:00:00Z",
		},
		versions: Object.fromEntries(
			Object.entries(tarballs).map(([version, bytes]) => [
				version,
				{
					...(version === UPDATE_TARGET
						? targetManifest
						: {
								name: "kabane",
								version,
								bin: { kabane: "bin/kabane.js" },
								engines: { bun: ">=1.4.0" },
							}),
					// External imports use read-only repo modules in this controlled manager fixture;
					// the release smoke separately verifies an unmodified registry dependency install.
					dist: {
						tarball: `${registry}/kabane/-/kabane-${version}.tgz`,
						integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
					},
				},
			]),
		),
	};
	writeFileSync(
		join(home, ".bunfig.toml"),
		`[install]\nregistry = "${registry}"\nminimumReleaseAge = ${options.age ?? 0}\nlinker = "${options.isolated ? "isolated" : "hoisted"}"\n${options.configured ? `globalDir = "${globalDir}"\nglobalBinDir = "${binDir}"\n` : ""}`,
	);
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
	if (options.configured) {
		env.BUN_INSTALL_GLOBAL_DIR = globalDir;
		env.BUN_INSTALL_BIN = binDir;
	}
	const initial = await runUpdateProcess(
		[process.execPath, "add", "--global", "--exact", `kabane@${UPDATE_SOURCE}`],
		home,
		env,
	);
	if (!initial.ok || initial.value.code !== 0) {
		await server.stop(true);
		rmSync(work, { recursive: true, force: true });
		return {
			ok: false as const,
			error: "fixture registry installation failed",
		};
	}
	for (const name of ["@opentui/core", "@opentui/react", "react"]) {
		const source = realpathSync(
			join(ROOT, "packages/board/node_modules", name),
		);
		const dest = join(globalDir, "node_modules", name);
		mkdirSync(dirname(dest), { recursive: true });
		if (!existsSync(dest)) symlinkSync(source, dest, "dir");
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
	const close = (): void => {
		void server.stop(true);
		rmSync(work, { recursive: true, force: true });
	};
	const setLatest = (version: string, engine = ">=1.4.0"): void => {
		metadata = {
			name: "kabane",
			"dist-tags": { latest: version },
			versions: {
				[version]: {
					...targetManifest,
					version,
					engines: { bun: engine },
					dist: {
						tarball: `${registry}/kabane/-/kabane-${UPDATE_TARGET}.tgz`,
						integrity: `sha512-${createHash("sha512")
							.update(tarballs[UPDATE_TARGET] ?? Buffer.alloc(0))
							.digest("base64")}`,
					},
				},
			},
		};
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
		requests,
		run,
		close,
		setLatest,
		stopRegistry: (): void => {
			void server.stop(true);
		},
		setMetadata: (value: unknown): void => {
			metadata = value;
		},
		copyBundle: (): void => {
			const extracted = join(work, "original");
			mkdirSync(extracted, { recursive: true });
			Bun.spawnSync(["tar", "-xzf", archive, "-C", extracted]);
			cpSync(join(extracted, "package/bin/kabane.js"), packageBin);
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
