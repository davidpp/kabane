/** @jsxImportSource @opentui/react */
// The setup screen against scripted host deps: the welcome card it opens on, the form, the keys
// that edit it, and the hand-off — save with the plan, install the checked harnesses, file the first
// issue, show each outcome and the next step, then the board. Frames are checked at 120 columns and
// at the 40-column pane PRODUCT.md targets.
import { describe, expect, it } from "bun:test";
import { err, ok, type Result } from "@cabane/core";
import {
	AGENTS_NOTE,
	AGENTS_OFF,
	AGENTS_OFF_NOTE,
	elidePath,
	enterLines,
	NAME_NOTE,
	NO_AGENTS,
	NO_AGENTS_NOTE,
	nextLines,
	SetupScreen,
	WELCOME,
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
	project: "repo",
};

const WELCOME_LEAD = WELCOME[0]?.[0] ?? "";
const WELCOME_LINES = WELCOME.flat();
const FIRST_ISSUE: SetupPlan.FirstIssue = {
	shortId: "REPO-1",
	title: "Add cabane to CLAUDE.md",
};

const FORM_TITLE = "cabane · setup";
// Where `bun run sandbox` puts the config: outside HOME, so no `~` shortens it.
const SANDBOX_PATH =
	"/var/folders/0b/x7k2m9q1r3s5t8v0w2y4z6a8b0c2d4/T/cabane-sandbox/cabane/.cabane/config.json";

type Seen = {
	saved: SetupPlan.Plan[];
	installed: (readonly string[])[];
	filed: string[];
	completed: number;
	quit: number;
};

type MountOptions = {
	saveResult?: Result<string>;
	fileResult?: Result<SetupPlan.FirstIssue>;
	width?: number;
};

const mount = async (
	defaults: SetupPlan.Defaults,
	{
		saveResult = ok("~/.cabane/config.json"),
		fileResult = ok(FIRST_ISSUE),
		width = 120,
	}: MountOptions = {},
) => {
	const seen: Seen = {
		saved: [],
		installed: [],
		filed: [],
		completed: 0,
		quit: 0,
	};
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
			fileFirstIssue={async (harness) => {
				seen.filed.push(harness);
				return fileResult;
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
	// Enter on the welcome card opens the form, which is where every form test starts.
	const toForm = async (): Promise<string> => {
		await until((f) => f.includes(WELCOME_LEAD));
		setup.mockInput.pressEnter();
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

describe("SetupScreen welcome", () => {
	it("one card says what cabane is, and enter opens the form", async () => {
		const { mockInput, until, destroy } = await mount(DEFAULTS);
		try {
			const frame = await until((f) => f.includes(WELCOME_LEAD));
			for (const line of WELCOME_LINES) expect(frame).toContain(line);
			expect(frame).toContain("enter set up · esc quit");
			expect(frame).not.toContain(FORM_TITLE);
			mockInput.pressEnter();
			await until((f) => f.includes(FORM_TITLE));
		} finally {
			destroy();
		}
	});

	it("esc on the card quits without writing anything", async () => {
		const { mockInput, until, seen, destroy } = await mount(DEFAULTS);
		try {
			await until((f) => f.includes(WELCOME_LEAD));
			mockInput.pressEscape();
			await until(() => seen.quit === 1);
			expect(seen.saved).toEqual([]);
		} finally {
			destroy();
		}
	});
});

describe("SetupScreen at 120 and 40 columns", () => {
	for (const width of [120, 40]) {
		it(`${width} columns: every welcome line reads whole`, async () => {
			const { until, destroy } = await mount(DEFAULTS, { width });
			try {
				const frame = await until((f) => f.includes(WELCOME_LEAD));
				expectWhole(frame, WELCOME_LINES);
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
					...enterLines(DEFAULTS.configPath, 2, "claude"),
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
				const frame = await until((f) => f.includes("✓ filed"));
				expectWhole(frame, [
					"✓ saved ~/.cabane/config.json",
					"Claude Code    ✓ installed",
					"Codex          ✗ failed",
					"codex: not logged in",
					"✓ filed REPO-1 for claude",
					FIRST_ISSUE.title,
					...nextLines("claude", "REPO-1"),
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

	it("welcome, form, enter: saves, installs, files the first issue, shows each outcome, and enter opens the board", async () => {
		const { mockInput, toForm, until, seen, destroy } = await mount(DEFAULTS);
		try {
			await toForm();
			mockInput.pressEnter();
			const frame = await until((f) => f.includes("✓ filed"));
			expect(frame).toContain("Claude Code    ✓ installed");
			expect(frame).toContain("Codex          ✗ failed codex: not logged in");
			expect(frame).toContain("✓ filed REPO-1 for claude");
			expect(frame).toContain('say "take the next cabane issue" and');
			expect(seen.filed).toEqual(["claude"]);
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

	it("a long install error wraps under its row, indented, at 40 columns", async () => {
		const reason =
			'Caused by: CODEX_HOME points to "/tmp/x/.codex", but that path does not exist';
		const setup = await renderTest(
			<SetupScreen
				defaults={DEFAULTS}
				save={async () => ok("~/.cabane/config.json")}
				install={async (ids) =>
					ids.map((id) => ({ id, status: "failed" as const, message: reason }))
				}
				fileFirstIssue={async () => ok(FIRST_ISSUE)}
				onComplete={() => {}}
				onQuit={() => {}}
			/>,
			{ width: 40, height: 24 },
		);
		try {
			const until = (predicate: (frame: string) => boolean) =>
				pumpUntil(setup.renderOnce, setup.captureCharFrame, predicate);
			await until((f) => f.includes(WELCOME_LEAD));
			setup.mockInput.pressEnter();
			await until((f) => f.includes(FORM_TITLE));
			setup.mockInput.pressEnter();
			const frame = await until((f) => f.includes("✓ saved"));
			const first = rows(frame).findIndex((row) => row.includes("Caused by"));
			expect(rows(frame)[first]?.startsWith("  Caused by")).toBe(true);
			expect(rows(frame)[first + 1]?.startsWith("  ")).toBe(true);
		} finally {
			setup.destroy();
		}
	});

	it("outside a project, enter says nothing about an issue and files none", async () => {
		const { mockInput, toForm, until, seen, destroy } = await mount({
			...DEFAULTS,
			project: undefined,
		});
		try {
			const form = await toForm();
			expect(form).not.toContain("files one issue");
			mockInput.pressEnter();
			const frame = await until((f) => f.includes("✓ saved"));
			expect(frame).not.toContain("filed");
			expect(frame).not.toContain("next:");
			expect(seen.filed).toEqual([]);
		} finally {
			destroy();
		}
	});

	it("an issue that could not be filed says why, and enter still opens the board", async () => {
		const { mockInput, toForm, until, seen, destroy } = await mount(DEFAULTS, {
			fileResult: err(new Error("database is locked")),
		});
		try {
			await toForm();
			mockInput.pressEnter();
			const frame = await until((f) => f.includes("first issue not filed"));
			expect(frame).toContain("database is locked");
			expect(frame).not.toContain("next:");
			mockInput.pressEnter();
			await until(() => seen.completed === 1);
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
