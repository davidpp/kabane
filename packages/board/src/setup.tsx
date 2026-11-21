/** @jsxImportSource @opentui/react */
// The first-run screen `kabane` shows on a device with no config: one welcome card on what kabane
// is, then who you are, which detected harnesses get the MCP server and which of the extensions this
// install ships to turn on, none ticked until the human ticks one. Enter writes the config
// through the host, runs the installs, files a first issue for an agent inside a project, and shows
// each outcome with the next step; enter again hands over to the board. Everything it decides lives
// in SetupPlan. Each phase groups its parts on raised panels, the welcome under a block wordmark.
//
// Key arbitration is the copilot pane's: the focused <input> and the one useKeyboard handler both
// see every key, handler first, and the handler preventDefaults the keys it takes (tab, arrows,
// enter, esc, and space on a checkbox row) so the input never acts on them too.

import type { Result } from "@kabane/core";
import { createCliRenderer, TextAttributes } from "@opentui/core";
import {
	createRoot,
	useKeyboard,
	useRenderer,
	useTerminalDimensions,
} from "@opentui/react";
import { type ReactNode, useRef, useState } from "react";
import { ErrorBoundary } from "./error-boundary";
import { StatusBar } from "./footer";
import { Keymap } from "./keymap";
import { SetupPlan } from "./setup-plan";
import { useSpinnerFrame } from "./spinner";
import { closeRenderer } from "./teardown";
import { Theme, ThemeProvider, useTheme } from "./theme";

const INPUT_WIDTH = 24;
// `› ` plus the widest label, padded: where an input, a checkbox, the note under one, and each of
// enter's consequences start, so the form and the enter panel share one value column.
const LABEL_WIDTH = 9;
// Where a line's note starts when it goes under the line rather than beside it.
const NOTE_INDENT = 2;
// One cell of air inside every panel, left and right.
const PANEL_PAD = 1;

export type SetupDeps = {
	defaults: SetupPlan.Defaults;
	// Writes the config for this plan; resolves to where it went. The host's business:
	// the config schema is the CLI's, and the board never sees it.
	save: (plan: SetupPlan.Plan) => Promise<Result<string>>;
	// Registers the MCP server in each named harness, one outcome per id.
	install: (ids: readonly string[]) => Promise<SetupPlan.InstallOutcome[]>;
	// Turns on the named extensions the install ships, once the config is written.
	enable: (names: readonly string[]) => Promise<Result<void>>;
	// Files the issue that has the named agent add kabane to the project's instruction file.
	fileFirstIssue: (harness: string) => Promise<Result<SetupPlan.FirstIssue>>;
};

type FiledIssue = { harness: string; result: Result<SetupPlan.FirstIssue> };

type Enabled = { names: readonly string[]; result: Result<void> };

type Phase =
	| { kind: "welcome" }
	| { kind: "form"; error?: string }
	| { kind: "working"; step: string }
	| {
			kind: "done";
			configPath: string;
			outcomes: SetupPlan.InstallOutcome[];
			enabled?: Enabled;
			firstIssue?: FiledIssue;
	  };

// Paragraphs of the one welcome card, its first line bold. Every line fits 40 columns, so none
// wraps in the pane. The last paragraph is the honest time estimate: one screen follows.
export const WELCOME: readonly (readonly string[])[] = [
	[
		"a tracker for you and your agents.",
		"issues live in sqlite on this machine;",
		"claude, codex and gemini work them",
		"over mcp, and each write names who",
		"made it.",
	],
	["not a team tracker: linear and github", "stay the team record."],
	[
		"on the board, press A for the copilot:",
		'ask "how do I…" or change settings.',
		"or use kabane config in a terminal.",
	],
	["one screen of setup: your name and", "which agents get kabane."],
];

// Each phase's keys, from the one registry. Space toggles a harness row, so with none detected it is
// left out; while enter's work runs every key is ignored, so the footer says nothing.
const SETUP_CONTEXT: Record<Phase["kind"], Keymap.ContextId> = {
	welcome: "setupWelcome",
	form: "setupForm",
	working: "setupWorking",
	done: "setupDone",
};

