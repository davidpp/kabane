import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Doctor, type Extension } from "@kabane/extension";
import type { McpInstall } from "../commands/mcp-install";
import { settingsPort } from "../context";
import { McpClients } from "../mcp-clients";
import { Self } from "../self";
import { type InstallDeps, install } from "./install";

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0))
		rmSync(folder, { recursive: true, force: true });
});

const write = (path: string, text: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
};

const ALL = ["claude", "codex", "gemini"];

/**
 * A user home holding each harness's config in its own format, a kabane project, and this kabane:
 * a compiled binary at a versioned mise path, the way `mise up` leaves the previous one behind.
 */
const setup = () => {
	const folder = realpathSync(mkdtempSync(join(tmpdir(), "doctor-install-")));
	folders.push(folder);
	const home = join(folder, "user");
	const root = join(folder, "project");
	const kabaneHome = join(folder, "kabane-home");
	mkdirSync(join(root, ".kabane"), { recursive: true });
	mkdirSync(kabaneHome);
	expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
	writeFileSync(join(root, ".kabane/scope"), "pinned\n");
	const binary = (version: string) =>
		join(home, `.local/share/mise/installs/kabane/${version}/bin/kabane`);
	const current = binary("1.1.0");
	write(current, "#!/bin/sh\n");
	const launcher = { command: current, args: [] };
	const entry = (harness: string, command = current, args: string[] = []) => ({
		command,
		args: [...args, "mcp", "--as", McpClients.actorFor(harness)],
	});
	const claude = (user: object, local?: object) =>
		write(
			join(home, ".claude.json"),
			JSON.stringify(
				{
					numStartups: 12,
					mcpServers: { other: { command: "npx", args: ["x"] }, ...user },
					projects: {
						[root]: {
							allowedTools: [],
							mcpServers: local ?? {},
							hasTrustDialogAccepted: true,
						},
					},
				},
				null,
				2,
			),
		);
	const codex = (launch: { command: string; args: string[] } | undefined) =>
		write(
			join(home, ".codex/config.toml"),
			[
				'model = "gpt-5-codex"',
				"",
				"[mcp_servers.other]",
				'command = "npx"',
				"",
				...(launch
					? [
							"[mcp_servers.kabane]",
							`command = ${JSON.stringify(launch.command)}`,
							`args = [${launch.args.map((a) => JSON.stringify(a)).join(", ")}]`,
						]
					: []),
				"",
			].join("\n"),
		);
	const gemini = (launch: { command: string; args: string[] } | undefined) =>
		write(
			join(home, ".gemini/settings.json"),
			`{
  // Gemini's settings accept comments.
  "theme": "Default",
  "mcpServers": ${JSON.stringify(launch ? { kabane: launch } : {})}
}
`,
		);
	const ctx = {
		home: kabaneHome,
		store: kabaneHome,
		cwd: root,
		actor: "",
		harnessMode: "auto" as const,
		settings: settingsPort(kabaneHome),
	};
	const deps = (extra: InstallDeps = {}): InstallDeps => ({
		home,
		env: {},
		which: (b) => (ALL.includes(b) ? `/usr/bin/${b}` : null),
		launcher,
		...extra,
	});
	const ids = async (extra: InstallDeps = {}) => {
		const found = await install(ctx, deps(extra));
		if (!found.ok) throw found.error;
		return found.value.map(({ id, severity }) => `${id}:${severity}`);
	};
	return {
		home,
		root,
		ctx,
		deps,
		ids,
		binary,
		entry,
		claude,
		codex,
		gemini,
	};
};

test("entries that launch this kabane, and missing ones, have no findings", async () => {
	const s = setup();
	expect(await s.ids()).toEqual([]);
	s.claude({ kabane: { type: "stdio", ...s.entry("claude"), env: {} } });
	s.codex(s.entry("codex"));
	s.gemini(s.entry("gemini"));
	expect(await s.ids()).toEqual([]);
});

