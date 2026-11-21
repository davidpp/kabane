// The two rules a tick runs on, when a job is due and what a fire does with the job's runs, and
// the job row over a real database.
import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	err,
	ok,
	Planner,
	type Result,
	tryCatch,
	trySync,
	withDb,
} from "@kabane/core";
import { configureTestRuntime } from "@kabane/core/testing";
import { createHostStore } from "@kabane/extension";
import { z } from "zod";
import { Jobs } from "./jobs";
import { Kabane } from "./result";
import { promptOf, requestPromptOf } from "./run-command";
import type { Runs } from "./runs";

Kabane.bind({ result: { ok, err, tryCatch, trySync } });

/** A local time on 2026-11-16, as the schedule reads it. */
const at = (hour: number, minute: number, second = 0) =>
	new Date(2026, 10, 16, hour, minute, second);

const job = (fields: Partial<Jobs.Job> = {}): Jobs.Job => ({
	taskId: "JOB1",
	schedule: "0 9 * * *",
	recipe: "wiki",
	inputs: {},
	session: "fresh",
	createdAt: at(8, 0).toISOString(),
	...fields,
});

const due = (j: Jobs.Job, now: Date) => {
	const result = Jobs.due(j, now);
	if (!result.ok) throw result.error;
	return result.value;
};

it("is due once its schedule's first time after its creation has passed", () => {
	expect(due(job(), at(8, 59))).toBe(false);
	expect(due(job(), at(9, 0))).toBe(true);
});

it("counts from the last fire, so fires missed since fold into one", () => {
	const fired = job({ lastFiredAt: at(9, 0, 5).toISOString() });
	expect(due(fired, at(23, 0))).toBe(false);
	// Three days late is one fire: the next tick after it counts from its own time.
	expect(due(fired, new Date(2026, 10, 19, 12, 0))).toBe(true);
	expect(
		due(
			job({ lastFiredAt: new Date(2026, 10, 19, 12, 0).toISOString() }),
			new Date(2026, 10, 19, 12, 1),
		),
	).toBe(false);
});

it("refuses a schedule that is not cron", () => {
	expect(Jobs.due(job({ schedule: "every day" }), at(9, 0)).ok).toBe(false);
});

const run = (id: string, state: Runs.State): Runs.Run => ({
	id,
	recipe: { name: "wiki", hash: "abc" },
	target: { kind: "job", id: "JOB1" },
	scope: "kabane://scope/jobs-test",
	dir: "",
	machine: "here",
	cwd: "/tmp",
	runtime: "hc",
	session: `wiki-${id}`,
	inputs: {},
	state,
	startedAt: at(9, 0).toISOString(),
});

const BUSY = ["live", "running", "waiting"] as const;

it.each(
	BUSY.flatMap((state) => Jobs.SESSIONS.map((session) => [session, state])),
)("a %s job skips while a run is %s", (session, state) => {
	const busy = run("B", state);
	expect(Jobs.decide(session, [run("A", "idle"), busy])).toEqual({
		kind: "skip",
		run: busy,
	});
});

it("a fresh job stops the idle runs and starts one, leaving ended runs alone", () => {
	const idle = run("A", "idle");
	expect(Jobs.decide("fresh", [idle, run("C", "ended")])).toEqual({
		kind: "start",
		stop: [idle],
	});
	expect(Jobs.decide("fresh", [])).toEqual({ kind: "start", stop: [] });
});

it("a kept job wakes its newest idle run and stops nothing", () => {
	const newest = run("B", "idle");
	expect(
		Jobs.decide("keep", [newest, run("A", "idle"), run("C", "ended")]),
	).toEqual({ kind: "wake", run: newest });
});

it("a kept job whose terminal ended, or that never ran, starts one", () => {
	expect(Jobs.decide("keep", [run("C", "ended")])).toEqual({
		kind: "start",
		stop: [],
	});
	expect(Jobs.decide("keep", [])).toEqual({ kind: "start", stop: [] });
});