const footerFor = (
	phase: Phase,
	defaults: SetupPlan.Defaults,
	step: SetupPlan.Step,
): readonly Keymap.Hint[] =>
	Keymap.footer(SETUP_CONTEXT[phase.kind], {
		harnesses: SetupPlan.fields(defaults, step).some((f) => f.kind !== "name"),
	});

// Each field's one-line purpose, dim under it. At 40 columns a note has 31 after the label column.
export const NAME_NOTE = "signs what you write";
export const AGENTS_NOTE = "checked ones get kabane's tools";
export const NO_AGENTS = "none found on PATH";
export const NO_AGENTS_NOTE = "add later: kabane mcp install";
export const AGENTS_OFF = "install off";
export const AGENTS_OFF_NOTE = "KABANE_HARNESSES is set";
export const EXTENSIONS_NOTE = "checked ones are turned on";
/** The enter panel's one line on the first step when extensions follow it. */
export const NEXT_STEP_LINE = "next: the extensions to turn on";

const agentCount = (count: number): string =>
	`${count} agent${count === 1 ? "" : "s"}`;

const extensionList = (names: readonly string[]): string => names.join(", ");

/** What enter will do, one change a line, so nothing it touches goes unsaid. */
export const enterLines = (
	configPath: string,
	agents: number,
	firstAgent?: string,
	extensions: readonly string[] = [],
): readonly string[] => [
	`saves ${configPath}`,
	...(agents > 0 ? [`adds kabane to ${agentCount(agents)}`] : []),
	...(extensions.length > 0 ? [`turns on ${extensionList(extensions)}`] : []),
	...(firstAgent ? [`files one issue for ${firstAgent}`] : []),
	"opens the board",
];

/** What to say to the agent: the done screen sets it apart as the thing to copy. */
export const NEXT_PHRASE = `"take the next kabane issue"`;

/**
 * What to do once the board opens, for the first issue to move. A new session because a harness
 * reads its MCP servers when a session starts, so one already running has no kabane tools.
 */
export const nextLines = (harness: string, shortId: string): string[] => [
	`next: in a new ${harness} session here,`,
	`say ${NEXT_PHRASE} and`,
	`watch ${shortId} move on the board.`,
];

/** Where the rest of the config is changed, so no one has to learn its JSON keys first. */
const LATER_LINE =
	"later: /setup in the copilot picks its harness or turns on an extension";

/**
 * The welcome's wordmark, in opencode's block-glyph manner: each letter four cells of `█▀▄` over
 * three rows, and a row above for the `k`'s and the `b`'s ascenders. Three marks are not drawn as
 * themselves: `_` is a counter cell (blank, on the shadow), `^` a top half over the shadow, `~` a
 * top half in the shadow's color, so each letter reads solid with a recessed inside. Every glyph
 * drawn is one narrow BMP codepoint, and the whole mark is 29 columns: it fits the forty-column
 * pane inside its panel.
 */
export const WORDMARK: readonly string[] = [
	"▄         ▄                  ",
	"█ ▄▀ ▀▀▀█ █▀▀█ ▀▀▀█ █▀▀▄ █▀▀█",
	"█▀▄  █^^█ █__█ █^^█ █__█ █^^^",
	"▀  ▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀~~▀ ▀▀▀▀",
];

export const WORDMARK_WIDTH = WORDMARK[0]?.length ?? 0;

/** Below this width the wordmark cannot fit its panel, and the welcome says `kabane` in bold. */
export const wordmarkFits = (width: number): boolean =>
	width - 2 * PANEL_PAD >= WORDMARK_WIDTH;

type WordmarkCell = "ink" | "counter" | "lid" | "floor";

export type WordmarkRun = { text: string; cell: WordmarkCell };

const WORDMARK_CELLS: Record<string, { glyph: string; cell: WordmarkCell }> = {
	_: { glyph: " ", cell: "counter" },
	"^": { glyph: "▀", cell: "lid" },
	"~": { glyph: "▀", cell: "floor" },
};

