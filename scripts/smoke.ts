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
import { ContextPageSchema } from "../packages/core/context-output";
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

const SMOKE_CONTEXT_BODY = "SMOKE_BODY_MUST_NOT_ECHO 🧭\n".repeat(1000);
const checkCommands = (version: string): string => {
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
	const concise = kabane("list", "--format", "concise", "--json").stdout.trim();
	const page = JSON.parse(concise) as {
		items?: { id: string; title: string }[];
		hasMore?: boolean;
	};
	if (
		!page.items?.some((item) => item.title === "Smoke task") ||
		page.hasMore !== false ||
		Buffer.byteLength(concise) > 16384
	)
		fail("installed concise CLI list shape/budget", {
			code: 0,
			stdout: concise,
			stderr: "",
		});
	const receipt = kabane(
		"add",
		"Concise smoke",
		"--description",
		SMOKE_CONTEXT_BODY,
		"--format",
		"concise",
		"--json",
	).stdout.trim();
	if (
		receipt.includes("SMOKE_BODY_MUST_NOT_ECHO") ||
		Buffer.byteLength(receipt) > 2048 ||
		!receipt.includes('"version"')
	)
		fail("installed concise CLI receipt");
	const created: unknown = JSON.parse(receipt);
	if (
		!created ||
		typeof created !== "object" ||
		!("id" in created) ||
		typeof created.id !== "string"
	)
		return fail("installed concise receipt missing identity");
	kabane("comment", created.id, "SMOKE_HUMAN_STEERING");
	let markdown = "";
	let cursor: string | undefined;
	do {
		const text = kabane(
			"context",
			created.id,
			"--format",
			"concise",
			"--sections",
			"description,discussion",
			"--no-deref",
			...(cursor ? ["--cursor", cursor] : []),
		).stdout;
		const context = ContextPageSchema.safeParse(JSON.parse(text));
		if (!context.success || Buffer.byteLength(text) > 16384)
			return fail("installed concise CLI context shape/budget");
		if (context.data.offset !== markdown.length)
			return fail("installed concise CLI context offset");
		markdown += context.data.markdown;
		cursor = context.data.nextCursor;
		if (
			!cursor &&
			(!context.data.completeness.descriptionComplete ||
				!context.data.completeness.humanSteeringComplete)
		)
			return fail("installed concise CLI context completeness");
	} while (cursor);
	if (
		!markdown.includes(SMOKE_CONTEXT_BODY) ||
		!markdown.includes("SMOKE_HUMAN_STEERING")
	)
		return fail("installed concise CLI context reconstruction");
	pass(
		"--version, --help, init, add, list, concise pages/receipts/context chunks",
	);
	return created.id;
};

const readReplies = async (
	stream: ReadableStream<Uint8Array>,
): Promise<string[]> => {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	const lines: string[] = [];
	let buffered = "";
	while (lines.length < 4) {
		const chunk = await reader.read();
		if (chunk.done) break;
		buffered += decoder.decode(chunk.value, { stream: true });
		let newline = buffered.indexOf("\n");
		while (newline >= 0) {
			lines.push(buffered.slice(0, newline));
			buffered = buffered.slice(newline + 1);
			newline = buffered.indexOf("\n");
		}
	}
	reader.releaseLock();
	return lines;
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

type SmokeReply = {
	id?: number;
	result?: {
		serverInfo?: { name?: string; version?: string };
		tools?: {
			name: string;
			inputSchema?: { properties?: Record<string, unknown> };
		}[];
		content?: { text?: string }[];
		isError?: boolean;
	};
};
const checkMcpDiscovery = (reply: SmokeReply | undefined): void => {
	const tool = reply?.result?.tools?.find(
		(tool) => tool.name === "kabane_list",
	);
	if (!tool?.inputSchema?.properties?.responseFormat)
		fail("installed MCP schema omits responseFormat");
	const context = reply?.result?.tools?.find(
		(tool) => tool.name === "kabane_context",
	);
	if (
		!context?.inputSchema?.properties?.sections ||
		!context.inputSchema.properties.cursor ||
		!context.inputSchema.properties.responseFormat
	)
		fail("installed MCP schema omits concise context options");
};
const checkMcpPage = (reply: SmokeReply | undefined): void => {
	const text = reply?.result?.content?.[0]?.text ?? "";
	if (
		reply?.result?.isError ||
		!text.includes('"items"') ||
		!text.includes("Smoke task") ||
		Buffer.byteLength(text) > 16384
	)
		fail("installed MCP concise list shape/budget");
};

// A harness closes the server's stdin when it goes away; the server must exit then, not linger.
const checkMcp = async (version: string, taskId: string): Promise<void> => {
	const proc = Bun.spawn([BIN, "mcp"], {
		cwd: REPO,
		env: isolated,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "inherit",
	});
	const requests = [
		INITIALIZE,
		{ jsonrpc: "2.0", method: "notifications/initialized" },
		{ jsonrpc: "2.0", id: 2, method: "tools/list" },
		{
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: { name: "kabane_list", arguments: { responseFormat: "concise" } },
		},
		{
			jsonrpc: "2.0",
			id: 4,
			method: "tools/call",
			params: {
				name: "kabane_context",
				arguments: { id: taskId, responseFormat: "concise", deref: false },
			},
		},
	];
	await proc.stdin.write(
		requests.map((request) => JSON.stringify(request)).join("\n") + "\n",
	);
	await proc.stdin.flush();
	const lines = await within(10_000, readReplies(proc.stdout));
	await proc.stdin.end();
	const exited = await within(10_000, proc.exited);
	if (exited === "timeout") proc.kill();
	if (lines === "timeout")
		return fail("kabane mcp never answered initialize/discover/concise call");
	const replies = lines.map((line) => JSON.parse(line) as SmokeReply);
	const info = replies.find((reply) => reply.id === 1)?.result?.serverInfo;
	checkMcpDiscovery(replies.find((reply) => reply.id === 2));
	checkMcpPage(replies.find((reply) => reply.id === 3));
	const contextReply = replies.find((reply) => reply.id === 4);
	const contextText = contextReply?.result?.content?.[0]?.text ?? "";
	const context = ContextPageSchema.safeParse(
		JSON.parse(contextText || "null"),
	);
	if (
		contextReply?.result?.isError ||
		!context.success ||
		Buffer.byteLength(contextText) > 16384 ||
		context.data.taskId !== taskId ||
		!context.data.nextCursor ||
		context.data.completeness.descriptionComplete ||
		context.data.completeness.humanSteeringComplete
	)
		fail("installed concise MCP context shape/budget/partial completeness");
	if (info?.name !== "kabane" || info.version !== version)
		fail(
			`kabane mcp answered initialize with ${lines.join("\n") || "nothing"}`,
		);
	if (exited === "timeout")
		fail("kabane mcp kept running after its stdin closed");
	pass(
		`kabane mcp initialize/discover/concise call: ${info?.name} ${info?.version}, exits when stdin closes`,
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
const contextId = checkCommands(version);
await checkMcp(version, contextId);
rmSync(WORK, { recursive: true, force: true });
console.error("smoke: passed");
