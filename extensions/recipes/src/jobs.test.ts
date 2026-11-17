// The two rules a tick runs on: when a job is due, and what a fire does with the job's runs.
import { expect, it } from "bun:test";
import { err, ok, tryCatch, trySync } from "@cabane/core";
import { Jobs } from "./jobs";
import { Kabane } from "./result";
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

it.each(["live", "running", "waiting"] as const)(
	"skips while a run is %s",
	(state) => {
		const busy = run("B", state);
		expect(Jobs.decide([run("A", "idle"), busy])).toEqual({
			kind: "skip",
			run: busy,
		});
	},
);

it("stops the idle runs and starts one, leaving ended runs alone", () => {
	const idle = run("A", "idle");
	expect(Jobs.decide([idle, run("C", "ended")])).toEqual({
		kind: "start",
		stop: [idle],
	});
	expect(Jobs.decide([])).toEqual({ kind: "start", stop: [] });
});