test("an entry left on a version mise removed is mentioned with the harness, both commands and the fix", async () => {
	const s = setup();
	const old = s.binary("1.0.0");
	s.claude({ kabane: s.entry("claude", old) });
	s.codex(s.entry("codex", old));
	s.gemini(s.entry("gemini", old));
	const found = await install(s.ctx, s.deps());
	if (!found.ok) throw found.error;
	expect(found.value.map(({ id, severity }) => `${id}:${severity}`)).toEqual([
		"mcp-entry-stale-claude:mention",
		"mcp-entry-stale-codex:mention",
		"mcp-entry-stale-gemini:mention",
	]);
	for (const finding of found.value) {
		expect(finding.summary).toContain(old);
		expect(finding.summary).toContain(s.binary("1.1.0"));
		expect(finding.summary).toContain(
			`kabane doctor --fix kabane/${finding.id}`,
		);
	}
	expect(found.value.map(({ path }) => path)).toEqual([
		join(s.home, ".claude.json"),
		join(s.home, ".codex/config.toml"),
		join(s.home, ".gemini/settings.json"),
	]);
});

test("an entry from before the rename, which differs only by its old-prefix actor, is fixed automatically", async () => {
	const s = setup();
	const legacy = (harness: string, command?: string) => {
		const launch = s.entry(harness, command);
		return {
			...launch,
			args: launch.args.map((arg) =>
				arg.replace("kabane://actor/", "cabane://actor/"),
			),
		};
	};
	s.claude({ kabane: legacy("claude") });
	s.codex(legacy("codex"));
	const found = await install(s.ctx, s.deps());
	if (!found.ok) throw found.error;
	expect(found.value.map(({ id, severity }) => `${id}:${severity}`)).toEqual([
		"mcp-entry-actor-claude:auto",
		"mcp-entry-actor-codex:auto",
	]);
	expect(found.value[0]?.summary).toContain("cabane://actor/agent/claude");
	expect(found.value[0]?.summary).toContain("kabane://actor/agent/claude");
	// An old prefix on an entry that also runs another kabane is that entry's stale finding alone.
	s.claude({ kabane: legacy("claude", s.binary("1.0.0")) });
	s.codex(s.entry("codex"));
	expect(await s.ids()).toEqual(["mcp-entry-stale-claude:mention"]);
});

test("the old-prefix repair re-registers only the scope that has it, never a deliberate other checkout", async () => {
	const s = setup();
	const bun = join(s.home, ".bun/bin/bun");
	const script = join(s.home, "src/kabane/packages/cli/index.ts");
	write(bun, "");
	write(script, "");
	const legacy = s.entry("claude");
	legacy.args = legacy.args.map((arg) => arg.replace("kabane://", "cabane://"));
	// What `claude mcp add` writes beside the launch.
	s.claude(
		{ kabane: { type: "stdio", ...legacy, env: {} } },
		{ kabane: s.entry("claude", bun, [script]) },
	);
	expect(await s.ids()).toEqual([
		"mcp-entry-actor-claude:auto",
		"mcp-entry-stale-claude:suggest",
	]);
	const calls: string[][] = [];
	const run: McpInstall.Runner = async (argv) => {
		calls.push(argv);
		return { code: 0, out: "", err: "" };
	};
	const source = {
		name: "kabane",
		doctor: (ctx: Extension.Ctx) => install(ctx, s.deps({ run })),
	};
	const fixed = await Doctor.run([source], s.ctx, { fix: true });
	expect(fixed.fixes.map((f) => [f.id, f.result.ok])).toEqual([
		["mcp-entry-actor-claude", true],
	]);
	expect(
		calls
			.filter((argv) => argv[2] !== "get")
			.map((argv) => argv.slice(0, 5).join(" ")),
	).toEqual(["claude mcp remove -s user", "claude mcp add -s user"]);
});

test("an old-prefix entry that sets more than its launch is no automatic repair: re-registering would drop the rest", async () => {
	const s = setup();
	const legacy = s.entry("codex");
	legacy.args = legacy.args.map((arg) => arg.replace("kabane://", "cabane://"));
	write(
		join(s.home, ".codex/config.toml"),
		[
			"[mcp_servers.kabane]",
			`command = ${JSON.stringify(legacy.command)}`,
			`args = [${legacy.args.map((a) => JSON.stringify(a)).join(", ")}]`,
			'env = { KABANE_HOME = "/elsewhere/.kabane" }',
			"",
		].join("\n"),
	);
	const found = await install(s.ctx, s.deps());
	if (!found.ok) throw found.error;
	expect(found.value.map(({ id, severity }) => `${id}:${severity}`)).toEqual([
		"mcp-entry-actor-kept-codex:mention",
	]);
	expect(found.value[0]?.fix).toBeUndefined();
	expect(found.value[0]?.summary).toContain("env");
	expect(found.value[0]?.summary).toContain(
		"cabane://actor/agent/codex with kabane://actor/agent/codex",
	);
});