/** One wordmark row as runs of like cells, with the marks turned into the glyphs they draw. */
export const wordmarkRuns = (row: string): WordmarkRun[] =>
	Array.from(row).reduce<WordmarkRun[]>((runs, char) => {
		const { glyph, cell } = WORDMARK_CELLS[char] ?? {
			glyph: char,
			cell: "ink",
		};
		const last = runs.at(-1);
		if (last?.cell === cell) last.text += glyph;
		else runs.push({ text: glyph, cell });
		return runs;
	}, []);

/**
 * A path cut to `room` columns from the left, whole segments at a time, so it never wraps mid-word
 * and keeps the file name: `/var/folders/…/kabane/.kabane/config.json` → `…/.kabane/config.json`.
 */
export const elidePath = (path: string, room: number): string => {
	if (path.length <= room) return path;
	const segments = path.split("/");
	for (let start = 1; start < segments.length - 1; start++) {
		const tail = `…/${segments.slice(start).join("/")}`;
		if (tail.length <= room) return tail;
	}
	return `…/${segments.at(-1)}`;
};

const STATUS_TEXT: Record<SetupPlan.InstallStatus, string> = {
	installed: "✓ installed",
	already: "· already installed",
	failed: "✗ failed",
};

const statusFg = (
	status: SetupPlan.InstallStatus,
	theme: Theme.Tokens,
): string => {
	switch (status) {
		case "installed":
			return theme.done;
		case "already":
			return theme.muted;
		case "failed":
			return theme.failed;
	}
};

const OUTCOME_LABEL_WIDTH = 14;

const outcomeLine = (
	outcome: SetupPlan.InstallOutcome,
	label: string,
): string =>
	`${label.padEnd(OUTCOME_LABEL_WIDTH)} ${STATUS_TEXT[outcome.status]}`;

// A note sits beside its row while the pane has room for both, and on its own indented line under
// the row when it does not: a narrow pane never loses the row to the note.
const fitsBeside = (width: number, head: number, note: string): boolean =>
	head + 1 + note.length <= width;

export type SetupScreenProps = SetupDeps & {
	// The config is written: open the board.
	onComplete: () => void;
	// Leave without opening the board — before confirming, nothing was written.
	onQuit: () => void;
};

export const SetupScreen = ({
	defaults,
	save,
	install,
	enable,
	fileFirstIssue,
	onComplete,
	onQuit,
}: SetupScreenProps): ReactNode => {
	const [form, setForm] = useState(() => SetupPlan.initialForm(defaults));
	// Keys can land faster than renders, so each one reads the form the last one left, not the
	// form the last render saw: tab, down, space must toggle the row two below the name.
	const current = useRef(form);
	const update = (next: SetupPlan.Form): void => {
		current.current = next;
		setForm(next);
	};
	const [phase, setPhase] = useState<Phase>({ kind: "welcome" });
	const spinnerFrame = useSpinnerFrame(phase.kind === "working");

	const working = (step: string): void => setPhase({ kind: "working", step });

	const fileFor = async (
		outcomes: readonly SetupPlan.InstallOutcome[],
	): Promise<FiledIssue | undefined> => {
		const harness = SetupPlan.firstIssueFor(outcomes, defaults);
		if (harness === undefined) return undefined;
		working(`filing the first issue for ${harness}`);
		return { harness, result: await fileFirstIssue(harness) };
	};

	const confirm = async (): Promise<void> => {
		const planned = SetupPlan.plan(current.current, defaults);
		if (!planned.ok) {
			setPhase({ kind: "form", error: planned.error.message });
			return;
		}
		const next = SetupPlan.nextStep(current.current, defaults);
		if (next) return update(next);
		working("writing the config");
		const saved = await save(planned.value);
		if (!saved.ok) {
			setPhase({ kind: "form", error: saved.error.message });
			return;
		}
		const names = planned.value.extensions;
		if (names.length > 0) working(`turning on ${extensionList(names)}`);
		const enabled: Enabled | undefined =
			names.length > 0 ? { names, result: await enable(names) } : undefined;
		// Nothing to show but the path: straight on to the board.
		if (planned.value.install.length === 0 && enabled?.result.ok !== false) {
			onComplete();
			return;
		}
		working(`adding kabane to ${agentCount(planned.value.install.length)}`);
		const outcomes = await install(planned.value.install);
		const firstIssue = await fileFor(outcomes);
		setPhase({
			kind: "done",
			configPath: saved.value,
			outcomes,
			enabled,
			firstIssue,
		});
	};

	useKeyboard((key) => {
		if (phase.kind === "working") return;
		if (phase.kind === "welcome") {
			if (key.name === "return") setPhase({ kind: "form" });
			else if (key.name === "escape") onQuit();
			return;
		}
		if (phase.kind === "done") {
			if (key.name === "return") onComplete();
			else if (key.name === "q" || key.name === "escape") onQuit();
			return;
		}
		const move = (delta: number): void => {
			key.preventDefault();
			update(SetupPlan.moveFocus(current.current, defaults, delta));
		};
		const field = SetupPlan.focused(current.current, defaults);
		if (key.name === "escape") onQuit();
		else if (key.name === "tab") move(key.shift ? -1 : 1);
		else if (key.name === "down") move(1);
		else if (key.name === "up") move(-1);
		else if (key.name === "return") {
			key.preventDefault();
			void confirm();
		} else if (key.name === "space" && SetupPlan.ticks(field)) {
			key.preventDefault();
			update(SetupPlan.toggle(current.current, defaults));
		}
	});

	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			{/* The welcome's wordmark is its title; every later phase says where it is. */}
			{phase.kind === "welcome" ? null : <Title step={form.step} />}
			<box style={{ flexDirection: "column", flexGrow: 1, marginTop: 1 }}>
				{phase.kind === "welcome" ? (
					<WelcomeCard />
				) : phase.kind === "done" ? (
					<DoneCard done={phase} defaults={defaults} />
				) : (
					<SetupForm
						defaults={defaults}
						form={form}
						onName={(name) => update({ ...current.current, name })}
					/>
				)}
				<ConfirmPanel
					phase={phase}
					form={form}
					defaults={defaults}
					spinnerFrame={spinnerFrame}
				/>
			</box>
			<StatusBar hints={footerFor(phase, defaults, form.step)} />
		</box>
	);
};

