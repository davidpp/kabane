/** @jsxImportSource @opentui/react */
// The setup screen against scripted host deps: the form it opens on, the keys that edit it, and the
// hand-off — save with the plan, install the checked harnesses, show each outcome, then the board.
import { describe, expect, it } from "bun:test";
import { err, ok, type Result } from "@cabane/core";
import { NO_HARNESS_HINT, SetupScreen, SYNC_HINT } from "./setup";
import type { SetupPlan } from "./setup-plan";
import { pumpUntil, renderTest } from "./testing";

const DEFAULTS: SetupPlan.Defaults = {
	name: "david",
	device: "mbp",
	harnesses: [
		{ id: "claude", label: "Claude Code" },
		{ id: "codex", label: "Codex" },
	],
};

type Seen = {
	saved: SetupPlan.Plan[];
	installed: (readonly string[])[];
	completed: number;
	quit: number;
};

const mount = async (
	defaults: SetupPlan.Defaults,
	saveResult: Result<string> = ok("/tmp/home/config.json"),
) => {
	const seen: Seen = { saved: [], installed: [], completed: 0, quit: 0 };
	const setup = await renderTest(
		<SetupScreen
			defaults={defaults}
			save={async (plan) => {
				seen.saved.push(plan);
				return saveResult;
			}}
			install={async (ids) => {
				seen.installed.push(ids);
				return ids.map((id) =>
					id === "codex"
						? { id, status: "failed" as const, message: "codex: not logged in" }
						: { id, status: "installed" as const },
				);
			}}
			onComplete={() => {
				seen.completed++;
			}}
			onQuit={() => {
				seen.quit++;
			}}
		/>,
		{ width: 100, height: 24 },
	);
	const until = (predicate: (frame: string) => boolean) =>
		pumpUntil(setup.renderOnce, setup.captureCharFrame, predicate);
	return { ...setup, seen, until };
};

describe("SetupScreen", () => {
	it("opens on the defaults: the actor it will write, every harness checked", async () => {
		const { until, destroy } = await mount(DEFAULTS);
		try {
			const frame = await until((f) => f.includes("cabane · setup"));
			expect(frame).toContain("cabane://actor/human/david");
			expect(frame).toContain("[x] Claude Code");
			expect(frame).toContain("[x] Codex");
			expect(frame).toContain(SYNC_HINT);
		} finally {
			destroy();
		}
	});

	it("with nothing detected, says where the snippets are", async () => {
		const { until, destroy } = await mount({
			...DEFAULTS,
			harnesses: [],
		});
		try {
			const frame = await until((f) => f.includes("cabane · setup"));
			expect(frame).toContain(NO_HARNESS_HINT);
		} finally {
			destroy();
		}
	});

	it("enter saves, installs the checked harnesses, shows each outcome, and enter opens the board", async () => {
		const { mockInput, until, seen, destroy } = await mount(DEFAULTS);
		try {
			await until((f) => f.includes("[x] Codex"));
			mockInput.pressEnter();
			const frame = await until((f) => f.includes("✓ wrote"));
			expect(frame).toContain("✓ wrote /tmp/home/config.json");
			expect(frame).toContain("Claude Code    ✓ installed");
			expect(frame).toContain("Codex          ✗ failed codex: not logged in");
			expect(seen.saved).toEqual([
				{
					actor: "cabane://actor/human/david",
					deviceId: "mbp",
					install: ["claude", "codex"],
				},
			]);
			expect(seen.installed).toEqual([["claude", "codex"]]);
			expect(seen.completed).toBe(0);
			mockInput.pressEnter();
			await until(() => seen.completed === 1);
		} finally {
			destroy();
		}
	});

	it("space unchecks a harness; with nothing to install it goes straight on", async () => {
		const { mockInput, until, seen, destroy } = await mount(DEFAULTS);
		try {
			await until((f) => f.includes("[x] Codex"));
			mockInput.pressTab();
			mockInput.pressTab();
			mockInput.pressKey(" ");
			mockInput.pressArrow("down");
			mockInput.pressKey(" ");
			await until(
				(f) => f.includes("[ ] Claude Code") && f.includes("[ ] Codex"),
			);
			mockInput.pressEnter();
			await until(() => seen.completed === 1);
			expect(seen.saved[0]?.install).toEqual([]);
			expect(seen.installed).toEqual([]);
		} finally {
			destroy();
		}
	});

	it("typing into the name changes the actor it will write", async () => {
		const { mockInput, until, seen, destroy } = await mount(DEFAULTS);
		try {
			await until((f) => f.includes("cabane://actor/human/david"));
			for (let i = 0; i < "david".length; i++) mockInput.pressBackspace();
			await mockInput.typeText("Ada Lovelace");
			await until((f) => f.includes("cabane://actor/human/ada-lovelace"));
			mockInput.pressEnter();
			await until(() => seen.saved.length === 1);
			expect(seen.saved[0]?.actor).toBe("cabane://actor/human/ada-lovelace");
		} finally {
			destroy();
		}
	});

	it("a failed save stays on the form with the error, and esc quits", async () => {
		const { mockInput, until, seen, destroy } = await mount(
			DEFAULTS,
			err(new Error("disk full")),
		);
		try {
			await until((f) => f.includes("[x] Codex"));
			mockInput.pressEnter();
			await until((f) => f.includes("disk full"));
			expect(seen.installed).toEqual([]);
			mockInput.pressEscape();
			await until(() => seen.quit === 1);
			expect(seen.completed).toBe(0);
		} finally {
			destroy();
		}
	});
});
