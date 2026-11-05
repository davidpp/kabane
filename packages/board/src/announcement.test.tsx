/** @jsxImportSource @opentui/react */
// The host's announcement on the real board over a real tracker: asked for once the board is up,
// drawn over the footer, and gone after `esc` or a click.
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

it("the board asks its announcer once its first board frame is on screen, shows the line, and esc dismisses it", async () => {
	// What the terminal held when the board asked: the frame presented by then, not the tree
	// React had committed.
	const onScreenWhenAsked: string[] = [];
	let screen = (): string => "";
	const announcer: Announcer = {
		announce: async () => {
			onScreenWhenAsked.push(screen());
			return ok(LINE);
		},
	};
	// The first load waits on the scope, held here until the test can read the screen.
	let release = (): void => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const { renderOnce, captureCharFrame, mockInput, destroy } = await renderTest(
		<App
			cwd={BASE}
			basePath={BASE}
			activity={noActivity}
			announcer={announcer}
			resolveScope={async () => {
				await held;
				return null;
			}}
		/>,
		{ width: 80, height: 16 },
	);
	screen = captureCharFrame;
	release();
	const until = (p: (f: string) => boolean) =>
		pumpUntil(renderOnce, captureCharFrame, p);
	try {
		const shown = await until((f) => f.includes(LINE));
		expect(shown).toContain("Ship it");
		expect(shown).toContain(`${LINE} · esc dismiss`);
		mockInput.pressEscape();
		const dismissed = await until((f) => !f.includes(LINE));
		expect(dismissed).toContain("Ship it");
		expect(onScreenWhenAsked).toHaveLength(1);
		expect(onScreenWhenAsked[0]).toContain("Ship it");
	} finally {
		destroy();
	}
});

it("a click on the announcement dismisses it, as its esc hint says", async () => {
	const announcer: Announcer = { announce: async () => ok(LINE) };
	const { renderOnce, captureCharFrame, mockMouse, destroy } = await renderTest(
		<App
			cwd={BASE}
			basePath={BASE}
			activity={noActivity}
			announcer={announcer}
			resolveScope={async () => null}
		/>,
		{ width: 80, height: 16 },
	);
	const until = (p: (f: string) => boolean) =>
		pumpUntil(renderOnce, captureCharFrame, p);
	try {
		const shown = await until((f) => f.includes(LINE));
		const rows = shown.split("\n");
		const y = rows.findIndex((r) => r.includes(LINE));
		await mockMouse.click(rows[y]?.indexOf("kabane") ?? 0, y);
		const dismissed = await until((f) => !f.includes(LINE));
		expect(dismissed).toContain("Ship it");
	} finally {
		destroy();
	}
});