const Title = ({ step }: { step: SetupPlan.Step }): ReactNode => {
	const theme = useTheme();
	return (
		<text fg={theme.defaultFg}>
			<span attributes={TextAttributes.BOLD}>kabane</span>
			<span fg={theme.muted}>
				{step === "extensions" ? " · setup · extensions" : " · setup"}
			</span>
		</text>
	);
};

// What setup wrote and installed, and the first issue it filed.
const DoneCard = ({
	done,
	defaults,
}: {
	done: Extract<Phase, { kind: "done" }>;
	defaults: SetupPlan.Defaults;
}): ReactNode => {
	const theme = useTheme();
	const labelOf = (id: string): string =>
		defaults.harnesses.find((h) => h.id === id)?.label ?? id;
	return (
		<>
			<Panel first>
				<SavedLine path={done.configPath} />
				<text fg={theme.muted}>{LATER_LINE}</text>
				<box style={{ flexDirection: "column", marginTop: 1 }}>
					{done.outcomes.map((outcome) => (
						<OutcomeRow
							key={outcome.id}
							outcome={outcome}
							label={labelOf(outcome.id)}
						/>
					))}
				</box>
				{done.enabled ? <EnabledLine enabled={done.enabled} /> : null}
			</Panel>
			{done.firstIssue ? <FirstIssuePanel filed={done.firstIssue} /> : null}
		</>
	);
};

// Under the form: the enter panel, which turns into the progress line while enter's work runs, so
// nothing jumps, and the error that sent the human back to the form.
const ConfirmPanel = ({
	phase,
	form,
	defaults,
	spinnerFrame,
}: {
	phase: Phase;
	form: SetupPlan.Form;
	defaults: SetupPlan.Defaults;
	spinnerFrame: string;
}): ReactNode => {
	const theme = useTheme();
	if (phase.kind === "working")
		return (
			<Panel>
				<text fg={theme.working}>{`${spinnerFrame} ${phase.step}`}</text>
			</Panel>
		);
	if (phase.kind !== "form") return null;
	return (
		<>
			<EnterPanel
				configPath={defaults.configPath}
				agents={form.checked.length}
				firstAgent={SetupPlan.firstAgent(form, defaults)}
				extensions={form.accepted}
				next={SetupPlan.nextStep(form, defaults) !== undefined}
			/>
			{phase.error ? (
				<text fg={theme.failed} style={{ marginTop: 1 }}>
					{phase.error}
				</text>
			) : null}
		</>
	);
};

