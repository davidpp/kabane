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

it("shows registered decisions through the real CLI entry and consumes multiple context pages", async () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-show-"));
	homes.push(home);
	const env = { KABANE_HOME: home, KABANE_HARNESSES: "" };
	expect(
		(
			await run(
				["init", "--actor", "cabane://actor/human/test", "--device", "test"],
				env,
				home,
			)
		).exitCode,
	).toBe(0);
	const task = unwrap(
		await Planner.addTask(home, {
			title: "Show decisions",
			kind: "issue",
			description: "Keep ordinary detail",
		}),
	);
	const plain = await run(["show", task.id], env, home);
	expect(plain.exitCode).toBe(0);
	expect(plain.text).not.toContain("## Decisions");
	expect(plain.json).toMatchObject({ sections: {} });
	unwrap(
		await Questions.ask(home, {
			id: task.id,
			questions: [
				{
					question: "Which store?",
					choices: ["SQLite", "Remote"],
					recommended: "SQLite",
					why: "Offline first",
				},
				{ question: "Withdraw this" },
				...Array.from({ length: 8 }, (_, i) => ({
					question: `Long decision ${i}: ${"Details ".repeat(600)}`,
				})),
			],
		}),
	);
	unwrap(
		await Questions.answer(home, {
			question: `${task.shortId}:1`,
			answer: "SQLite",
			reasoning: "Local",
		}),
	);
	unwrap(
		await Questions.answer(home, {
			question: `${task.shortId}:2`,
			withdraw: true,
			reasoning: "Obsolete",
		}),
	);
	const shown = await run(["show", task.id], env, home);
	expect(shown.exitCode).toBe(0);
	expect(shown.text).toContain("Keep ordinary detail");
	expect(shown.text).toContain(
		"Which store? (choices only) → SQLite (cabane://actor/human/test, Local)",
	);
	expect(shown.text).not.toContain("Withdraw this");
	expect(shown.text).toContain("Long decision 7:");
	expect(shown.text.match(/## Decisions/g)).toHaveLength(1);
	const sections = (shown.json as { sections: Record<string, string> })
		.sections;
	expect(Object.keys(sections)).toEqual(["questions.decisions"]);
	expect(shown.text).toContain(sections["questions.decisions"] ?? "missing");
});
