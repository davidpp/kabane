/** @jsxImportSource @opentui/react */
// The setup screen against scripted host deps: the intro cards it opens on, the form, the keys that
// edit it, and the hand-off — save with the plan, install the checked harnesses, show each outcome,
// then the board. Frames are checked at 120 columns and at the 40-column pane PRODUCT.md targets.
import { describe, expect, it } from "bun:test";
import { err, ok, type Result } from "@cabane/core";
import {
	AGENTS_NOTE,
	AGENTS_OFF,
	AGENTS_OFF_NOTE,
	elidePath,
	enterLines,
	INTRO_CARDS,
	NAME_NOTE,
	NO_AGENTS,
	NO_AGENTS_NOTE,
	SetupScreen,
} from "./setup";
import type { SetupPlan } from "./setup-plan";
import { pumpUntil, renderTest } from "./testing";

const DEFAULTS: SetupPlan.Defaults = {
	name: "david",
	device: "mbp",
	harnesses: [
		{ id: "claude", label: "Claude Code" },
		{ id: "codex", label: "Codex" },
	],
	installOff: false,
	configPath: "~/.cabane/config.json",
};

const FORM_TITLE = "cabane · setup";
// Where `bun run sandbox` puts the config: outside HOME, so no `~` shortens it.
const SANDBOX_PATH =
	"/var/folders/0b/x7k2m9q1r3s5t8v0w2y4z6a8b0c2d4/T/cabane-sandbox/cabane/.cabane/config.json";

type Seen = {
	saved: SetupPlan.Plan[];
	installed: (readonly string[])[];
	completed: number;
	quit: number;
};

type MountOptions = { saveResult?: Result<string>; width?: number };

const mount = async (
	defaults: SetupPlan.Defaults,
	{ saveResult = ok("~/.cabane/config.json"), width = 120 }: MountOptions = {},
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
		{ width, height: 24 },
	);
	const until = (predicate: (frame: string) => boolean) =>
		pumpUntil(setup.renderOnce, setup.captureCharFrame, predicate);
	// Esc on the first card skips the intro, which is what every form test wants.
	const toForm = async (): Promise<string> => {
		await until((f) => f.includes("cabane · 1/3"));
		setup.mockInput.pressEscape();
		return until((f) => f.includes(FORM_TITLE));
	};
	return { ...setup, seen, until, toForm };
};

// A fixed string reads whole only if one row carries all of it: a wrap anywhere, mid-word or not,
// splits it across two rows.
const rows = (frame: string): string[] => frame.split("\n");
const onOneRow = (frame: string, text: string): boolean =>
	rows(frame).some((row) => row.includes(text));
const expectWhole = (frame: string, texts: readonly string[]): void => {
	for (const text of texts)
		expect({ text, whole: onOneRow(frame, text) }).toEqual({
			text,
			whole: true,
		});
};

describe("SetupScreen intro", () => {
	it("enter walks the three cards, then opens the form", async () => {
		const { mockInput, until, destroy } = await mount(DEFAULTS);
		try {
			for (const [index, card] of INTRO_CARDS.entries()) {
				const frame = await until((f) => f.includes(`cabane · ${index + 1}/3`));
				for (const line of card) expect(frame).toContain(line);
				expect(frame).toContain("enter next · esc skip");
				mockInput.pressEnter();
			}
			await until((f) => f.includes(FORM_TITLE));
		} finally {
			destroy();
		}
	});

	it("esc on a card skips straight to the form without quitting", async () => {
		const { mockInput, until, seen, destroy } = await mount(DEFAULTS);
		try {
			await until((f) => f.includes("cabane · 1/3"));
			mockInput.pressEnter();
			await until((f) => f.includes("cabane · 2/3"));
			mockInput.pressEscape();
			await until((f) => f.includes(FORM_TITLE));
			expect(seen.quit).toBe(0);
		} finally {
			destroy();
		}
	});
});

