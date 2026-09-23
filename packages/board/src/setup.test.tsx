/** @jsxImportSource @opentui/react */
// The setup screen against scripted host deps: the welcome card it opens on, the form, the keys
// that edit it, and the hand-off — save with the plan, install the checked harnesses, file the first
// issue, show each outcome and the next step, then the board. Frames are checked at 120 columns and
// at the 40-column pane PRODUCT.md targets.
import { describe, expect, it } from "bun:test";
import { err, ok, type Result } from "@cabane/core";
import { type CapturedSpan, RGBA, TextAttributes } from "@opentui/core";
import {
	AGENTS_NOTE,
	AGENTS_OFF,
	AGENTS_OFF_NOTE,
	elidePath,
	enterLines,
	NAME_NOTE,
	NEXT_PHRASE,
	NO_AGENTS,
	NO_AGENTS_NOTE,
	nextLines,
	SetupScreen,
	WELCOME,
	WORDMARK,
	WORDMARK_WIDTH,
	wordmarkFits,
	wordmarkRuns,
} from "./setup";
import type { SetupPlan } from "./setup-plan";
import { pumpUntil, renderTest } from "./testing";
import { Theme, ThemeProvider } from "./theme";

const DEFAULTS: SetupPlan.Defaults = {
	name: "david",
	device: "mbp",
	harnesses: [
		{ id: "claude", label: "Claude Code" },
		{ id: "codex", label: "Codex" },
	],
	installOff: false,
	configPath: "~/.kabane/config.json",
	project: "repo",
};

const WELCOME_LEAD = WELCOME[0]?.[0] ?? "";
const WELCOME_LINES = WELCOME.flat();
const FIRST_ISSUE: SetupPlan.FirstIssue = {
	shortId: "REPO-1",
	title: "Add kabane to CLAUDE.md",
};

const FORM_TITLE = "kabane · setup";
// Where `bun run sandbox` puts the config: outside HOME, so no `~` shortens it.
const SANDBOX_PATH =
	"/var/folders/0b/x7k2m9q1r3s5t8v0w2y4z6a8b0c2d4/T/cabane-sandbox/cabane/.kabane/config.json";

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
	// Without one the screen gets the dark ramp, as a provider-less mount always has.
	theme?: Theme.Tokens;
};