test("Claude's local scope for this project is read beside its user scope", async () => {
	const s = setup();
	s.claude(
		{ kabane: s.entry("claude") },
		{ kabane: s.entry("claude", s.binary("0.9.0")) },
	);
	const found = await install(s.ctx, s.deps());
	if (!found.ok) throw found.error;
	expect(found.value.map((f) => f.id)).toEqual(["mcp-entry-stale-claude"]);
	expect(found.value[0]?.summary).toContain(`projects["${s.root}"]`);
});

test("an entry that runs a source checkout is a suggestion: it may be deliberate", async () => {
	const s = setup();
	const bun = join(s.home, ".bun/bin/bun");
	const script = join(s.home, "src/kabane/packages/cli/index.ts");
	write(bun, "");
	write(script, "");
	s.codex(s.entry("codex", bun, [script]));
	expect(await s.ids()).toEqual(["mcp-entry-stale-codex:suggest"]);
	// The same checkout, deleted, launches nothing.
	rmSync(script);
	expect(await s.ids()).toEqual(["mcp-entry-stale-codex:mention"]);
});

test("a Bun-only difference is no finding while that bun is there, and a mention once it is gone", async () => {
	const s = setup();
	const bun = (version: string) =>
		join(s.home, `.local/share/mise/installs/bun/${version}/bin/bun`);
	const script = join(s.home, "src/kabane/packages/cli/index.ts");
	const shim = join(s.home, ".local/share/mise/shims/bun");
	for (const path of [bun("1.4.2"), script, shim]) write(path, "");
	const launcher = { command: shim, args: [script] };
	s.claude({ kabane: s.entry("claude", bun("1.4.2"), [script]) });
	expect(await s.ids({ launcher })).toEqual([]);
	// mise pruned 1.4.2: the entry starts nothing.
	rmSync(dirname(dirname(bun("1.4.2"))), { recursive: true });
	expect(await s.ids({ launcher })).toEqual(["mcp-entry-stale-claude:mention"]);
	// Another script on a bun is another kabane, whatever the bun.
	write(bun("1.4.2"), "");
	const other = join(s.home, "elsewhere/index.ts");
	write(other, "");
	s.claude({ kabane: s.entry("claude", bun("1.4.2"), [other]) });
	expect(await s.ids({ launcher })).toEqual(["mcp-entry-stale-claude:suggest"]);
});

test("CODEX_HOME moves Codex's config; KABANE_HARNESSES narrows, and empty reads nothing", async () => {
	const s = setup();
	s.codex(s.entry("codex", s.binary("1.0.0")));
	s.gemini(s.entry("gemini", s.binary("1.0.0")));
	expect(
		await s.ids({ env: { CODEX_HOME: join(s.home, "elsewhere") } }),
	).toEqual(["mcp-entry-stale-gemini:mention"]);
	expect(await s.ids({ env: { KABANE_HARNESSES: "codex" } })).toEqual([
		"mcp-entry-stale-codex:mention",
	]);
	// Unparseable configs would fail the check if they were read.
	write(join(s.home, ".claude.json"), "{");
	write(join(s.home, ".gemini/settings.json"), "{");
	expect(await s.ids({ env: { KABANE_HARNESSES: "" } })).toEqual([]);
});

test("the fix re-registers through mcp install --force, and only when named", async () => {
	const s = setup();
	s.gemini(s.entry("gemini", s.binary("1.0.0")));
	const calls: string[][] = [];
	const run: McpInstall.Runner = async (argv) => {
		calls.push(argv);
		return {
			code: 0,
			out: "",
			err: argv[2] === "list" ? "✓ kabane: /old (stdio) - Disconnected" : "",
		};
	};
	const source = {
		name: "kabane",
		doctor: (ctx: Extension.Ctx) => install(ctx, s.deps({ run })),
	};
	const bare = await Doctor.run([source], s.ctx, { fix: true });
	expect(bare.fixes).toEqual([]);
	expect(calls).toEqual([]);
	const named = await Doctor.run([source], s.ctx, {
		fix: ["kabane/mcp-entry-stale-gemini"],
	});
	expect(named.fixes).toHaveLength(1);
	expect(named.fixes[0]?.result.ok).toBe(true);
	expect(calls.map((c) => c.slice(0, 3).join(" "))).toEqual([
		"gemini mcp list",
		"gemini mcp remove",
		"gemini mcp add",
	]);
	expect(calls[2]?.slice(-4)).toEqual([
		s.binary("1.1.0"),
		"mcp",
		"--as",
		"kabane://actor/agent/gemini",
	]);
});