// The width inside a padded panel: the pane less the panel's air on either side.
const usePanelWidth = (): number =>
	useTerminalDimensions().width - 2 * PANEL_PAD;

// A raised panel, one tonal step up from the terminal's own background: how setup groups what
// belongs together, the way the board sets a block apart (DESIGN.md: a surface, never a rule). Its
// cells are painted, so text inside names its foreground (`theme.text`), never the default.
const Panel = ({
	first = false,
	gutter = false,
	children,
}: {
	// The first panel of a phase sits right under the header's gap; the rest keep one row apart.
	first?: boolean;
	// Its rows open with their own `› ` gutter, which is the panel's air: no padding beside it, so a
	// note in the value column keeps all of a forty-column pane's room.
	gutter?: boolean;
	children: ReactNode;
}): ReactNode => {
	const theme = useTheme();
	return (
		<box
			style={{
				flexDirection: "column",
				flexShrink: 0,
				marginTop: first ? 0 : 1,
				backgroundColor: theme.surface.raised,
				paddingLeft: gutter ? 0 : PANEL_PAD,
				paddingRight: gutter ? 0 : PANEL_PAD,
				paddingTop: 1,
				paddingBottom: 1,
			}}
		>
			{children}
		</box>
	);
};

const Wordmark = (): ReactNode => {
	const theme = useTheme();
	// The recess: the strongest painted step, so the counters read as cut into the letters.
	const shadow = theme.surface.selected;
	const style = (
		cell: WordmarkCell,
	): { fg: string; bg: string | undefined } => {
		switch (cell) {
			case "ink":
				return { fg: theme.text, bg: undefined };
			case "counter":
			case "lid":
				return { fg: theme.text, bg: shadow };
			case "floor":
				return { fg: shadow, bg: undefined };
		}
	};
	return (
		<box style={{ flexDirection: "column" }}>
			{WORDMARK.map((row, index) => (
				// Index keys: the wordmark's rows are fixed and positional.
				<text key={index} fg={theme.text}>
					{wordmarkRuns(row).map((run, at) => (
						// Index keys: a row's runs are positional.
						<span key={at} {...style(run.cell)}>
							{run.text}
						</span>
					))}
				</text>
			))}
		</box>
	);
};

const WelcomeCard = (): ReactNode => {
	const theme = useTheme();
	const { width } = useTerminalDimensions();
	const last = WELCOME.length - 1;
	return (
		<Panel first>
			{wordmarkFits(width) ? (
				<Wordmark />
			) : (
				<text fg={theme.text} attributes={TextAttributes.BOLD}>
					kabane
				</text>
			)}
			{WELCOME.map(([lead, ...rest], index) => (
				<box key={lead} style={{ flexDirection: "column", marginTop: 1 }}>
					{/* The lead in Title weight; the last paragraph is the time estimate, and reads as aside. */}
					<text
						fg={index === last ? theme.muted : theme.text}
						attributes={index === 0 ? TextAttributes.BOLD : undefined}
					>
						{lead}
					</text>
					{rest.map((line) => (
						<text key={line} fg={index === last ? theme.muted : theme.text}>
							{line}
						</text>
					))}
				</box>
			))}
		</Panel>
	);
};

type SetupFormProps = {
	defaults: SetupPlan.Defaults;
	form: SetupPlan.Form;
	onName: (name: string) => void;
};

