#!/usr/bin/env bun
/**
 * Pack-and-install smoke test of the published `kabane` package, run by CI and before a release
 * (docs/release.md): build, `npm pack`, check what the tarball holds, install it with
 * `bun add -g` the way a user would, then drive the installed bin.
 *
 * Everything happens in one temp directory with its own HOME, BUN_INSTALL and KABANE_HOME, and
 * KABANE_HARNESSES empty, so neither the real tracker nor a harness config is ever touched. The
 * install alone reads the invoking user's global bunfig (through XDG_CONFIG_HOME), so it resolves
 * the external dependencies under the same registry and release-age policy a real install would.
 * The directory is removed on success and kept for inspection on failure.
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { build, DIST } from "./build";

const ROOT = resolve(import.meta.dir, "..");
const WORK = mkdtempSync(join(tmpdir(), "kabane-smoke-"));
const HOME = join(WORK, "home");
const BUN_INSTALL = join(WORK, "bun");
const KABANE_HOME = join(WORK, "kabane");
const REPO = join(WORK, "repo");
const UNPACKED = join(WORK, "unpacked");
const BIN = join(BUN_INSTALL, "bin", "kabane");

type Ran = { code: number; stdout: string; stderr: string };

const fail = (message: string, ran?: Ran): never => {
	console.error(`smoke: FAIL ${message}`);
	if (ran) console.error(`exit ${ran.code}\n${ran.stdout}\n${ran.stderr}`);
	console.error(`smoke: kept ${WORK}`);
	process.exit(1);
};

const pass = (message: string): void => console.error(`smoke: ok ${message}`);

const run = (
	cmd: string[],
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Ran => {
	const proc = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" });
	return {
		code: proc.exitCode,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
};

const runOk = (cmd: string[], cwd: string, env?: NodeJS.ProcessEnv): Ran => {
	const ran = run(cmd, cwd, env);
	if (ran.code !== 0) fail(cmd.join(" "), ran);
	return ran;
};

const isolated: NodeJS.ProcessEnv = {
	...process.env,
	HOME,
	XDG_CONFIG_HOME: join(HOME, ".config"),
	BUN_INSTALL,
	KABANE_HOME,
	KABANE_HARNESSES: "",
	PATH: `${join(BUN_INSTALL, "bin")}:${process.env.PATH ?? ""}`,
};

const pack = (): string => {
	const ran = runOk(
		["npm", "pack", "--json", "--pack-destination", WORK],
		DIST,
	);
	const [packed] = JSON.parse(ran.stdout) as {
		filename: string;
		size: number;
	}[];
	if (!packed) return fail("npm pack printed no tarball", ran);
	pass(`packed ${packed.filename}, ${(packed.size / 1024).toFixed(0)} kB`);
	return join(WORK, packed.filename);
};

const filesUnder = (dir: string): string[] =>
	readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name));

// The tarball must install nobody else's code and carry nothing of the machine that built it.
const inspect = (tarball: string): void => {
	mkdirSync(UNPACKED);
	runOk(["tar", "-xzf", tarball, "-C", UNPACKED], WORK);
	const files = filesUnder(join(UNPACKED, "package"));
	if (
		readFileSync(join(UNPACKED, "package/package.json"), "utf8").includes(
			"@cabane/",
		)
	)
		fail("the published package.json names a @cabane/* package");
	const maps = files.filter((file) => file.endsWith(".map"));
	if (maps.length > 0) fail(`source maps in the tarball: ${maps.join(", ")}`);
	const leaks = files.filter((file) => {
		const text = readFileSync(file, "utf8");
		return text.includes(ROOT) || text.includes(homedir());
	});
	if (leaks.length > 0)
		fail(
			`absolute paths of this machine in ${leaks.map((f) => relative(UNPACKED, f)).join(", ")}`,
		);
	pass(
		`tarball holds ${files.length} files, no @cabane/* dependency, no machine paths`,
	);
};

const install = (tarball: string): void => {
	runOk(["bun", "add", "-g", tarball], WORK, {
		...isolated,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? homedir(),
	});
	if (!existsSync(BIN)) fail(`bun add -g left no ${BIN}`);
	pass("installed with bun add -g");
};

const kabane = (...args: string[]): Ran =>
	runOk([BIN, ...args], REPO, isolated);

const checkCommands = (version: string): void => {
	const printed = kabane("--version").stdout.trim();
	if (printed !== version)
		fail(`kabane --version printed ${printed}, expected ${version}`);
	if (!kabane("--help").stdout.includes("Usage: kabane"))
		fail("kabane --help printed no usage");
	kabane("init", "--actor", "cabane://actor/human/smoke", "--device", "smoke");
	if (!existsSync(join(KABANE_HOME, "config.json")))
		fail("kabane init wrote no config.json");
	kabane("add", "Smoke task");
	if (!kabane("list", "--json").stdout.includes("Smoke task"))
		fail("kabane list does not show the task kabane add created");
	pass("--version, --help, init, add, list");
};

const readLine = async (
	stream: ReadableStream<Uint8Array>,
): Promise<string> => {
	const decoder = new TextDecoder();
	let buffered = "";
	for await (const chunk of stream) {
		buffered += decoder.decode(chunk, { stream: true });
		const newline = buffered.indexOf("\n");
		if (newline >= 0) return buffered.slice(0, newline);
	}
	return buffered;
};

const INITIALIZE = {
	jsonrpc: "2.0",
	id: 1,
	method: "initialize",
	params: {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "kabane-smoke", version: "0" },
	},
};

const within = <T>(ms: number, promise: Promise<T>): Promise<T | "timeout"> =>
	Promise.race([promise, Bun.sleep(ms).then(() => "timeout" as const)]);

// A harness closes the server's stdin when it goes away; the server must exit then, not linger.
const checkMcp = async (version: string): Promise<void> => {
	const proc = Bun.spawn([BIN, "mcp"], {
		cwd: REPO,
		env: isolated,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});
	proc.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
	await proc.stdin.flush();
	const line = await within(10_000, readLine(proc.stdout));
	await proc.stdin.end();
	const exited = await within(10_000, proc.exited);
	if (exited === "timeout") proc.kill();
	if (line === "timeout") return fail("kabane mcp never answered initialize");
	const reply = JSON.parse(line || "{}") as {
		result?: { serverInfo?: { name?: string; version?: string } };
	};
	const info = reply.result?.serverInfo;
	if (info?.name !== "kabane" || info.version !== version)
		fail(`kabane mcp answered initialize with ${line || "nothing"}`);
	if (exited === "timeout")
		fail("kabane mcp kept running after its stdin closed");
	pass(
		`kabane mcp initialize: ${info?.name} ${info?.version}, exits when stdin closes`,
	);
};

await build();
pass("built");
const { version } = JSON.parse(
	readFileSync(join(DIST, "package.json"), "utf8"),
) as {
	version: string;
};
const tarball = pack();
inspect(tarball);
install(tarball);
mkdirSync(REPO);
runOk(["git", "init", "-q"], REPO, isolated);
checkCommands(version);
await checkMcp(version);
rmSync(WORK, { recursive: true, force: true });
console.error("smoke: passed");
