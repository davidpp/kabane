/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import type { TriggerDescriptor } from "./ports";
import { pumpUntil, renderTest } from "./testing";
import { TriggerForm } from "./trigger-form";
import { TriggerFormView } from "./trigger-form-view";

const START: TriggerDescriptor = {
	id: "start",
	label: "start loop",
	satisfiable: true,
	inputs: {
		implementer: {
			type: "string",
			required: false,
			default: "claude",
			options: ["claude", "codex"],
			label: "implementer",
			group: "Agents",
		},
		concurrency: {
			type: "number",
			required: false,
			default: 2,
			label: "concurrent sessions",
			group: "Limits",
		},
	},
	preview: [
		[{ text: "Plan", bold: true }],
		[
			{ text: " ○ ", tone: "muted" },
			{ text: "JREP-4  Serve config reads through the cache   " },
			{ text: "← JREP-2,JREP-3,JREP-5,JREP-6", tone: "muted" },
		],
	],
};

const changed = {
	...TriggerForm.open(START),
	field: 1,
	values: { implementer: "claude", concurrency: 3 },
};

const frameAt = async (width: number, height: number): Promise<string> => {
	const { renderOnce, captureCharFrame, destroy } = await renderTest(
		<TriggerFormView shortId="JREP-1" form={changed} />,
		{ width, height },
	);
	try {
		return await pumpUntil(renderOnce, captureCharFrame, (f) =>
			f.includes("start loop JREP-1"),
		);
	} finally {
		destroy();
	}
};

test("the preview beside the grouped settings, a changed value marked, the blockers whole", async () => {
	const frame = await frameAt(110, 20);
	expect(frame).toContain("start loop JREP-1  · 1 changed from the defaults");
	expect(frame).toContain("Agents");
	expect(frame).toContain("Limits");
	expect(frame).toMatch(/› concurrent sessions\s+‹ 3 ›\s+•/);
	expect(frame).toMatch(/ {2}implementer\s+claude/);
	// The preview and the settings share rows: side by side.
	expect(frame).toMatch(/Plan\s+Agents/);
	expect(frame.replace(/\s+/g, "")).toContain("←JREP-2,JREP-3,JREP-5,JREP-6");
	expect(frame).toContain("enter start · h/l change · j/k field · esc back");
});

test("at forty columns the settings stack under the preview, and nothing is cut", async () => {
	const frame = await frameAt(40, 30);
	const lines = frame.split("\n");
	const plan = lines.findIndex((l) => l.includes("Plan"));
	const agents = lines.findIndex((l) => l.includes("Agents"));
	expect(plan).toBeGreaterThanOrEqual(0);
	expect(agents).toBeGreaterThan(plan);
	expect(frame).not.toContain("…");
	expect(frame.replace(/\s+/g, "")).toContain("←JREP-2,JREP-3,JREP-5,JREP-6");
	expect(frame).toMatch(/‹ 3 ›/);
});

test("a group listed twice is titled twice, and an ungrouped input after a group is not under it", async () => {
	const input = (group?: string) => ({
		type: "number",
		required: false,
		default: 1,
		...(group ? { group } : {}),
	});
	const form = TriggerForm.open({
		id: "start",
		label: "start loop",
		satisfiable: true,
		inputs: {
			first: input("Agents"),
			second: input("Limits"),
			third: input("Agents"),
			loose: input(),
		},
	});
	const errors: unknown[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => errors.push(args);
	try {
		const { renderOnce, captureCharFrame, destroy } = await renderTest(
			<TriggerFormView shortId="JREP-1" form={form} />,
			{ width: 110, height: 24 },
		);
		try {
			const frame = await pumpUntil(renderOnce, captureCharFrame, (f) =>
				f.includes("loose"),
			);
			const lines = frame.split("\n").map((l) => l.trim());
			expect(lines.filter((l) => l === "Agents")).toHaveLength(2);
			const loose = lines.findIndex((l) => l.startsWith("loose"));
			expect(lines[loose - 1]).toBe("");
			expect(lines[loose - 2]).toMatch(/^third/);
		} finally {
			destroy();
		}
	} finally {
		console.error = original;
	}
	expect(String(errors)).not.toContain("same key");
});