const SetupForm = ({ defaults, form, onName }: SetupFormProps): ReactNode => {
	const theme = useTheme();
	const row = (field: SetupPlan.Field, index: number): ReactNode => {
		const focused = index === form.focus;
		switch (field.kind) {
			case "name":
				return (
					<TextRow
						key="name"
						label="name"
						value={form.name}
						focused={focused}
						onInput={onName}
					/>
				);
			case "harness":
				return (
					<CheckRow
						key={field.harness.id}
						label={index === 1 ? "agents" : ""}
						harness={field.harness.label}
						checked={form.checked.includes(field.harness.id)}
						focused={focused}
					/>
				);
			case "extension":
				return (
					<ExtensionRow
						key={field.extension.name}
						offer={field.extension}
						checked={form.accepted.includes(field.extension.name)}
						focused={focused}
					/>
				);
		}
	};
	if (form.step === "extensions")
		return (
			<Panel first gutter>
				{SetupPlan.fields(defaults, "extensions").map(row)}
				<Note text={EXTENSIONS_NOTE} />
			</Panel>
		);
	const [name, ...agents] = SetupPlan.fields(defaults).map(row);
	return (
		<Panel first gutter>
			{name}
			<Note text={NAME_NOTE} />
			<box style={{ flexDirection: "column", marginTop: 1 }}>
				{agents.length > 0 ? (
					<>
						{agents}
						<Note text={AGENTS_NOTE} />
					</>
				) : (
					<>
						<text fg={theme.text}>
							{`${" ".repeat(2)}${"agents".padEnd(LABEL_WIDTH - 2)}`}
							{defaults.installOff ? AGENTS_OFF : NO_AGENTS}
						</text>
						<Note
							text={defaults.installOff ? AGENTS_OFF_NOTE : NO_AGENTS_NOTE}
						/>
					</>
				)}
			</box>
		</Panel>
	);
};

// A field's purpose, dim, under its value.
const Note = ({ text }: { text: string }): ReactNode => {
	const theme = useTheme();
	return <text fg={theme.muted}>{`${" ".repeat(LABEL_WIDTH)}${text}`}</text>;
};

// Everything enter will change, as one panel: the key in the label column, bold, and each
// consequence in the form's value column, so the form above and this panel read as one grid.
const EnterPanel = ({
	configPath,
	agents,
	firstAgent,
	extensions,
	next,
}: {
	configPath: string;
	agents: number;
	firstAgent?: string;
	extensions: readonly string[];
	// Enter moves on to the extensions step and changes nothing yet.
	next: boolean;
}): ReactNode => {
	const theme = useTheme();
	const { width } = useTerminalDimensions();
	const room = width - LABEL_WIDTH - "saves ".length;
	return (
		<Panel gutter>
			{(next
				? [NEXT_STEP_LINE]
				: enterLines(
						elidePath(configPath, room),
						agents,
						firstAgent,
						extensions,
					)
			).map((line, index) => (
				<text key={line} fg={theme.text}>
					{index === 0 ? (
						<span attributes={TextAttributes.BOLD}>
							{`  ${"enter".padEnd(LABEL_WIDTH - 2)}`}
						</span>
					) : (
						" ".repeat(LABEL_WIDTH)
					)}
					{line}
				</text>
			))}
		</Panel>
	);
};

const SavedLine = ({ path }: { path: string }): ReactNode => {
	const theme = useTheme();
	const head = "✓ saved ";
	const room = usePanelWidth() - head.length;
	return (
		<text fg={theme.text}>
			<span fg={theme.done}>✓</span>
			{` saved ${elidePath(path, room)}`}
		</text>
	);
};

// A field's row. The focused one paints the selected surface across the panel, with an explicit fg
// on every cell (the Selection Rule), and the accent `›` saying which field is waiting on you.
const FieldRow = ({
	focused,
	children,
}: {
	focused: boolean;
	children: ReactNode;
}): ReactNode => {
	const theme = useTheme();
	return (
		<box
			style={{
				flexDirection: "row",
				height: 1,
				backgroundColor: focused ? theme.surface.selected : undefined,
			}}
		>
			{children}
		</box>
	);
};

type TextRowProps = {
	label: string;
	value: string;
	focused: boolean;
	onInput: (value: string) => void;
};

// `› ` in the accent on the focused row, blank elsewhere, then the label padded to its column.
const Gutter = ({
	label,
	focused,
}: {
	label: string;
	focused: boolean;
}): ReactNode => {
	const theme = useTheme();
	return (
		<>
			<span fg={theme.accent}>{focused ? "›" : " "}</span>
			{` ${label.padEnd(LABEL_WIDTH - 2)}`}
		</>
	);
};