for (const customConfig of [false, true])
	test.skipIf(Bun.which("claude") === null)(
		`real Claude registrations in user and local scopes are both repaired (custom config: ${customConfig})`,
		() => {
			const s = setup();
			const cli = join(import.meta.dir, "../../index.ts");
			const expected = McpClients.launchFor(
				{ command: Self.lasting().command, args: [cli] },
				"claude",
			);
			s.claude(
				{ kabane: expected },
				{ kabane: s.entry("claude", "/gone/kabane") },
			);
			// Claude reads CLAUDE_CONFIG_DIR before HOME, so a contributor's own value would send these
			// removes and adds to their real config.
			const { CLAUDE_CONFIG_DIR: _own, ...inherited } = process.env;
			const configDir = join(s.home, "custom-claude");
			if (customConfig) {
				mkdirSync(configDir);
				renameSync(
					join(s.home, ".claude.json"),
					join(configDir, ".claude.json"),
				);
			}
			const env = {
				...inherited,
				...(customConfig ? { CLAUDE_CONFIG_DIR: configDir } : {}),
				HOME: s.home,
				KABANE_HOME: s.ctx.home,
				KABANE_HARNESSES: "claude",
			};
			const run = (...args: string[]) => {
				const result = Bun.spawnSync([process.execPath, cli, ...args], {
					cwd: s.root,
					env,
				});
				expect(result.exitCode).toBe(0);
				return JSON.parse(result.stdout.toString());
			};
			expect(
				run("mcp", "install", "--harness", "claude", "--json").reports[0]
					.status,
			).toBe("stale");
			const fixed = run(
				"doctor",
				"--fix",
				"kabane/mcp-entry-stale-claude",
				"--json",
			);
			expect(fixed.fixes[0].result.ok).toBe(true);
			const registrations = McpClients.registrations("claude", {
				home: s.home,
				env,
				projectRoot: s.root,
			});
			if (!registrations.ok) throw registrations.error;
			expect(registrations.value.map(({ scope }) => scope)).toEqual([
				"user",
				"local",
			]);
			for (const registration of registrations.value)
				expect(registration.launch).toEqual(expected);
			expect(
				run("mcp", "install", "--harness", "claude", "--json").reports[0]
					.status,
			).toBe("present");
		},
		60_000,
	);

test("one malformed config leaves both earlier and later harness findings intact", async () => {
	const s = setup();
	s.claude({ kabane: s.entry("claude", "/gone/kabane") });
	write(join(s.home, ".codex/config.toml"), "[mcp_servers.kabane");
	s.gemini(s.entry("gemini", "/gone/kabane"));
	expect(await s.ids()).toEqual([
		"mcp-entry-stale-claude:mention",
		"mcp-config-unreadable-codex:mention",
		"mcp-entry-stale-gemini:mention",
	]);
});

test("CLAUDE_CONFIG_DIR selects user and local registrations without falling back to HOME", async () => {
	const s = setup();
	s.claude({ kabane: s.entry("claude") });
	const directory = join(s.home, "custom-claude");
	const path = join(directory, ".claude.json");
	const env = { CLAUDE_CONFIG_DIR: directory, KABANE_HARNESSES: "claude" };
	write(
		path,
		JSON.stringify({
			mcpServers: { kabane: s.entry("claude", "/gone/user") },
			projects: {
				[s.root]: { mcpServers: { kabane: s.entry("claude", "/gone/local") } },
			},
		}),
	);
	const found = await install(s.ctx, s.deps({ env }));
	if (!found.ok) throw found.error;
	expect(found.value).toHaveLength(1);
	expect(found.value[0]?.path).toBe(path);
	expect(found.value[0]?.summary).toContain("/gone/user");
	expect(found.value[0]?.summary).toContain("/gone/local");
	const registrations = McpClients.registrations("claude", {
		home: s.home,
		env,
		projectRoot: s.root,
	});
	if (!registrations.ok) throw registrations.error;
	expect(registrations.value.map(({ scope }) => scope)).toEqual([
		"user",
		"local",
	]);
	rmSync(path);
	expect(await s.ids({ env })).toEqual([]);
	s.claude({ kabane: s.entry("claude", "/gone/default") });
	expect(await s.ids({ env })).toEqual([]);
	expect(await s.ids({ env: { CLAUDE_CONFIG_DIR: "" } })).toEqual([
		"mcp-entry-stale-claude:mention",
	]);
});
