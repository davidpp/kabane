import { afterEach, beforeEach, expect, test } from "bun:test";
import "@kabane/core/testing";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ok, Planner } from "@kabane/core";
import { GitFixture } from "@kabane/core/git-fixture";
import { Doctor, type Extension, Settings } from "@kabane/extension";
import { LoopDoctor } from "./doctor";
import { Lenses } from "./lenses";
import { testHost, pinTestScope, testScope } from "./test-host";

let folder = "";
let home = "";
let root = "";

beforeEach(async () => {
	folder = realpathSync(mkdtempSync(join(tmpdir(), "loop-doctor-")));
	home = join(folder, "home");
	root = join(folder, "project");
	mkdirSync(home);
	mkdirSync(root);
	GitFixture.run(root, ["init", "-q"]);
	pinTestScope(root);
	await Planner.init(home);
});

afterEach(() => rmSync(folder, { recursive: true, force: true }));

const write = (path: string, text: string) => {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
};

const PINNED = { model: "frontier", tiers: { claude: { frontier: "opus" } } };

/** The context doctor runs with: the project as cwd, `loop` in the global layer as given. */
const ctx = (loop: unknown = PINNED): Extension.Ctx => ({
	home,
	store: home,
	cwd: root,
	actor: "",
	harnessMode: "auto",
	device: "test",
	settings: Settings.port(async () =>
		ok([{ layer: "global", label: "config.json", value: loop }]),
	),
});

const findings = async (loop?: unknown) => {
	const found = await LoopDoctor.doctor(testHost(home), ctx(loop));
	if (!found.ok) throw found.error;
	return found.value;
};
const ids = async (loop?: unknown) =>
	(await findings(loop)).map(({ id, severity }) => `${id}:${severity}`);

const legacy = (name: string) =>
	join(root, ".kabane/loop/lenses", `${name}.md`);
const skillLens = (name: string) =>
	join(root, ".agents/skills/dispatch/references/lenses", `${name}.md`);
const skill = () =>
	write(join(root, ".agents/skills/dispatch/SKILL.md"), "# Dispatch\n");

const tagged = async (tags: string[], state: "next" | "done" = "next") => {
	const scope = testScope(root);
	if (!scope) throw new Error("the fixture project has no scope");
	const added = await Planner.addTask(home, {
		title: "work",
		kind: "issue",
		state,
		tags,
		scopeUri: scope.scopeUri,
	});
	if (!added.ok) throw added.error;
};

test("a fully mapped config and no legacy lenses: no findings", async () => {
	await tagged(["tier:frontier"]);
	expect(await ids()).toEqual([]);
});

test("legacy lenses with no dispatch skill are mentioned, with nothing to fix", async () => {
	write(legacy("security"), "Review security.\n");
	const [finding] = await findings();
	expect(finding).toMatchObject({
		id: "legacy-lens-dir",
		severity: "mention",
	});
	expect(finding?.fix).toBeUndefined();
});

test("with a dispatch skill, the fix moves legacy lenses into it and removes the directory", async () => {
	skill();
	write(legacy("security"), "Review security.\n");
	write(legacy("docs"), "Review docs.\n");
	expect(await ids()).toEqual(["legacy-lens-dir:auto"]);
	const report = await Doctor.run(
		[{ name: "loop", doctor: (ctx) => LoopDoctor.doctor(testHost(home), ctx) }],
		ctx(PINNED),
		{ fix: true },
	);
	expect(report.fixes[0]?.result.ok).toBe(true);
	expect(readFileSync(skillLens("security"), "utf8")).toBe(
		"Review security.\n",
	);
	expect(readFileSync(skillLens("docs"), "utf8")).toBe("Review docs.\n");
	expect(existsSync(join(root, ".kabane/loop/lenses"))).toBe(false);
	expect(await ids()).toEqual([]);
});

