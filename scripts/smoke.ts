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
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ContextPageSchema } from "../packages/core/context-output";
import { TaskCommentSchema, TaskWorkLogSchema } from "../packages/core/schemas";
import { build, DIST } from "./build";
import {
	inspectArchive,
	ReleaseFilenameSchema,
	verifyReleaseFiles,
} from "./release-artifact";

const binaryMode = process.argv[2] === "--binary";
const ROOT = resolve(import.meta.dir, "..");
const WORK = mkdtempSync(join(tmpdir(), "kabane-smoke-"));
const HOME = join(WORK, "home");
const BUN_INSTALL = join(WORK, "bun");
const KABANE_HOME = join(WORK, "kabane");
const REPO = join(WORK, "repo");
const UNPACKED = join(WORK, "unpacked");
let BIN = join(BUN_INSTALL, "bin", "kabane");

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
	BUN_INSTALL_GLOBAL_DIR: join(BUN_INSTALL, "install/global"),
	BUN_INSTALL_BIN: join(BUN_INSTALL, "bin"),
	BUN_INSTALL_CACHE_DIR: join(WORK, "cache"),
	BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(WORK, "transpile-cache"),
	KABANE_HOME,
	KABANE_HARNESSES: "",
	PATH: binaryMode
		? "/usr/bin:/bin"
		: `${join(BUN_INSTALL, "bin")}:${process.env.PATH ?? ""}`,
};

const pack = (): string => {
	const ran = runOk(
		["npm", "pack", "--json", "--pack-destination", WORK],
		DIST,
	);
	const parsed = z
		.array(
			z.object({
				filename: ReleaseFilenameSchema,
				size: z.number().int().positive(),
			}),
		)
		.length(1)
		.safeParse(JSON.parse(ran.stdout));
	const packed = parsed.success ? parsed.data[0] : undefined;
	if (!packed) return fail("npm pack printed no valid tarball", ran);
	pass(`packed ${packed.filename}, ${(packed.size / 1024).toFixed(0)} kB`);
	return join(WORK, packed.filename);
};

const inspect = async (tarball: string): Promise<string> => {
	const result = await inspectArchive(tarball, UNPACKED, [ROOT, homedir()]);
	if (!result.ok) return fail(result.error.message);
	const count = readdirSync(join(UNPACKED, "package"), {
		recursive: true,
		withFileTypes: true,
	}).filter((file) => file.isFile()).length;
	pass(
		`tarball holds ${count} files, verified identity/exact externals, no unsafe member/map/machine path`,
	);
	return result.value.version;
};