const value = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

it("reads a row written before the session column as a fresh job", async () => {
	const home = mkdtempSync(join(tmpdir(), "jobs-jobs-"));
	try {
		const full = Jobs.module();
		// The module as it shipped with JCAB-523: its first migration only.
		configureTestRuntime({
			modules: [{ ...full, migrations: full.migrations?.slice(0, 1) }],
		});
		value(await Planner.init(home));
		const task = value(
			await Planner.addTask(home, { title: "Old job", kind: "job" }),
		);
		value(
			await withDb(home, (db) =>
				db.run(
					`INSERT INTO jobs_jobs (id, task_id, schedule, recipe, inputs, created_at, updated_at)
					 VALUES (?, ?, '0 9 * * *', 'wiki', '{}', ?, ?)`,
					[task.id, task.id, at(8, 0).toISOString(), at(8, 0).toISOString()],
				),
			),
		);
		configureTestRuntime({ modules: [full] });
		value(await Planner.init(home));
		const host = {
			store: createHostStore(
				() => home,
				() => ["jobs_jobs"],
				"jobs test",
			),
			z,
		};
		const [old] = value(await Jobs.all(host));
		expect(old).toMatchObject({ taskId: task.id, session: "fresh" });
	} finally {
		configureTestRuntime();
		rmSync(home, { recursive: true, force: true });
	}
});

it("tells the human when a run starts waiting and when it finishes, once per change", () => {
	expect(Jobs.attention(undefined, "live")).toBeUndefined();
	expect(Jobs.attention("live", "running")).toBeUndefined();
	expect(Jobs.attention("running", "waiting")).toBe("waiting");
	// The next tick sees it still waiting: nothing new.
	expect(Jobs.attention("waiting", "waiting")).toBeUndefined();
	expect(Jobs.attention("waiting", "running")).toBeUndefined();
	expect(Jobs.attention("running", "waiting")).toBe("waiting");
	expect(Jobs.attention("running", "idle")).toBe("finished");
	expect(Jobs.attention("waiting", "ended")).toBe("finished");
	// An idle terminal that then ends finished once.
	expect(Jobs.attention("idle", "ended")).toBeUndefined();
	expect(Jobs.attention("idle", "idle")).toBeUndefined();
	// A kept session woken from idle finishes again.
	expect(Jobs.attention("running", "idle")).toBe("finished");
	// A run first seen already there counts as entering it.
	expect(Jobs.attention(undefined, "waiting")).toBe("waiting");
	expect(Jobs.attention(undefined, "ended")).toBe("finished");
});

it("gives a job with no recipe the job preamble, then its request as written", () => {
	const prompt = requestPromptOf(
		"01RUN",
		{ kind: "job", id: "JOB1", shortId: "JREP-1", title: "Morning check" },
		"Check the {{inputs.x}} build and comment what broke.",
	);
	expect(prompt).toBe(
		[
			"[kabane run 01RUN, the job's request]",
			"You were started in the background. The human is not watching this terminal, but is notified when the run waits for them.",
			'This is a scheduled background run of job JREP-1 ("Morning check").',
			"Read the job with kabane_context on JREP-1: its description is the standing request, and its comments are what earlier runs reported.",
			"When a decision belongs to the human, ask it here in this session (the choices, your recommendation and why) and wait for the answer: the human is notified and answers in this terminal.",
			"When the decision is about a specific issue and can wait, file it with kabane_ask on that issue instead.",
			"Write your result as one comment on JREP-1 with kabane_comment.",
			"",
			// Not a template: a placeholder in a request stays as written.
			"Check the {{inputs.x}} build and comment what broke.",
		].join("\n"),
	);
});

