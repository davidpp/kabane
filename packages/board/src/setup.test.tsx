/** @jsxImportSource @opentui/react */
// The setup screen against scripted host deps: the intro cards it opens on, the form, the keys that
// edit it, and the hand-off — save with the plan, install the checked harnesses, show each outcome,
// then the board. Frames are checked at 100 columns and at the 40-column pane PRODUCT.md targets.
import { describe, expect, it } from "bun:test";
import { err, ok, type Result } from "@cabane/core";
import {
	HARNESS_HEADING,
	HARNESS_HINT,
	INTRO_CARDS,
	NO_HARNESS_HEADING,
	NO_HARNESS_HINT,
	SetupScreen,
	SYNC_HINT,
	writesLine,
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

type Seen = {
	saved: SetupPlan.Plan[];
	installed: (readonly string[])[];
	completed: number;
	quit: number;
};

type MountOptions = { saveResult?: Result<string>; width?: number };

const mount = async (
	defaults: SetupPlan.Defaults,
	{ saveResult = ok("~/.cabane/config.json"), width = 100 }: MountOptions = {},
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
						: {
								id,
								status: "installed" as const,
								message: `as cabane://actor/agent/${id}`,
							},
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

describe("SetupScreen at 100 and 40 columns", () => {
	for (const width of [100, 40]) {
		it(`${width} columns: every card line reads whole`, async () => {
			const { mockInput, until, destroy } = await mount(DEFAULTS, { width });
			try {
				for (const [index, card] of INTRO_CARDS.entries()) {
					const frame = await until((f) =>
						f.includes(`cabane · ${index + 1}/3`),
					);
					for (const line of card) expect(onOneRow(frame, line)).toBe(true);
					mockInput.pressEnter();
				}
			} finally {
				destroy();
			}
		});

		it(`${width} columns: the form keeps its labels and every hint whole`, async () => {
			const { toForm, destroy } = await mount(DEFAULTS, { width });
			try {
				const frame = await toForm();
				expect(frame).toContain("› name   david");
				expect(frame).not.toContain("device");
				for (const text of [
					"cabane://actor/human/david",
					HARNESS_HEADING,
					HARNESS_HINT,
					"[x] Claude Code",
					writesLine(DEFAULTS.configPath),
					SYNC_HINT,
					"space toggle · enter confirm · esc quit",
				])
					expect(onOneRow(frame, text)).toBe(true);
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
				const frame = await until((f) => f.includes("✓ wrote"));
				for (const text of [
					"✓ wrote ~/.cabane/config.json",
					"Claude Code    ✓ installed",
					"as cabane://actor/agent/claude",
					"Codex          ✗ failed",
					"codex: not logged in",
					"enter open the board · q quit",
				])
					expect(onOneRow(frame, text)).toBe(true);
			} finally {
				destroy();
			}
		});
	}

	it("the actor URI sits beside the name at 100 columns and under it at 40", async () => {
		const nameRowOf = (frame: string): number =>
			rows(frame).findIndex((row) => row.includes("› name"));
		const wide = await mount(DEFAULTS, { width: 100 });
		try {
			const frame = await wide.toForm();
			expect(rows(frame)[nameRowOf(frame)]).toContain(
				"cabane://actor/human/david",
			);
		} finally {
			wide.destroy();
		}
		const narrow = await mount(DEFAULTS, { width: 40 });
		try {
			const frame = await narrow.toForm();
			expect(rows(frame)[nameRowOf(frame)]).not.toContain("cabane://");
			expect(rows(frame)[nameRowOf(frame) + 1]?.trim()).toBe(
				"cabane://actor/human/david",
			);
		} finally {
			narrow.destroy();
		}
	});
});

describe("SetupScreen form", () => {
	it("opens on the defaults: the actor it will write, every harness checked, no pin", async () => {
		const { toForm, destroy } = await mount(DEFAULTS);
		try {
			const frame = await toForm();
			expect(frame).toContain("cabane://actor/human/david");
			expect(frame).toContain("[x] Claude Code");
			expect(frame).toContain("[x] Codex");
			expect(frame).not.toContain("pin");
		} finally {
			destroy();
		}
	});

	it("with nothing detected, says where the snippets are and drops the space hint", async () => {
		const { toForm, destroy } = await mount({ ...DEFAULTS, harnesses: [] });
		try {
			const frame = await toForm();
			expect(frame).toContain(NO_HARNESS_HEADING);
			expect(frame).toContain(NO_HARNESS_HINT);
			expect(frame).not.toContain(HARNESS_HEADING);
			expect(frame).toContain("enter confirm · esc quit");
			expect(frame).not.toContain("space toggle");
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
			const frame = await until((f) => f.includes("✓ wrote"));
			expect(frame).toContain(
				"Claude Code    ✓ installed as cabane://actor/agent/claude",
			);
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
		const { mockInput, toForm, until, seen, destroy } = await mount(DEFAULTS);
		try {
			await toForm();
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
