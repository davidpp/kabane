import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Result } from "@kabane/core";
import { Questions } from "@kabane/questions";
import { run } from "../main";

const value = <T>(r: Result<T>): T => {
	if (!r.ok) throw r.error;
	return r.value;
};
let home: string;
const cli = (args: string[]) =>
	run(args, { KABANE_HOME: home, KABANE_HARNESSES: "" }, home);
const check = (...args: string[]) => cli(["wait", ...args, "--timeout", "0s"]);
beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "kabane-wait-"));
	expect(
		(
			await cli([
				"init",
				"--actor",
				"kabane://actor/human/test",
				"--device",
				"test",
			])
		).exitCode,
	).toBe(0);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

it.each(["blocks", "blocked_by", "follows"] as const)(
	"waits on the blocker end of %s",
	async (type) => {
		const task = value(await Planner.addTask(home, { title: "work" }));
		const blocker = value(await Planner.addTask(home, { title: "blocker" }));
		expect((await check("ready", task.id)).exitCode).toBe(0);
		const [sourceId, targetId] =
			type === "blocks" ? [blocker.id, task.id] : [task.id, blocker.id];
		value(await Planner.addLink(home, { type, sourceId, targetId }));
		expect((await check("ready", task.id)).exitCode).toBe(1);
		expect((await check("ready", blocker.id)).exitCode).toBe(0);
		for (const state of ["done", "cancelled"] as const) {
			value(await Planner.updateTask(home, blocker.id, { state }));
			expect((await check("ready", task.id)).json).toEqual({
				condition: "ready",
				taskId: task.id,
			});
		}
	},
);

it("matches any requested state and distinguishes invalid input from timeout", async () => {
	const task = value(
		await Planner.addTask(home, { title: "work", state: "waiting" }),
	);
	expect((await check("state", task.id, "done", "waiting")).json).toEqual({
		condition: "state",
		taskId: task.id,
		state: "waiting",
	});
	expect((await check("state", task.id, "done")).exitCode).toBe(1);
	expect((await check("state", task.id, "unknown")).exitCode).toBe(2);
	expect(
		(await cli(["wait", "ready", task.id, "--timeout", "1day"])).exitCode,
	).toBe(2);
	expect((await check("answered", "id:missing")).exitCode).toBe(2);
});

it("waits on open questions and reports answers and withdrawals", async () => {
	const task = value(
		await Planner.addTask(home, { title: "decision", kind: "issue" }),
	);
	const asked = value(
		await Questions.ask(home, {
			id: task.id,
			questions: [{ question: "Which?" }, { question: "When?" }],
		}),
	);
	for (const question of asked) {
		expect((await check("answered", question.handle)).exitCode).toBe(1);
		const withdraw = question.ordinal === 2;
		value(
			await Questions.answer(
				home,
				withdraw
					? { question: question.handle, withdraw, reasoning: "superseded" }
					: { question: question.handle, answer: "This one" },
			),
		);
		expect((await check("answered", `id:${question.id}`)).json).toEqual({
			condition: "answered",
			questionId: question.id,
			taskId: task.id,
			status: withdraw ? "withdrawn" : "answered",
		});
	}
});
