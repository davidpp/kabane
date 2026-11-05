import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Result } from "@cabane/core";
import { Questions } from "@cabane/questions";
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

it("answers through the module, refuses an unknown choice, and hands the issue back on the last answer", async () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-answer-"));
	homes.push(home);
	const env = { KABANE_HOME: home, KABANE_HARNESSES: "" };
	const kabane = (argv: string[]) => run(argv, env, home);
	expect(
		(
			await kabane([
				"init",
				"--actor",
				"cabane://actor/human/test",
				"--device",
				"test",
			])
		).exitCode,
	).toBe(0);
	const task = unwrap(
		await Planner.addTask(home, { title: "Decide", kind: "issue" }),
	);
	const id = task.shortId ?? task.id;
	unwrap(
		await Questions.ask(home, {
			id: task.id,
			questions: [
				{ question: "Which store?", choices: ["SQLite", "Remote"] },
				{ question: "Drop this?" },
			],
		}),
	);

	const refused = await kabane(["answer", `${id}:1`, "Postgres"]);
	expect(refused.exitCode).toBe(1);
	expect(refused.text).toBe(
		'Error: Unknown choice "Postgres"; choose SQLite, Remote.',
	);

	const first = await kabane([
		"answer",
		`${id}:1`,
		"sqlite",
		"--why",
		"Offline first",
		"--as",
		"cabane://actor/human/other",
	]);
	expect(first.exitCode).toBe(0);
	expect(first.text).toBe(
		`${id}:1 Which store? (choices only)\n→ SQLite (cabane://actor/human/other): Offline first`,
	);
	expect(first.text).not.toContain("moved to next");

	expect((await kabane(["answer", `${id}:2`, "--withdraw"])).exitCode).toBe(2);
	expect(
		(await kabane(["answer", `${id}:2`, "--withdraw", "Obsolete"])).exitCode,
	).toBe(2);
	expect((await kabane(["answer", `${id}:2`])).exitCode).toBe(2);
	const withdrawn = await kabane([
		"answer",
		`${id}:2`,
		"--withdraw",
		"--why",
		"Obsolete",
	]);
	expect(withdrawn.exitCode).toBe(0);
	expect(withdrawn.text).toBe(
		`${id}:2 Drop this?\nWithdrawn: Obsolete\n\n${id} moved to next`,
	);
	expect(withdrawn.json).toMatchObject({
		moved: true,
		question: { status: "withdrawn" },
	});
	expect(unwrap(await Planner.getTask(home, task.id))?.state).toBe("next");
});