const mount = async (
	defaults: SetupPlan.Defaults,
	{
		saveResult = ok("~/.kabane/config.json"),
		fileResult = ok(FIRST_ISSUE),
		width = 120,
		theme = Theme.DARK,
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
		<ThemeProvider value={theme}>
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
							? {
									id,
									status: "failed" as const,
									message: "codex: not logged in",
								}
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
			/>
		</ThemeProvider>,
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
	it("one card says what kabane is, and enter opens the form", async () => {
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
				// The consequences start in the form's value column, so the key sits in the label column.
				expect(frame).toContain("  enter  saves ~/.kabane/config.json");
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
				expect(frame).not.toContain("adds kabane");
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
				const saveRow = rows(frame).find((row) => row.includes("enter  saves"));
				expect(saveRow?.trimEnd().endsWith("/.kabane/config.json")).toBe(true);
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
					"✓ saved ~/.kabane/config.json",
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
		expect(elidePath("~/.kabane/config.json", 28)).toBe(
			"~/.kabane/config.json",
		);
		expect(elidePath(SANDBOX_PATH, 28)).toBe("…/cabane/.kabane/config.json");
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
			expect(frame).toContain('say "take the next kabane issue" and');
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
					!f.includes("adds kabane"),
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
				rows(f).some((row) => row.trimEnd().endsWith("adds kabane to 1 agent")),
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
				save={async () => ok("~/.kabane/config.json")}
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
			// Under its row, indented past the row's own start, and its wrap holds that indent. The
			// outcomes sit in a padded panel, so the row starts one cell in and the note three.
			const first = rows(frame).findIndex((row) => row.includes("Caused by"));
			const indent = rows(frame)[first]?.indexOf("Caused by") ?? -1;
			const head = rows(frame)[first - 1] ?? "";
			expect(indent).toBeGreaterThan(head.search(/\S/));
			expect(rows(frame)[first + 1]?.slice(0, indent).trim()).toBe("");
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

// The colours a span was painted with, as `[r, g, b]`, to hold them against the theme's tokens.
const rgb = (hex: string): number[] => RGBA.fromHex(hex).toInts().slice(0, 3);
const ints = (color: RGBA): number[] => color.toInts().slice(0, 3);
const spanWith = (
	spans: readonly CapturedSpan[],
	text: string,
): CapturedSpan | undefined => spans.find((span) => span.text.includes(text));

describe("the wordmark", () => {
	it("is four rows of one width, drawn only in narrow block glyphs and its three marks", () => {
		for (const row of WORDMARK) {
			expect(row.length).toBe(WORDMARK_WIDTH);
			expect(/^[ █▀▄_^~]*$/.test(row)).toBe(true);
		}
		expect(WORDMARK).toHaveLength(4);
		expect(WORDMARK_WIDTH).toBe(29);
	});

	it("turns its marks into the glyphs they draw, in runs of like cells", () => {
		const runs = wordmarkRuns("█__█ ▀~~▀");
		expect(runs).toEqual([
			{ text: "█", cell: "ink" },
			{ text: "  ", cell: "counter" },
			{ text: "█ ▀", cell: "ink" },
			{ text: "▀▀", cell: "floor" },
			{ text: "▀", cell: "ink" },
		]);
		expect(
			wordmarkRuns(WORDMARK[2] ?? "")
				.map((r) => r.text)
				.join(""),
		).toBe("█▀▄  █▀▀█ █  █ █▀▀█ █  █ █▀▀▀");
	});

	it("fits a forty-column pane inside its panel, and gives way to the bold word below 31", () => {
		expect(wordmarkFits(40)).toBe(true);
		expect(wordmarkFits(31)).toBe(true);
		expect(wordmarkFits(30)).toBe(false);
	});
});

describe("SetupScreen surfaces", () => {
	it("the welcome is one raised panel under a wordmark, its estimate muted", async () => {
		const { until, captureSpans, destroy } = await mount(DEFAULTS, {
			width: 40,
		});
		try {
			const frame = await until((f) => f.includes(WELCOME_LEAD));
			expect(frame).toContain("█ ▄▀ ▀▀▀█ █▀▀█ ▀▀▀█ █▀▀▄ █▀▀█");
			// The wordmark is the title: no `kabane` header line above it.
			expect(rows(frame).some((row) => row.trim() === "kabane")).toBe(false);
			const spans = captureSpans().lines.flatMap((line) => line.spans);
			const lead = spanWith(spans, WELCOME_LEAD);
			expect(lead && ints(lead.bg)).toEqual(rgb(Theme.DARK.surface.raised));
			expect(lead && ints(lead.fg)).toEqual(rgb(Theme.DARK.text));
			expect(lead ? lead.attributes & TextAttributes.BOLD : 0).toBeTruthy();
			const estimate = spanWith(spans, "which agents get kabane.");
			expect(estimate && ints(estimate.fg)).toEqual(rgb(Theme.DARK.muted));
		} finally {
			destroy();
		}
	});

	it("below 31 columns the welcome says kabane in bold instead of the wordmark", async () => {
		const { until, destroy } = await mount(DEFAULTS, { width: 30 });
		try {
			const frame = await until((f) => f.includes("kabane"));
			expect(frame).not.toContain("█");
		} finally {
			destroy();
		}
	});

	it("the focused field paints the selected surface across the row; tab moves it", async () => {
		const { mockInput, toForm, until, captureSpans, destroy } = await mount(
			DEFAULTS,
			{ width: 40 },
		);
		try {
			await toForm();
			const nameRow = (): CapturedSpan[] =>
				captureSpans().lines.find((line) =>
					line.spans.some((span) => span.text.includes("name")),
				)?.spans ?? [];
			const label = spanWith(nameRow(), "name");
			expect(label && ints(label.bg)).toEqual(rgb(Theme.DARK.surface.selected));
			mockInput.pressTab();
			await until(() => {
				const moved = spanWith(nameRow(), "name");
				return (
					moved !== undefined &&
					ints(moved.bg).join() === rgb(Theme.DARK.surface.raised).join()
				);
			});
			const claude = spanWith(
				captureSpans().lines.flatMap((line) => line.spans),
				"Claude Code",
			);
			expect(claude && ints(claude.bg)).toEqual(
				rgb(Theme.DARK.surface.selected),
			);
		} finally {
			destroy();
		}
	});

	it("an unchecked agent reads muted as well as `[ ]`", async () => {
		const { mockInput, toForm, until, captureSpans, destroy } = await mount(
			DEFAULTS,
			{ width: 40 },
		);
		try {
			await toForm();
			mockInput.pressTab();
			mockInput.pressKey(" ");
			await until((f) => f.includes("[ ] Claude Code"));
			const spans = captureSpans().lines.flatMap((line) => line.spans);
			const off = spanWith(spans, "[ ] Claude Code");
			const on = spanWith(spans, "[x] Codex");
			expect(off && ints(off.fg)).toEqual(rgb(Theme.DARK.muted));
			expect(on && ints(on.fg)).toEqual(rgb(Theme.DARK.text));
		} finally {
			destroy();
		}
	});

	it("enter's consequences share one raised panel with the key in the label column", async () => {
		const { toForm, captureSpans, destroy } = await mount(DEFAULTS, {
			width: 40,
		});
		try {
			const frame = await toForm();
			for (const line of enterLines(DEFAULTS.configPath, 2, "claude"))
				expect(onOneRow(frame, line)).toBe(true);
			const spans = captureSpans().lines.flatMap((line) => line.spans);
			for (const line of ["saves ~/.kabane/config.json", "opens the board"]) {
				const span = spanWith(spans, line);
				expect(span && ints(span.bg)).toEqual(rgb(Theme.DARK.surface.raised));
			}
			// The form's value column and the consequences' column are the same column.
			const valueAt = rows(frame)
				.find((row) => row.includes(NAME_NOTE))
				?.indexOf(NAME_NOTE);
			const savesAt = rows(frame)
				.find((row) => row.includes("saves "))
				?.indexOf("saves ");
			expect(savesAt).toBe(valueAt);
		} finally {
			destroy();
		}
	});

	it("done sets the phrase to say apart on the selected surface, inside the issue's panel", async () => {
		const { mockInput, toForm, until, captureSpans, destroy } = await mount(
			DEFAULTS,
			{ width: 40 },
		);
		try {
			await toForm();
			mockInput.pressEnter();
			await until((f) => f.includes("✓ filed"));
			const spans = captureSpans().lines.flatMap((line) => line.spans);
			const phrase = spanWith(spans, NEXT_PHRASE);
			expect(phrase?.text).toBe(NEXT_PHRASE);
			expect(phrase && ints(phrase.bg)).toEqual(
				rgb(Theme.DARK.surface.selected),
			);
			for (const text of ["saved", "installed", "watch REPO-1"]) {
				const span = spanWith(spans, text);
				expect(span && ints(span.bg)).toEqual(rgb(Theme.DARK.surface.raised));
			}
		} finally {
			destroy();
		}
	});

	it("on the light ramp every panel and its text come from the light tokens", async () => {
		const { mockInput, toForm, until, captureSpans, destroy } = await mount(
			DEFAULTS,
			{ width: 40, theme: Theme.LIGHT },
		);
		try {
			const welcome = await until((f) => f.includes(WELCOME_LEAD));
			expect(welcome).toContain(WELCOME_LEAD);
			const lead = spanWith(
				captureSpans().lines.flatMap((line) => line.spans),
				WELCOME_LEAD,
			);
			expect(lead && ints(lead.bg)).toEqual(rgb(Theme.LIGHT.surface.raised));
			expect(lead && ints(lead.fg)).toEqual(rgb(Theme.LIGHT.text));
			await toForm();
			mockInput.pressEnter();
			await until((f) => f.includes("✓ filed"));
			const spans = captureSpans().lines.flatMap((line) => line.spans);
			const filed = spanWith(spans, "for claude");
			expect(filed && ints(filed.bg)).toEqual(rgb(Theme.LIGHT.surface.raised));
			expect(filed && ints(filed.fg)).toEqual(rgb(Theme.LIGHT.text));
		} finally {
			destroy();
		}
	});
});

// The copy JCAB-82 settled, pinned so a restyle cannot reword it.
describe("SetupScreen copy", () => {
	it("keeps JCAB-82's next step word for word", () => {
		expect(nextLines("claude", "REPO-1")[1]).toBe(`say ${NEXT_PHRASE} and`);
		expect(NEXT_PHRASE).toBe('"take the next kabane issue"');
	});
});