// The input sits on the overlay step in both states: lifted off the panel when idle, inset in the
// selected row when focused, so it reads as a field either way.
const TextRow = ({
	label,
	value,
	focused,
	onInput,
}: TextRowProps): ReactNode => {
	const theme = useTheme();
	return (
		<FieldRow focused={focused}>
			<text fg={theme.text} style={{ flexShrink: 0 }}>
				<Gutter label={label} focused={focused} />
			</text>
			<input
				value={value}
				focused={focused}
				onInput={onInput}
				backgroundColor={theme.surface.overlay}
				focusedBackgroundColor={theme.surface.overlay}
				textColor={theme.text}
				focusedTextColor={theme.text}
				style={{ width: INPUT_WIDTH, flexShrink: 0 }}
			/>
		</FieldRow>
	);
};

type NotedLineProps = {
	head: ReactNode;
	// The head's width in columns, for deciding whether the note fits beside it.
	headLength: number;
	note?: string;
	noteFg: string;
};

const NotedLine = ({
	head,
	headLength,
	note,
	noteFg,
}: NotedLineProps): ReactNode => {
	const width = usePanelWidth();
	const theme = useTheme();
	if (note === undefined || note === "")
		return <text fg={theme.text}>{head}</text>;
	if (fitsBeside(width, headLength, note))
		return (
			<text fg={theme.text}>
				{head}
				<span fg={noteFg}>{` ${note}`}</span>
			</text>
		);
	return (
		<box style={{ flexDirection: "column" }}>
			<text fg={theme.text}>{head}</text>
			{/* A harness's error can outrun the pane: padding, not spaces, keeps its wrap indented. */}
			<box style={{ paddingLeft: NOTE_INDENT }}>
				<text fg={noteFg}>{note}</text>
			</box>
		</box>
	);
};

const OutcomeRow = ({
	outcome,
	label,
}: {
	outcome: SetupPlan.InstallOutcome;
	label: string;
}): ReactNode => {
	const theme = useTheme();
	return (
		<NotedLine
			head={
				<>
					{`${label.padEnd(OUTCOME_LABEL_WIDTH)} `}
					<span fg={statusFg(outcome.status, theme)}>
						{STATUS_TEXT[outcome.status]}
					</span>
				</>
			}
			headLength={outcomeLine(outcome, label).length}
			note={outcome.message}
			noteFg={outcome.status === "failed" ? theme.failed : theme.muted}
		/>
	);
};

// A next-step line, with the phrase to say set apart on the selected surface as the thing to copy.
const NextLine = ({ line }: { line: string }): ReactNode => {
	const theme = useTheme();
	const at = line.indexOf(NEXT_PHRASE);
	if (at < 0) return <text fg={theme.text}>{line}</text>;
	return (
		<text fg={theme.text}>
			{line.slice(0, at)}
			<span
				fg={theme.text}
				bg={theme.surface.selected}
				attributes={TextAttributes.BOLD}
			>
				{NEXT_PHRASE}
			</span>
			{line.slice(at + NEXT_PHRASE.length)}
		</text>
	);
};

// The issue setup filed, and the one thing to do for it to move. A failure to file says why and
// nothing more: the config and the installs already landed, and the board opens either way.
const FirstIssuePanel = ({ filed }: { filed: FiledIssue }): ReactNode => {
	const theme = useTheme();
	if (!filed.result.ok) {
		const head = "✗ first issue not filed";
		return (
			<Panel>
				<NotedLine
					head={<span fg={theme.failed}>{head}</span>}
					headLength={head.length}
					note={filed.result.error.message}
					noteFg={theme.failed}
				/>
			</Panel>
		);
	}
	const { shortId, title } = filed.result.value;
	return (
		<Panel>
			<text fg={theme.text}>
				<span fg={theme.done}>✓</span>
				{" filed "}
				<span attributes={TextAttributes.BOLD}>{shortId}</span>
				{` for ${filed.harness}`}
			</text>
			<box style={{ paddingLeft: NOTE_INDENT }}>
				<text fg={theme.muted}>{title}</text>
			</box>
			<box style={{ flexDirection: "column", marginTop: 1 }}>
				{nextLines(filed.harness, shortId).map((line) => (
					<NextLine key={line} line={line} />
				))}
			</box>
		</Panel>
	);
};

