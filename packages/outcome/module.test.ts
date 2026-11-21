import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Result, Runtime } from "@kabane/core";
import { configureTestRuntime } from "@kabane/core/testing";
import { outcomeModule, OUTCOME_KINDS } from "./module";

const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
let base: string;
beforeEach(async () => {
	base = mkdtempSync(join(tmpdir(), "outcome-module-"));
	configureTestRuntime({ modules: [outcomeModule] });
	unwrap(await Planner.init(base));
});
afterEach(() => {
	configureTestRuntime();
	rmSync(base, { recursive: true, force: true });
});

it("registers the four outcome kinds with discussion projections", () => {
	expect(Runtime.modules()).toEqual([outcomeModule]);
	for (const kind of Object.values(OUTCOME_KINDS)) {
		const declared = Runtime.entryKind(kind);
		expect(declared?.projection).toBe("discussion");
		expect(declared?.template).toBeTruthy();
	}
	expect(outcomeModule.kinds?.map((kind) => kind.title)).toEqual([
		"Decision",
		"Finding",
		"Verification",
		"Session summary",
	]);
});

it("writes every outcome to SQLite and keeps each in the brief's Discussion", async () => {
	const task = unwrap(
		await Planner.addTask(base, {
			title: "Check the outcome record",
			kind: "issue",
		}),
	);
	const contents: Record<
		(typeof OUTCOME_KINDS)[keyof typeof OUTCOME_KINDS],
		string
	> = {
		"outcome.decision": "Which adapter? → SQLite, chosen by the maintainer.",
		"outcome.finding":
			"P2: the read path discarded a failed result in the adapter.",
		"outcome.verification":
			"Read and wrote an entry through SQLite; its body survived.",
		"outcome.summary":
			"Recorded the outcomes; migration of old sessions remains.",
	};
	for (const kind of Object.values(OUTCOME_KINDS)) {
		unwrap(
			await Planner.addEntry(base, {
				taskId: task.id,
				kind,
				author: "kabane://actor/agent/test",
				authorType: "ai",
				content: contents[kind],
			}),
		);
	}
	const entries = unwrap(await Planner.getEntries(base, task.id));
	expect(entries.map((entry) => entry.kind).sort()).toEqual(
		Object.values(OUTCOME_KINDS).sort(),
	);
	const brief = unwrap(await Planner.assembleContext(base, task.id));
	const start = brief.indexOf("## Discussion\n\n");
	expect(start).toBeGreaterThan(-1);
	const discussion = brief.slice(start);
	for (const kind of Object.values(OUTCOME_KINDS))
		expect(discussion).toContain(`(${kind}, ai, `);
	for (const content of Object.values(contents))
		expect(discussion).toContain(content);
});
