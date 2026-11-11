import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Result } from "@cabane/core";
import type { Outcome } from "@cabane/extension";
import { type QuestionView, Questions } from "@cabane/questions";
import { run } from "../main";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

const device = async () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-questions-"));
	homes.push(home);
	const env = { KABANE_HOME: home, KABANE_HARNESSES: "" };
	const init = await run(
		["init", "--actor", "cabane://actor/human/test", "--device", "test"],
		env,
		home,
	);
	expect(init.exitCode).toBe(0);
	return { home, kabane: (argv: string[]) => run(argv, env, home) };
};
const page = (outcome: Outcome) =>
	outcome.json as {
		items: QuestionView[];
		hasMore: boolean;
		nextCursor?: string;
	};

it("kabane done withdraws the issue's open questions, and reopening leaves them withdrawn", async () => {
	const { home, kabane } = await device();
	const task = unwrap(
		await Planner.addTask(home, { title: "Ship it", kind: "issue" }),
	);
	unwrap(
		await Questions.ask(home, {
			id: task.id,
			questions: [{ question: "Before shipping?" }],
		}),
	);
	expect((await kabane(["done", task.shortId ?? task.id])).exitCode).toBe(0);
	expect((await kabane(["questions", task.shortId ?? task.id])).text).toBe(
		"No questions found.",
	);
	expect(
		(await kabane(["edit", task.shortId ?? task.id, "--state", "next"]))
			.exitCode,
	).toBe(0);
	const all = await kabane(["questions", task.shortId ?? task.id, "--all"]);
	expect(page(all).items.map((q) => [q.status, q.reasoning])).toEqual([
		["withdrawn", "issue closed"],
	]);
});
