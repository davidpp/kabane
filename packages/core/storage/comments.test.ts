import "../testing";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import type { Result } from "../result";
import { Planner } from "./index";

const TEST_BASE = join(import.meta.dir, ".test-data-entries");

const must = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};

const sleep = (ms: number): Promise<void> =>
	new Promise((r) => setTimeout(r, ms));

const entry = (taskId: string, kind: string, content: string) =>
	Planner.addEntry(TEST_BASE, {
		taskId,
		kind,
		author: "cabane://actor/agent/claude",
		authorType: "ai",
		content,
	});

describe("Planner — timeline entries", () => {
	let taskId: string;

	beforeEach(async () => {
		rmSync(TEST_BASE, { recursive: true, force: true });
		mkdirSync(TEST_BASE, { recursive: true });
		must(await Planner.init(TEST_BASE));
		taskId = must(
			await Planner.addTask(TEST_BASE, { title: "Timeline", kind: "issue" }),
		).id;
	});

	afterEach(() => {
		rmSync(TEST_BASE, { recursive: true, force: true });
	});

	it("round-trips an entry with its kind and its body verbatim", async () => {
		const body = "## Verdict\n\n- not a field kabane reads\n```json\n{}\n```";
		const added = must(await entry(taskId, "handoff.summary", body));
		expect(added.kind).toBe("handoff.summary");

		const read = must(await Planner.getEntries(TEST_BASE, taskId));
		expect(read).toEqual([added]);
		expect(must(await Planner.getComment(TEST_BASE, added.id))).toEqual(added);
	});

	it("lists every kind in time order, or one kind when asked", async () => {
		const first = must(await entry(taskId, "review", "first"));
		await sleep(5);
		const comment = must(
			await Planner.addComment(TEST_BASE, {
				taskId,
				author: "me",
				authorType: "human",
				content: "plain",
			}),
		);
		await sleep(5);
		const second = must(await entry(taskId, "review", "second"));

		expect(
			must(await Planner.getEntries(TEST_BASE, taskId)).map((e) => e.id),
		).toEqual([first.id, comment.id, second.id]);
		expect(
			must(await Planner.getEntries(TEST_BASE, taskId, { kind: "review" })).map(
				(e) => e.content,
			),
		).toEqual(["first", "second"]);
	});

	it("finds the newest entry of a kind, and null for a kind with none", async () => {
		must(await entry(taskId, "review", "older"));
		await sleep(5);
		must(await entry(taskId, "review", "newer"));
		await sleep(5);
		must(await entry(taskId, "finding", "other kind"));

		const latest = must(await Planner.latestEntry(TEST_BASE, taskId, "review"));
		expect(latest?.content).toBe("newer");
		expect(
			must(await Planner.latestEntry(TEST_BASE, taskId, "handoff")),
		).toBeNull();
	});

	it("refuses a kind of the wrong shape in one line and writes nothing", async () => {
		for (const kind of ["Review", "", "a.b.c", "1st", "has space", ".x"]) {
			const refused = await entry(taskId, kind, "body");
			expect(refused.ok).toBe(false);
			if (!refused.ok) {
				expect(refused.error.message).toContain(`"${kind}"`);
				expect(refused.error.message).not.toContain("\n");
			}
		}
		expect(must(await Planner.getEntries(TEST_BASE, taskId))).toEqual([]);
	});

	it("keeps comments as entries of kind comment, and the comment reads to that kind", async () => {
		const comment = must(
			await Planner.addComment(TEST_BASE, {
				taskId,
				author: "me",
				authorType: "human",
				content: "a comment",
			}),
		);
		must(await entry(taskId, "review", "not a comment"));

		expect(must(await Planner.getEntries(TEST_BASE, taskId))[0]?.kind).toBe(
			"comment",
		);
		expect(
			must(await Planner.getComments(TEST_BASE, taskId)).map((c) => c.id),
		).toEqual([comment.id]);
	});
});
