import { afterEach, expect, it } from "bun:test";
import { Runtime } from "@cabane/core";
import { configureTestRuntime } from "@cabane/core/testing";
import { OUTCOME_KINDS } from "@cabane/outcome";
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