type CheckRowProps = {
	// The column label, on the first agent row only.
	label: string;
	harness: string;
	checked: boolean;
	focused: boolean;
};

// Checked and unchecked differ in shape (`[x]` against `[ ]`) and in tone: a harness left out reads
// muted, so the rows that will get kabane's tools stand out without color carrying it.
const CheckRow = ({
	label,
	harness,
	checked,
	focused,
}: CheckRowProps): ReactNode => {
	const theme = useTheme();
	return (
		<FieldRow focused={focused}>
			<text fg={theme.text}>
				<Gutter label={label} focused={focused} />
				<span fg={checked ? theme.text : theme.muted}>
					{`[${checked ? "x" : " "}] ${harness}`}
				</span>
			</text>
		</FieldRow>
	);
};

// An extension row is a check row with what the extension does under it, dim: one line cut to the
// panel, more of it while the row has focus.
const ExtensionRow = ({
	offer,
	checked,
	focused,
}: {
	offer: SetupPlan.Offer;
	checked: boolean;
	focused: boolean;
}): ReactNode => {
	const theme = useTheme();
	const room = usePanelWidth() + 2 * PANEL_PAD - LABEL_WIDTH - 4;
	const about = offer.description ?? "";
	// Three lines' worth while focused: the step has to fit a 24-row terminal at 40 columns.
	const fits = room * (focused ? 3 : 1);
	const shown =
		about.length <= fits ? about : `${about.slice(0, fits - 1).trimEnd()}…`;
	return (
		<box style={{ flexDirection: "column" }}>
			<CheckRow
				label=""
				harness={offer.name}
				checked={checked}
				focused={focused}
			/>
			{shown === "" ? null : (
				<box style={{ paddingLeft: LABEL_WIDTH + 4 }}>
					<text fg={theme.muted}>{shown}</text>
				</box>
			)}
		</box>
	);
};

// What turning on the ticked extensions did: their names, or why it failed.
const EnabledLine = ({ enabled }: { enabled: Enabled }): ReactNode => {
	const theme = useTheme();
	const head = `${enabled.result.ok ? "✓" : "✗"} ${extensionList(enabled.names)}`;
	return (
		<box style={{ marginTop: 1 }}>
			<NotedLine
				head={
					<span fg={enabled.result.ok ? theme.done : theme.failed}>{head}</span>
				}
				headLength={head.length}
				note={enabled.result.ok ? "turned on" : enabled.result.error.message}
				noteFg={enabled.result.ok ? theme.muted : theme.failed}
			/>
		</box>
	);
};

/**
 * Run the setup screen on its own renderer. Resolves true when the config was written and the
 * human asked for the board, false when they left — esc or ctrl-c before confirming writes nothing.
 * It resolves only once that renderer has closed, so the board's can take stdin straight after.
 */
export const startSetup = async (deps: SetupDeps): Promise<boolean> => {
	const renderer = await createCliRenderer({ exitOnCtrlC: true });
	let completed = false;
	try {
		const theme = await Theme.detect(renderer);
		createRoot(renderer).render(
			<ThemeProvider initial={theme}>
				<ErrorBoundary fallback={(error) => <SetupCrash error={error} />}>
					<SetupScreen
						{...deps}
						onComplete={() => {
							completed = true;
							renderer.destroy();
						}}
						onQuit={() => renderer.destroy()}
					/>
				</ErrorBoundary>
			</ThemeProvider>,
		);
		await new Promise<void>((resolve) => {
			renderer.on("destroy", resolve);
		});
	} finally {
		await closeRenderer(renderer);
	}
	return completed;
};

const SetupCrash = ({ error }: { error: Error }): ReactNode => {
	const renderer = useRenderer();
	const theme = useTheme();
	useKeyboard((key) => {
		if (key.name === "q") renderer.destroy();
	});
	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			<text fg={theme.failed}>Setup crashed: {error.message}</text>
			<text fg={theme.muted}>q quit</text>
		</box>
	);
};