test("the fix refuses a lens the skill holds with other content, and moves the rest", async () => {
	skill();
	write(legacy("security"), "Old security.\n");
	write(legacy("docs"), "Review docs.\n");
	write(skillLens("security"), "New security.\n");
	const [finding] = await findings();
	const fixed = await finding?.fix?.();
	expect(fixed?.ok).toBe(false);
	if (fixed && !fixed.ok)
		expect(fixed.error.message).toContain("refused security.md");
	expect(readFileSync(legacy("security"), "utf8")).toBe("Old security.\n");
	expect(readFileSync(skillLens("security"), "utf8")).toBe("New security.\n");
	expect(readFileSync(skillLens("docs"), "utf8")).toBe("Review docs.\n");
	expect(
		(await findings()).find(({ id }) => id === "legacy-lens-dir")?.severity,
	).toBe("mention");
});

test("a lens in two lookup directories is reported with the one in force", async () => {
	skill();
	write(skillLens("security"), "New.\n");
	write(legacy("security"), "Old.\n");
	const shadowed = (await findings()).find(({ id }) => id === "lens-shadowed");
	expect(shadowed?.severity).toBe("mention");
	expect(shadowed?.summary).toBe(
		"lens security is read from .agents/skills/dispatch/references/lenses/security.md, which hides .kabane/loop/lenses/security.md",
	);
});

test("the .claude symlink to the skill shadows nothing", async () => {
	skill();
	write(skillLens("security"), "Review.\n");
	mkdirSync(join(root, ".claude/skills"), { recursive: true });
	symlinkSync(
		"../../.agents/skills/dispatch",
		join(root, ".claude/skills/dispatch"),
	);
	expect(await ids()).toEqual([]);
});

test("no loop.model: model-unpinned, routed to the human", async () => {
	const [finding] = await findings({});
	expect(finding).toMatchObject({ id: "model-unpinned", severity: "suggest" });
	expect(finding?.route).toContain("kabane_configSet in the global layer");
});

test("loop.model names a tier the implementer has no model for: tier-unmapped", async () => {
	const found = await findings({ model: "frontier" });
	expect(found.map(({ id }) => id)).toEqual(["tier-unmapped"]);
	expect(found[0]?.summary).toBe(
		"tier frontier names no model for claude (loop.tiers.claude.frontier); loop.model asks for it and gets claude's own default",
	);
});

test("open issues tagged with an unmapped tier are counted; closed ones and mapped ones are not", async () => {
	await tagged(["tier:fast"]);
	await tagged(["tier:fast"]);
	await tagged(["tier:fast"], "done");
	await tagged(["tier:frontier"]);
	await tagged(["tier:codex/frontier"]);
	const found = await findings();
	expect(found.map(({ id }) => id)).toEqual(["tier-unmapped"]);
	expect(found[0]?.summary).toBe(
		"tier fast names no model for claude (loop.tiers.claude.fast); 2 open issues tagged for it ask for it and get claude's own default; tier frontier names no model for codex (loop.tiers.codex.frontier); 1 open issue tagged for it asks for it and gets codex's own default",
	);
});

test("repair keeps a real Claude skill's active lens ahead of the legacy copy", async () => {
	skill();
	const claude = join(
		root,
		".claude/skills/dispatch/references/lenses/security.md",
	);
	write(claude, "Current security.\n");
	write(legacy("security"), "Old security.\n");
	const active = () =>
		Lenses.directories(root)
			.map((dir) => join(dir, "security.md"))
			.find(existsSync);
	expect(active()).toBe(claude);
	const report = await Doctor.run(
		[{ name: "loop", doctor: (ctx) => LoopDoctor.doctor(testHost(home), ctx) }],
		ctx(),
		{ fix: ["loop/legacy-lens-dir"] },
	);
	expect(report.fixes[0]?.result.ok).toBe(false);
	expect(active()).toBe(claude);
	expect(readFileSync(claude, "utf8")).toBe("Current security.\n");
	expect(existsSync(skillLens("security"))).toBe(false);
	expect(readFileSync(legacy("security"), "utf8")).toBe("Old security.\n");
});