describe("SetupScreen at 120 and 40 columns", () => {
	for (const width of [120, 40]) {
		it(`${width} columns: every card line reads whole`, async () => {
			const { mockInput, until, destroy } = await mount(DEFAULTS, { width });
			try {
				for (const [index, card] of INTRO_CARDS.entries()) {
					const frame = await until((f) =>
						f.includes(`cabane · ${index + 1}/3`),
					);
					expectWhole(frame, card);
					mockInput.pressEnter();
				}
			} finally {
				destroy();
			}
		});

		it(`${width} columns: several agents found, every label and note reads whole`, async () => {
			const { toForm, destroy } = await mount(DEFAULTS, { width });
			try {
				const frame = await toForm();
				expectWhole(frame, [
					"› name   david",
					NAME_NOTE,
					"  agents [x] Claude Code",
					"         [x] Codex",
					AGENTS_NOTE,
					...enterLines(DEFAULTS.configPath, 2),
					"space toggle · enter confirm · esc quit",
				]);
				expect(frame).toContain("enter saves ~/.cabane/config.json");
			} finally {
				destroy();
			}
		});

		it(`${width} columns: none installed says so and where to add one later`, async () => {
			const { toForm, destroy } = await mount(
				{ ...DEFAULTS, harnesses: [] },
				{ width },
			);
			try {
				const frame = await toForm();
				expectWhole(frame, [
					`  agents ${NO_AGENTS}`,
					NO_AGENTS_NOTE,
					...enterLines(DEFAULTS.configPath, 0),
					"enter confirm · esc quit",
				]);
				expect(frame).not.toContain(AGENTS_OFF);
				expect(frame).not.toContain("space toggle");
				expect(frame).not.toContain("adds cabane");
			} finally {
				destroy();
			}
		});

		it(`${width} columns: install turned off says so, not that none are installed`, async () => {
			const { toForm, destroy } = await mount(
				{
					...DEFAULTS,
					harnesses: [],
					installOff: true,
					configPath: SANDBOX_PATH,
				},
				{ width },
			);
			try {
				const frame = await toForm();
				expectWhole(frame, [
					`  agents ${AGENTS_OFF}`,
					AGENTS_OFF_NOTE,
					"opens the board",
				]);
				expect(frame).not.toContain(NO_AGENTS);
				const saveRow = rows(frame).find((row) => row.includes("enter saves"));
				expect(saveRow?.trimEnd().endsWith("/.cabane/config.json")).toBe(true);
				expect(saveRow?.trimEnd().length).toBeLessThanOrEqual(width);
			} finally {
				destroy();
			}
		});

		it(`${width} columns: each outcome and its note read whole`, async () => {
			const { mockInput, toForm, until, destroy } = await mount(DEFAULTS, {
				width,
			});
			try {
				await toForm();
				mockInput.pressEnter();
				const frame = await until((f) => f.includes("✓ saved"));
				expectWhole(frame, [
					"✓ saved ~/.cabane/config.json",
					"Claude Code    ✓ installed",
					"Codex          ✗ failed",
					"codex: not logged in",
					"enter open the board · q quit",
				]);
			} finally {
				destroy();
			}
		});
	}
});

describe("elidePath", () => {
	it("keeps a path that fits, and cuts one that does not at a segment", () => {
		expect(elidePath("~/.cabane/config.json", 28)).toBe(
			"~/.cabane/config.json",
		);
		expect(elidePath(SANDBOX_PATH, 28)).toBe("…/cabane/.cabane/config.json");
		expect(elidePath(SANDBOX_PATH, 12)).toBe("…/config.json");
	});
});

describe("SetupScreen form", () => {
	it("opens on the defaults: every harness checked, no device, no actor URI, no pin", async () => {
		const { toForm, destroy } = await mount(DEFAULTS);
		try {
			const frame = await toForm();
			expect(frame).not.toContain("device");
			expect(frame).not.toContain("cabane://");
			expect(frame).toContain("[x] Claude Code");
			expect(frame).toContain("[x] Codex");
			expect(frame).not.toContain("pin");
		} finally {
			destroy();
		}
	});

	it("intro, form, enter: saves, installs the checked harnesses, shows each outcome, and enter opens the board", async () => {
		const { mockInput, until, seen, destroy } = await mount(DEFAULTS);
		try {
			for (let card = 1; card <= INTRO_CARDS.length; card++) {
				await until((f) => f.includes(`cabane · ${card}/3`));
				mockInput.pressEnter();
			}
			await until((f) => f.includes("[x] Codex"));
			mockInput.pressEnter();
			const frame = await until((f) => f.includes("✓ saved"));
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
		const { mockInput, toForm, until, seen, destroy } = await mount(DEFAULTS);
		try {
			await toForm();
			mockInput.pressTab();
			mockInput.pressKey(" ");
			mockInput.pressArrow("down");
			mockInput.pressKey(" ");
			await until(
				(f) =>
					f.includes("[ ] Claude Code") &&
					f.includes("[ ] Codex") &&
					!f.includes("adds cabane"),
			);
			mockInput.pressEnter();
			await until(() => seen.completed === 1);
			expect(seen.saved[0]?.install).toEqual([]);
			expect(seen.installed).toEqual([]);
		} finally {
			destroy();
		}
	});

	it("unchecking an agent drops it from what enter will do", async () => {
		const { mockInput, toForm, until, destroy } = await mount(DEFAULTS);
		try {
			await toForm();
			mockInput.pressTab();
			mockInput.pressKey(" ");
			await until((f) =>
				rows(f).some((row) => row.trimEnd().endsWith("adds cabane to 1 agent")),
			);
		} finally {
			destroy();
		}
	});

	it("typing into the name changes the actor it will write", async () => {
		const { mockInput, toForm, until, seen, destroy } = await mount(DEFAULTS);
		try {
			await toForm();
			for (let i = 0; i < "david".length; i++) mockInput.pressBackspace();
			await mockInput.typeText("Ada Lovelace");
			await until((f) => f.includes("Ada Lovelace"));
			mockInput.pressEnter();
			await until(() => seen.saved.length === 1);
			expect(seen.saved[0]?.actor).toBe("cabane://actor/human/ada-lovelace");
		} finally {
			destroy();
		}
	});

	it("esc on the form quits without saving", async () => {
		const { mockInput, toForm, until, seen, destroy } = await mount(DEFAULTS);
		try {
			await toForm();
			mockInput.pressEscape();
			await until(() => seen.quit === 1);
			expect(seen.saved).toEqual([]);
			expect(seen.completed).toBe(0);
		} finally {
			destroy();
		}
	});

	it("a failed save stays on the form with the error, and esc quits", async () => {
		const { mockInput, toForm, until, seen, destroy } = await mount(DEFAULTS, {
			saveResult: err(new Error("disk full")),
		});
		try {
			await toForm();
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