// The source entry's hashbang passes a define through `env -S`, which some systems' env lacks. The
// bundle has the define built in, so the build gives it the plain one.
const checkHashbang = (): void => {
	const entry = readFileSync(join(UNPACKED, "package/bin/kabane.js"), "utf8");
	if (!entry.startsWith("#!/usr/bin/env bun\n"))
		fail(`bin/kabane.js starts with ${JSON.stringify(entry.split("\n")[0])}`);
	pass("bin/kabane.js has the plain #!/usr/bin/env bun hashbang");
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

const checkListImports = (): void => {
	const probe = join(WORK, "list-imports.cjs");
	const report = join(WORK, "list-imports.json");
	writeFileSync(
		probe,
		`process.on("exit", () => require("node:fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify(Object.keys(require.cache).filter(path => path.includes("/@opentui/")))));`,
	);
	const ran = runOk(
		[process.execPath, "--preload", probe, BIN, "list", "--format", "concise"],
		REPO,
		isolated,
	);
	const loaded = z
		.array(z.string())
		.safeParse(JSON.parse(readFileSync(report, "utf8")));
	if (!loaded.success || loaded.data.length !== 0)
		fail("installed kabane list loads @opentui modules", ran);
	pass("installed kabane list loads no @opentui modules");
};

const SMOKE_CONTEXT_BODY = "SMOKE_BODY_MUST_NOT_ECHO 🧭\n".repeat(1000);
const checkCliContext = (taskId: string): void => {
	let markdown = "";
	let cursor: string | undefined;
	do {
		const text = kabane(
			"context",
			taskId,
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
};

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
	if (binaryMode) {
		pass("standalone --version, --help, init, add, list (PATH=/usr/bin:/bin)");
		return "";
	}
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
	checkCliContext(created.id);
	pass(
		"--version, --help, init, add, list, concise pages/receipts/context chunks",
	);
	return created.id;
};

// A shipped lens resolves from the installed templates: `start` reads `quality` from there, then
// refuses the run on a lens no file holds, before it writes a run or spawns anything.
const checkShippedLens = (): void => {
	const created = z
		.object({ id: z.string() })
		.safeParse(
			JSON.parse(
				kabane("add", "Smoke lens", "--kind", "issue", "--json").stdout,
			),
		);
	if (!created.success) return fail("kabane add --json printed no id");
	kabane("done", created.data.id);
	const refused = run(
		[
			BIN,
			"loop",
			"start",
			created.data.id,
			"--no-worktree",
			"--lens",
			"quality",
			"--lens",
			"smoke",
		],
		REPO,
		isolated,
	);
	if (refused.code === 0 || !refused.stderr.includes("No lens smoke"))
		fail("kabane loop start did not read the shipped quality lens", refused);
};

// The bundled loop extension, off and then turned on in this KABANE_HOME's config: its command
// is found, its migrations run against the installed kabane.db, it reads its own store, and it
// reads a shipped lens.
const checkLoopExtension = (): void => {
	const off = run([BIN, "loop", "status"], REPO, isolated);
	if (off.code !== 1 || !off.stderr.includes("loop extension, which is off"))
		fail("kabane loop with the extension off printed no enable hint", off);
	const path = join(KABANE_HOME, "config.json");
	const config = z
		.record(z.unknown())
		.safeParse(JSON.parse(readFileSync(path, "utf8")));
	if (!config.success) return fail(`${path} is not a JSON object`);
	writeFileSync(path, JSON.stringify({ ...config.data, extensions: ["loop"] }));
	if (!kabane("loop", "--help").stdout.includes("kabane loop status"))
		fail("kabane loop --help printed no loop usage");
	const status = kabane("loop", "status");
	if (!status.stdout.includes("No loop runs"))
		fail("kabane loop status on a fresh home", status);
	checkShippedLens();
	pass(
		"loop extension: off hint, then enabled --help, status and a shipped lens",
	);
};

const readReplies = async (
	stream: ReadableStream<Uint8Array>,
	count: number,
): Promise<string[]> => {
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	const lines: string[] = [];
	let buffered = "";
	while (lines.length < count) {
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
			inputSchema?: {
				properties?: Record<string, unknown>;
				required?: string[];
			};
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
	checkMcpWriteDiscovery(reply);
};
const checkMcpWriteDiscovery = (reply: SmokeReply | undefined): void => {
	const tools = reply?.result?.tools ?? [];
	const comment = tools.find((tool) => tool.name === "kabane_comment");
	for (const alias of ["body", "text", "content"])
		if (
			!comment?.inputSchema?.properties?.[alias] ||
			comment.inputSchema.required?.includes(alias)
		)
			fail(`installed MCP schema omits optional comment ${alias}`);
	const log = tools.find((tool) => tool.name === "kabane_log");
	for (const field of ["refs", "commit"])
		if (
			!log?.inputSchema?.properties?.[field] ||
			log.inputSchema.required?.includes(field)
		)
			fail(`installed MCP schema omits optional log ${field}`);
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

const MCP_COMMENT_BODY = "  ## Installed MCP Markdown\n\n- kept verbatim\n";
const MCP_LABELED_REF = {
	uri: "commit:abc123",
	label: "Installed explicit label",
};
const MCP_WRITE_CALLS = [
	{ name: "kabane_comment", args: { body: MCP_COMMENT_BODY }, error: false },
	{ name: "kabane_comment", args: { text: MCP_COMMENT_BODY }, error: false },
	{ name: "kabane_comment", args: { content: MCP_COMMENT_BODY }, error: false },
	{
		name: "kabane_comment",
		args: {
			body: MCP_COMMENT_BODY,
			text: MCP_COMMENT_BODY,
			content: MCP_COMMENT_BODY,
		},
		error: false,
	},
	{ name: "kabane_log", args: { refs: [MCP_LABELED_REF] }, error: false },
	{ name: "kabane_log", args: { commit: "HEAD~1" }, error: false },
	{
		name: "kabane_log",
		args: { refs: [MCP_LABELED_REF], commit: "abc123" },
		error: false,
	},
	{
		name: "kabane_log",
		args: { refs: [MCP_LABELED_REF], commit: "def456" },
		error: false,
	},
	{ name: "kabane_comment", args: {}, error: true },
	{ name: "kabane_comment", args: { body: "a", text: "b" }, error: true },
	{ name: "kabane_log", args: {}, error: true },
	{ name: "kabane_log", args: { commit: "" }, error: true },
];

const checkMcpWrites = (replies: SmokeReply[], taskId: string): void => {
	for (const [index, call] of MCP_WRITE_CALLS.entries()) {
		const reply = replies.find((reply) => reply.id === 5 + index);
		if (!reply?.result || Boolean(reply.result.isError) !== call.error)
			fail(
				`installed MCP write ${call.name} #${index} returned unexpected result`,
			);
	}
	const stored = z
		.object({
			comments: z.array(TaskCommentSchema),
			workLogs: z.array(TaskWorkLogSchema),
		})
		.safeParse(JSON.parse(kabane("show", taskId, "--json").stdout));
	if (!stored.success)
		return fail("installed MCP writes have invalid stored shape");
	const comments = stored.data.comments.filter(
		(comment) => comment.content === MCP_COMMENT_BODY,
	);
	if (
		stored.data.comments.length !== 5 ||
		comments.length !== 4 ||
		comments.some(
			(comment) =>
				comment.author !== "cabane://actor/human/smoke" ||
				comment.authorType !== "human",
		)
	)
		fail(
			"installed MCP comment aliases changed content/author or wrote on error",
		);
	const refs = stored.data.workLogs.map((entry) =>
		entry.refs.map((ref) => ({
			uri: ref.uri,
			...(ref.label === undefined ? {} : { label: ref.label }),
		})),
	);
	const expectedRefs = [
		[MCP_LABELED_REF],
		[{ uri: "commit:HEAD~1" }],
		[MCP_LABELED_REF],
		[MCP_LABELED_REF, { uri: "commit:def456" }],
	];
	if (JSON.stringify(refs) !== JSON.stringify(expectedRefs))
		fail(
			"installed MCP commit shorthand changed refs/labels/dedup or wrote on error",
		);
	pass(
		"installed MCP comment aliases and commit shorthand persist, invalid inputs do not write",
	);
};

const checkMcpContext = (
	contextReply: SmokeReply | undefined,
	taskId: string,
): void => {
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
};

const checkBinaryMcp = (
	replies: SmokeReply[],
	version: string,
	exited: number | "timeout",
): void => {
	const info = replies.find((reply) => reply.id === 1)?.result?.serverInfo;
	const tools = replies.find((reply) => reply.id === 2)?.result?.tools;
	if (
		info?.name !== "kabane" ||
		info.version !== version ||
		!tools?.some((tool) => tool.name === "kabane_list") ||
		exited !== 0
	)
		return fail("standalone MCP identity/discovery/stdin-close exit");
	pass(
		`standalone MCP initialize + tools/list: ${info.name} ${info.version}, ${tools.length} tools; exits on stdin close`,
	);
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
		...MCP_WRITE_CALLS.map((call, index) => ({
			jsonrpc: "2.0",
			id: 5 + index,
			method: "tools/call",
			params: { name: call.name, arguments: { id: taskId, ...call.args } },
		})),
	];
	await proc.stdin.write(
		(binaryMode ? requests.slice(0, 3) : requests)
			.map((request) => JSON.stringify(request))
			.join("\n") + "\n",
	);
	await proc.stdin.flush();
	const lines = await within(
		10_000,
		readReplies(proc.stdout, binaryMode ? 2 : 4 + MCP_WRITE_CALLS.length),
	);
	await proc.stdin.end();
	const exited = await within(10_000, proc.exited);
	if (exited === "timeout") proc.kill();
	if (lines === "timeout")
		return fail("kabane mcp never answered initialize/discover/concise call");
	const replies = lines.map((line) => JSON.parse(line) as SmokeReply);
	const info = replies.find((reply) => reply.id === 1)?.result?.serverInfo;
	if (binaryMode) return checkBinaryMcp(replies, version, exited);
	checkMcpDiscovery(replies.find((reply) => reply.id === 2));
	checkMcpPage(replies.find((reply) => reply.id === 3));
	checkMcpContext(
		replies.find((reply) => reply.id === 4),
		taskId,
	);
	if (info?.name !== "kabane" || info.version !== version)
		fail(
			`kabane mcp answered initialize with ${lines.join("\n") || "nothing"}`,
		);
	if (exited === "timeout")
		fail("kabane mcp kept running after its stdin closed");
	checkMcpWrites(replies, taskId);
	pass(
		`kabane mcp initialize/discover/concise call: ${info?.name} ${info?.version}, exits when stdin closes`,
	);
};

const [mode, input, ...extra] = process.argv.slice(2);
if (
	(mode !== undefined &&
		mode !== "--tarball" &&
		mode !== "--artifact-dir" &&
		mode !== "--binary") ||
	(mode !== undefined && !input) ||
	extra.length
)
	fail(
		"usage: bun run smoke [--tarball <existing.tgz> | --artifact-dir <retained-release> | --binary <extracted-executable>]",
	);
if (binaryMode && input) {
	BIN = resolve(input);
	const source = z
		.object({ version: z.string() })
		.safeParse(
			JSON.parse(readFileSync(join(ROOT, "packages/cli/package.json"), "utf8")),
		);
	if (!source.success) fail("invalid source version");
	const version = source.success ? source.data.version : "";
	if (
		process.env.GITHUB_REF_TYPE === "tag" &&
		process.env.GITHUB_REF !== `refs/tags/v${version}`
	)
		fail("binary smoke tag/source version mismatch");
	mkdirSync(HOME, { recursive: true });
	mkdirSync(REPO);
	runOk(["git", "init", "-q"], REPO, isolated);
	// A project's preload and dotenv must never execute or alter a compiled CLI.
	writeFileSync(join(REPO, "bunfig.toml"), 'preload = ["./poison.ts"]\n');
	writeFileSync(join(REPO, "poison.ts"), "process.exit(91);\n");
	writeFileSync(
		join(REPO, ".env"),
		`KABANE_HOME=${join(WORK, "dotenv-home")}\n`,
	);
	// Leave KABANE_HOME unset once: dotenv would otherwise be masked by the explicit env.
	runOk(
		[BIN, "init", "--actor", "cabane://actor/human/smoke", "--device", "smoke"],
		REPO,
		{ ...isolated, KABANE_HOME: undefined },
	);
	if (
		!existsSync(join(HOME, ".kabane/config.json")) ||
		existsSync(join(WORK, "dotenv-home"))
	)
		fail("standalone loaded project dotenv");
	checkCommands(version);
	checkLoopExtension();
	await checkMcp(version, "");
	rmSync(WORK, { recursive: true, force: true });
	console.error("smoke: passed standalone binary");
	process.exit(0);
}
let tarball: string;
let expectedVersion: string | undefined;
let artifactDir: string | undefined;
if (mode === "--artifact-dir" && input) {
	artifactDir = resolve(input);
	const verified = verifyReleaseFiles(artifactDir);
	const record = verified.ok ? verified.value : fail(verified.error.message);
	if (process.env.GITHUB_SHA && record.commit !== process.env.GITHUB_SHA)
		fail("artifact/event source commit mismatch");
	tarball = join(artifactDir, record.filename);
	expectedVersion = record.version;
	pass("retained artifact hashes verified; no build/pack");
} else if (mode === "--tarball" && input) {
	tarball = resolve(input);
	pass("using existing archive; no build/pack");
} else {
	await build();
	pass("built");
	tarball = pack();
}
const version = await inspect(tarball);
checkHashbang();
if (expectedVersion && version !== expectedVersion)
	fail("archive/release manifest version mismatch");
install(tarball);
mkdirSync(REPO);
runOk(["git", "init", "-q"], REPO, isolated);
const contextId = checkCommands(version);
checkListImports();
await checkMcp(version, contextId);
checkLoopExtension();
if (artifactDir) {
	const verified = verifyReleaseFiles(artifactDir);
	if (!verified.ok) fail("retained artifact changed during installed smoke");
}
rmSync(WORK, { recursive: true, force: true });
console.error("smoke: passed");
