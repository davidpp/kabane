/** @jsxImportSource @opentui/react */
// The host's announcement on the real board over a real tracker: asked for once the board is up,
// drawn over the footer, and gone after `esc`.
import { afterAll, beforeAll, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, Planner } from "@cabane/core";
import { App } from "./app";
import { type Announcer, noActivity } from "./ports";
import { dropDb, freshDb } from "./test-db";
import { pumpUntil, renderTest } from "./testing";

const BASE = join(tmpdir(), `cabane-board-announce-${crypto.randomUUID()}`);
const LINE = "kabane 9.9.9 is out · run kabane update";

beforeAll(async () => {
	await freshDb(BASE);
	const task = await Planner.addTask(BASE, { title: "Ship it", kind: "issue" });
	if (!task.ok) throw task.error;
});

afterAll(() => dropDb(BASE));

it("the board asks its announcer once it is up, shows the line, and esc dismisses it", async () => {
	let asked = 0;
	const announcer: Announcer = {
		announce: async () => {
			asked++;
			return ok(LINE);
		},
	};
	const { renderOnce, captureCharFrame, mockInput, destroy } = await renderTest(
		<App
			cwd={BASE}
			basePath={BASE}
			activity={noActivity}
			announcer={announcer}
		/>,
		{ width: 80, height: 16 },
	);
	const until = (p: (f: string) => boolean) =>
		pumpUntil(renderOnce, captureCharFrame, p);
	try {
		const shown = await until((f) => f.includes(LINE));
		expect(shown).toContain("Ship it");
		expect(shown).toContain(`${LINE} · esc dismiss`);
		mockInput.pressEscape();
		const dismissed = await until((f) => !f.includes(LINE));
		expect(dismissed).toContain("Ship it");
		expect(asked).toBe(1);
	} finally {
		destroy();
	}
});