it("gives a recipe's run the preamble, then its skill by name, the target and each input given", () => {
	const recipe = { name: "research", skill: "preliminary-research" };
	const target = {
		kind: "issue",
		id: "ISSUE1",
		shortId: "JCAB-7",
		title: "A title",
	} as const;
	expect(promptOf("01RUN", recipe, { depth: "quick", rounds: 3 }, target)).toBe(
		[
			'[kabane run 01RUN, recipe "research"]',
			"You were started in the background. Nobody is watching this terminal.",
			"When a decision belongs to the human, file it with kabane_ask on JCAB-7 (the choices, your recommendation and why), then stop.",
			"Write your result as a comment on JCAB-7 with kabane_comment.",
			"",
			"Use the preliminary-research skill.",
			'Target: JCAB-7 ("A title")',
			"depth: quick",
			"rounds: 3",
		].join("\n"),
	);
	// No target and no input with a value: the sentence alone.
	expect(promptOf("01RUN", recipe, {}).split("\n\n")[1]).toBe(
		"Use the preliminary-research skill.",
	);
});

it("gives a recipe with its own prompt the preamble, then its body with the target and inputs filled in", () => {
	const recipe = {
		name: "wiki",
		body: "Maintain {{target.shortId}} ({{target.title}}), starting with {{inputs.focus}}.",
	};
	const target = {
		kind: "job",
		id: "JOB1",
		shortId: "JSEC-1",
		title: "Wiki",
	} as const;
	expect(
		promptOf("01RUN", recipe, { focus: "overviews" }, target).split("\n\n")[1],
	).toBe("Maintain JSEC-1 (Wiki), starting with overviews.");
});

it("stores a job with no recipe and reads it back with none", async () => {
	const home = mkdtempSync(join(tmpdir(), "jobs-jobs-"));
	try {
		configureTestRuntime({ modules: [Jobs.module()] });
		value(await Planner.init(home));
		const task = value(
			await Planner.addTask(home, { title: "Request job", kind: "job" }),
		);
		const host = {
			store: createHostStore(
				() => home,
				() => ["jobs_jobs"],
				"jobs test",
			),
			z,
		};
		const { recipe: _none, ...bare } = job({ taskId: task.id });
		value(await Jobs.insert(host, bare, "test"));
		const [stored] = value(await Jobs.all(host));
		expect(stored).toEqual(bare);
		expect(stored && "recipe" in stored).toBe(false);
	} finally {
		configureTestRuntime();
		rmSync(home, { recursive: true, force: true });
	}
});

it("an edit moves only the fields it names, and clears the job's harness on null", () => {
	const own = job({ harness: ["codex"], inputs: { focus: "a" } });
	expect(Jobs.edit(own, {})).toEqual(own);
	expect(Jobs.edit(own, { schedule: "*/5 * * * *" })).toEqual({
		...own,
		schedule: "*/5 * * * *",
	});
	expect(Jobs.edit(own, { inputs: { focus: "b" }, session: "keep" })).toEqual({
		...own,
		inputs: { focus: "b" },
		session: "keep",
	});
	expect(Jobs.edit(own, { harness: ["claude", "-p"] }).harness).toEqual([
		"claude",
		"-p",
	]);
	const cleared = Jobs.edit(own, { harness: null });
	expect("harness" in cleared).toBe(false);
});

it("updates a job's row in place and reads the edit back", async () => {
	const home = mkdtempSync(join(tmpdir(), "jobs-jobs-"));
	try {
		configureTestRuntime({ modules: [Jobs.module()] });
		value(await Planner.init(home));
		const task = value(
			await Planner.addTask(home, { title: "Edited job", kind: "job" }),
		);
		const host = {
			store: createHostStore(
				() => home,
				() => ["jobs_jobs"],
				"jobs test",
			),
			z,
		};
		const before = job({ taskId: task.id, harness: ["codex"] });
		value(await Jobs.insert(host, before, "test"));
		const edited = Jobs.edit(before, {
			schedule: "*/5 * * * *",
			harness: null,
			session: "keep",
		});
		value(await Jobs.update(host, edited, "test"));
		expect(value(await Jobs.all(host))).toEqual([edited]);
	} finally {
		configureTestRuntime();
		rmSync(home, { recursive: true, force: true });
	}
});
