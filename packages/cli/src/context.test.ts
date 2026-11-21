import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, Runtime } from "@kabane/core";
import { configureTestRuntime } from "@kabane/core/testing";
import { OUTCOME_KINDS } from "@kabane/outcome";
import { configureRuntime, MODULES } from "./context";

afterEach(() => configureTestRuntime());

it("Runtime.configure accepts the outcome module beside the first-party ones", () => {
	expect(
		configureRuntime(
			{
				actor: "test",
				deviceId: "test",
				sync: { enabled: false, batchBytes: 524288 },
			},
			"test",
		),
	).toEqual({ ok: true, value: undefined });
	expect(Runtime.modules()).toEqual(MODULES);
	expect(MODULES.map((module) => module.name)).toEqual([
		"questions",
		"handoff",
		"outcome",
		"checklist",
	]);
	for (const kind of Object.values(OUTCOME_KINDS))
		expect(Runtime.entryKind(kind)?.projection).toBe("discussion");
});

it("inlines bounded file heads through the CLI reader and preserves missing and pointer notes", async () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-file-reader-"));
	try {
		expect(
			configureRuntime(
				{
					actor: "test",
					deviceId: "test",
					sync: { enabled: false, batchBytes: 524288 },
				},
				"test",
			).ok,
		).toBe(true);
		expect((await Planner.init(home)).ok).toBe(true);
		const task = await Planner.addTask(home, { title: "File context" });
		if (!task.ok) throw task.error;
		const path = join(home, "note.txt");
		writeFileSync(path, "HEAD" + "x".repeat(100));
		for (const uri of [
			`file:${path}`,
			`file:${home}/missing`,
			"file:\u0000unreadable",
		]) {
			expect(
				(
					await Planner.addContextRef(home, {
						taskId: task.value.id,
						uri,
						kind: "doc",
					})
				).ok,
			).toBe(true);
		}
		const brief = await Planner.getContextPage(home, task.value.id, {
			sections: ["context"],
			perRefCap: 4,
		});
		if (!brief.ok) throw brief.error;
		expect(brief.value.markdown).toContain(
			"HEAD\n\n… [truncated: 104 bytes total, showing first 4]",
		);
		expect(brief.value.markdown).toContain("missing file:");
		expect(brief.value.markdown).toContain(
			"file unreadable/unavailable on this host; pointer only",
		);
		expect(brief.value.markdown).not.toContain("HEADx");
		expect(await Runtime.fileReader()(path, 104)).toEqual({
			status: "read",
			head: "HEAD" + "x".repeat(100),
			size: 104,
		});
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
