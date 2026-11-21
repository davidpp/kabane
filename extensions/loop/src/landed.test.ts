import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LoopConfig } from "./config";
import { Landed } from "./landed";
import { RunState } from "./state";
import { Steering } from "./steering";
import { RunStore } from "./store";
import { TestHarnesses } from "./test-harnesses";
import { testHost } from "./test-host";

let root = "";
let home = "";
let project = "";

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "loop-landed-"));
	home = join(root, "home");
	project = join(root, "project");
	mkdirSync(home);
	mkdirSync(project);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

const MERGED = "0123456789abcdef0123456789abcdef01234567";

// A run as the runner leaves it once it has completed and merged its branch, in `project`.
const ctxFor = (
	onLanded: string | undefined,
	over: Partial<RunStore.Run> = {},
): RunState.Ctx => {
	const config = LoopConfig.Schema.parse({ land: "merge", onLanded });
	const run: RunStore.Run = {
		version: 1,
		id: "run-1",
		parentId: "01PARENT",
		parentShortId: "JCAB-1",
		projectDir: project,
		worktree: join(root, "worktree"),
		worktreePrefix: "",
		branch: "jcab-1-make-the-thing",
		base: { branch: "main", sha: "f".repeat(40) },
		config,
		status: "completed",
		createdAt: new Date().toISOString(),
		claims: [],
		usage: {},
		continuationsUsed: 0,
		inboxRead: 0,
		steering: Steering.INITIAL,
		gateRuns: [],
		landing: {
			at: new Date().toISOString(),
			ok: true,
			summary: "Merged.",
			merged: MERGED,
		},
		...over,
	};
	const created = RunStore.create(home, run);
	if (!created.ok) throw created.error;
	const log = RunStore.eventLog(home, run.id);
	if (!log.ok) throw log.error;
	return RunState.make(
		{
			home,
			basePath: home,
			host: testHost(home),
			kabaneBin: () => "/nonexistent/kabane",
			pid: process.pid,
			overrides: TestHarnesses.overrides(),
		},
		run,
		log.value,
	);
};

const events = (): RunStore.Event[] => {
	const read = RunStore.readEvents(home, "run-1");
	if (!read.ok) throw read.error;
	return read.value;
};

const marker = (): string => join(project, "ran");

describe("Landed.hook", () => {
	it("runs the command in the project's checkout, told what landed, and puts its end on the trace", async () => {
		const ctx = ctxFor(
			`pwd > ran; env | grep '^KABANE_' | sort >> ran; echo "pushed $KABANE_BRANCH"`,
			{ pr: "https://github.com/acme/widget/pull/7" },
		);

		await Landed.hook(ctx, "merge");

		const said = readFileSync(marker(), "utf8").split("\n");
		expect(said[0]).toEndWith("/project");
		expect(said).toEqual(
			expect.arrayContaining([
				"KABANE_BASE=main",
				"KABANE_BRANCH=jcab-1-make-the-thing",
				"KABANE_LAND=merge",
				`KABANE_MERGED=${MERGED}`,
				"KABANE_PARENT=JCAB-1",
				"KABANE_PR=https://github.com/acme/widget/pull/7",
				"KABANE_RUN_ID=run-1",
				`KABANE_WORKTREE=${join(root, "worktree")}`,
			]),
		);
		const [event] = events();
		expect(event).toMatchObject({
			type: "on_landed",
			data: { exit: 0 },
		});
		expect(event?.summary).toStartWith("onLanded passed in ");
		expect(event?.summary).toEndWith("\npushed jcab-1-make-the-thing");
	});

	it("leaves out what the landing did not make", async () => {
		const ctx = ctxFor("env | grep '^KABANE_' | sort > ran", {
			landing: { at: new Date().toISOString(), ok: true, summary: "Open." },
		});

		await Landed.hook(ctx, "pr");

		const said = readFileSync(marker(), "utf8");
		expect(said).toContain("KABANE_LAND=pr");
		expect(said).not.toContain("KABANE_MERGED");
		expect(said).not.toContain("KABANE_PR");
	});

	it("keeps out what an outer hook's landing told the runner, when this landing does not say it", async () => {
		const ctx = ctxFor(
			`echo "merged=\${KABANE_MERGED-unset} pr=\${KABANE_PR-unset} land=$KABANE_LAND" > ran`,
			{
				pr: "https://github.com/acme/widget/pull/7",
				landing: { at: new Date().toISOString(), ok: true, summary: "Open." },
			},
		);
		// A runner a merge landing's onLanded started inherits that hook's variables.
		const outer = { ...process.env };
		process.env.KABANE_MERGED = "f".repeat(40);
		process.env.KABANE_LAND = "merge";
		try {
			await Landed.hook(ctx, "pr");
		} finally {
			for (const name of ["KABANE_MERGED", "KABANE_LAND"])
				if (outer[name] === undefined) delete process.env[name];
				else process.env[name] = outer[name];
		}

		expect(readFileSync(marker(), "utf8").trim()).toBe(
			"merged=unset pr=https://github.com/acme/widget/pull/7 land=pr",
		);
	});

	it("keeps out an outer pull request when this landing opened none", async () => {
		const ctx = ctxFor(
			`echo "pr=\${KABANE_PR-unset} land=$KABANE_LAND" > ran`,
			{
				landing: { at: new Date().toISOString(), ok: true, summary: "Merged." },
			},
		);
		const outer = process.env.KABANE_PR;
		process.env.KABANE_PR = "https://github.com/acme/widget/pull/3";
		try {
			await Landed.hook(ctx, "merge");
		} finally {
			if (outer === undefined) delete process.env.KABANE_PR;
			else process.env.KABANE_PR = outer;
		}

		expect(readFileSync(marker(), "utf8").trim()).toBe("pr=unset land=merge");
	});

	it("writes a failing command as a warning, with its output redacted, and leaves the run as it was", async () => {
		const ctx = ctxFor(
			"echo 'rejected by https://bot:ghp_FAKE0123456789abcdefABCD@github.com/acme/widget.git' >&2; exit 4",
		);
		const before = readFileSync(RunStore.paths(home, "run-1").run, "utf8");

		await Landed.hook(ctx, "merge");

		const [event] = events();
		expect(event).toMatchObject({ type: "warning", data: { exit: 4 } });
		expect(event?.summary).toStartWith("onLanded failed (exit 4) in ");
		expect(event?.summary).toContain("https://<redacted>@github.com");
		expect(event?.summary).not.toContain("ghp_FAKE");
		expect(readFileSync(RunStore.paths(home, "run-1").run, "utf8")).toBe(
			before,
		);
		expect(ctx.run).toMatchObject({
			status: "completed",
			landing: { ok: true },
		});
	});

	it("runs nothing after a landing that failed, for a run that is not completed, or with no command", async () => {
		const cases: [string | undefined, Partial<RunStore.Run>][] = [
			[
				"touch ran",
				{
					landing: {
						at: new Date().toISOString(),
						ok: false,
						summary: "Not landed.",
					},
				},
			],
			["touch ran", { status: "stopped" }],
			["touch ran", { landing: undefined }],
			[undefined, {}],
		];
		for (const [command, over] of cases) {
			rmSync(home, { recursive: true, force: true });
			mkdirSync(home);
			await Landed.hook(ctxFor(command, over), "merge");
			expect(existsSync(marker())).toBe(false);
			expect(events()).toEqual([]);
		}
	});
});
