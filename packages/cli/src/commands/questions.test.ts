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

it("lists questions as the MCP tool prints them, by scope or issue, and pages text and --json with one cursor", async () => {
	const { home, kabane } = await device();
	const issue = (title: string, scopeUri: string) =>
		Planner.addTask(home, { title, kind: "issue", scopeUri }).then(unwrap);
	const store = await issue("Pick a store", "github:acme/app");
	const other = await issue("Elsewhere", "github:acme/other");
	const [which, name] = unwrap(
		await Questions.ask(home, {
			id: store.id,
			questions: [
				{ question: "Which store?", choices: ["SQLite", "Remote"] },
				{ question: "Name it" },
			],
		}),
	);
	unwrap(
		await Questions.ask(home, {
			id: other.id,
			questions: [{ question: "Elsewhere?" }],
		}),
	);
	unwrap(
		await Questions.answer(home, {
			question: `${store.shortId}:2`,
			answer: "kabane",
		}),
	);

	const scoped = await kabane(["questions", "--scope", "github:acme/app"]);
	expect(scoped.exitCode).toBe(0);
	expect(scoped.text).toBe(
		`## ${store.shortId} Pick a store · normal · waiting\n\n${store.shortId}:1 Which store? (choices only) id:${which?.id}\n- SQLite\n- Remote`,
	);
	expect(page(scoped).items.map((q) => q.handle)).toEqual([
		`${store.shortId}:1`,
	]);

	const all = await kabane(["questions", store.shortId ?? store.id, "--all"]);
	expect(all.text).toContain(
		`${store.shortId}:2 Name it id:${name?.id}\n→ kabane`,
	);
	expect(all.text).not.toContain("Elsewhere");

	// Two pages, both outputs from one cursor: nothing repeated, nothing skipped.
	const first = await kabane(["questions", "--all", "--limit", "2"]);
	const cursor = page(first).nextCursor ?? "";
	expect(page(first).hasMore).toBe(true);
	expect(first.text.endsWith(`\n\nnextCursor: ${cursor}`)).toBe(true);
	const second = await kabane([
		"questions",
		"--all",
		"--limit",
		"2",
		"--cursor",
		cursor,
	]);
	expect(second.text).toContain("Elsewhere?");
	expect(page(second)).toMatchObject({ hasMore: false });
	expect(page(second).nextCursor).toBeUndefined();
	expect(
		[...page(first).items, ...page(second).items].map((q) => q.handle),
	).toEqual([`${store.shortId}:1`, `${store.shortId}:2`, `${other.shortId}:1`]);

	const mismatched = await kabane([
		"questions",
		"--limit",
		"2",
		"--cursor",
		cursor,
	]);
	expect(mismatched.exitCode).toBe(1);
	expect(mismatched.json).toEqual({
		error:
			"Mismatched questions cursor: repeat the same issue, scope and status, or restart without cursor.",
	});

	const none = await kabane(["questions", "--scope", "github:acme/none"]);
	expect(none.text).toBe("No questions found.");
	expect(none.json).toEqual({ items: [], hasMore: false });
	expect((await kabane(["questions", "--limit", "0"])).exitCode).toBe(2);
});
