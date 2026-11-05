// The worktree lock with real processes contending for it at once, each a bun process of its own,
// released together by a barrier file so their attempts overlap.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worktree } from "./worktree";

let root = "";
let dir = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "loop-lock-"));
	dir = join(root, "worktree");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const CONTENDERS = 12;

// Each contender says it is ready, waits for the barrier, takes the lock once, and holds what
// it won until every contender has tried.
const contender = (): string => {
	const script = join(root, "contend.ts");
	writeFileSync(
		script,
		[
			`import { existsSync, writeFileSync } from "node:fs";`,
			`import { Worktree } from ${JSON.stringify(join(import.meta.dir, "worktree.ts"))};`,
			`const [dir, root, name] = process.argv.slice(2);`,
			`writeFileSync(root + "/ready-" + name, "");`,
			`while (!existsSync(root + "/go")) {}`,
			`const taken = Worktree.lock(dir, name);`,
			`console.log(taken.ok ? "won" : "lost");`,
			`if (taken.ok) { await Bun.sleep(1500); taken.value(); }`,
		].join("\n"),
	);
	return script;
};

const race = async (): Promise<string[]> => {
	const script = contender();
	const procs = Array.from({ length: CONTENDERS }, (_, i) =>
		Bun.spawn([process.execPath, script, dir, root, `p${i}`], {
			stdout: "pipe",
			stderr: "inherit",
		}),
	);
	const ready = () =>
		readdirSync(root).filter((f) => f.startsWith("ready-")).length;
	for (let i = 0; i < 1000 && ready() < CONTENDERS; i++) await Bun.sleep(10);
	writeFileSync(join(root, "go"), "");
	return Promise.all(
		procs.map(async (p) => (await new Response(p.stdout).text()).trim()),
	);
};

// A lock a process that is gone left behind.
const staleLock = (): void => {
	writeFileSync(
		`${dir}.lock`,
		JSON.stringify({
			pid: Bun.spawnSync(["true"]).pid,
			for: "a run that died",
			token: "dead",
		}),
	);
};

describe("Worktree.lock", () => {
	it("admits exactly one of many processes taking it at once", async () => {
		const said = await race();
		expect(said.filter((s) => s === "won")).toHaveLength(1);
		expect(said.filter((s) => s === "lost")).toHaveLength(CONTENDERS - 1);
	}, 30_000);

	it("admits exactly one of many processes taking over a lock a dead process left", async () => {
		staleLock();
		const said = await race();
		expect(said.filter((s) => s === "won")).toHaveLength(1);
	}, 30_000);

	it("releases only its own lock, never one that replaced it", () => {
		const taken = Worktree.lock(dir, "kabane loop land run-1");
		if (!taken.ok) throw taken.error;
		const theirs = JSON.stringify({
			pid: process.pid,
			for: "kabane loop land run-2",
			token: "theirs",
		});
		writeFileSync(`${dir}.lock`, theirs);

		taken.value();

		expect(existsSync(`${dir}.lock`)).toBe(true);
		expect(readFileSync(`${dir}.lock`, "utf8")).toBe(theirs);
		expect(Worktree.lockedBy(dir)).toBe("kabane loop land run-2");
	});
});
