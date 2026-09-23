/** @jsxImportSource @opentui/react */
// The first-run screen `cabane` shows on a device with no config: one welcome card on what cabane
// is, then who you are and which detected harnesses get the MCP server. Enter writes the config
// through the host, runs the installs, files a first issue for an agent inside a project, and shows
// each outcome with the next step; enter again hands over to the board. Everything it decides lives
// in SetupPlan.
//
// Key arbitration is the copilot pane's: the focused <input> and the one useKeyboard handler both
// see every key, handler first, and the handler preventDefaults the keys it takes (tab, arrows,
// enter, esc, and space on a checkbox row) so the input never acts on them too.

import type { Result } from "@cabane/core";
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
import type { Keymap } from "./keymap";
import { SetupPlan } from "./setup-plan";
import { useSpinnerFrame } from "./spinner";
import { Theme, ThemeProvider, useTheme } from "./theme";

const INPUT_WIDTH = 24;
// `› ` plus the widest label, padded: where an input, a checkbox, or the note under one starts.
const LABEL_WIDTH = 9;
// `enter ` before the first line of what enter does: where the rest of those lines start.
const ENTER_INDENT = 6;
// Where a line's note starts when it goes under the line rather than beside it.
const NOTE_INDENT = 2;

export type SetupDeps = {
	defaults: SetupPlan.Defaults;
	// Writes the config for this plan; resolves to where it went. The host's business:
	// the config schema is the CLI's, and the board never sees it.
	save: (plan: SetupPlan.Plan) => Promise<Result<string>>;
	// Registers the MCP server in each named harness, one outcome per id.
	install: (ids: readonly string[]) => Promise<SetupPlan.InstallOutcome[]>;
	// Files the issue that has the named agent add cabane to the project's instruction file.
	fileFirstIssue: (harness: string) => Promise<Result<SetupPlan.FirstIssue>>;
};

type FiledIssue = { harness: string; result: Result<SetupPlan.FirstIssue> };

type Phase =
	| { kind: "welcome" }
	| { kind: "form"; error?: string }
	| { kind: "working"; step: string }
	| {
			kind: "done";
			configPath: string;
			outcomes: SetupPlan.InstallOutcome[];
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
	["one screen of setup: your name and", "which agents get cabane."],
];

const WELCOME_FOOTER: readonly Keymap.Hint[] = [
	{ key: "enter", label: "set up" },
	{ key: "esc", label: "quit" },
];

// Tab and the arrows go unsaid, as j/k do on the board: the footer has to fit a 40-column pane.
const FORM_FOOTER: readonly Keymap.Hint[] = [
	{ key: "space", label: "toggle" },
	{ key: "enter", label: "confirm" },
	{ key: "esc", label: "quit" },
];

const DONE_FOOTER: readonly Keymap.Hint[] = [
	{ key: "enter", label: "open the board" },
	{ key: "q", label: "quit" },
];

// Space toggles a harness row, so with none detected there is nothing to toggle.
const footerFor = (
	phase: Phase,
	defaults: SetupPlan.Defaults,
): readonly Keymap.Hint[] => {
	if (phase.kind === "welcome") return WELCOME_FOOTER;
	if (phase.kind === "done") return DONE_FOOTER;
	if (defaults.harnesses.length > 0) return FORM_FOOTER;
	return FORM_FOOTER.filter((hint) => hint.key !== "space");
};

// Each field's one-line purpose, dim under it. At 40 columns a note has 31 after the label column.
export const NAME_NOTE = "signs what you write";
export const AGENTS_NOTE = "checked ones get cabane's tools";
export const NO_AGENTS = "none found on PATH";
export const NO_AGENTS_NOTE = "add later: cabane mcp install";
export const AGENTS_OFF = "install off";
export const AGENTS_OFF_NOTE = "CABANE_HARNESSES is set";

const agentCount = (count: number): string =>
	`${count} agent${count === 1 ? "" : "s"}`;

/** What enter will do, one change a line, so nothing it touches goes unsaid. */
export const enterLines = (
	configPath: string,
	agents: number,
	firstAgent?: string,
): readonly string[] => [
	`saves ${configPath}`,
	...(agents > 0 ? [`adds cabane to ${agentCount(agents)}`] : []),
	...(firstAgent ? [`files one issue for ${firstAgent}`] : []),
	"opens the board",
];

/**
 * What to do once the board opens, for the first issue to move. A new session because a harness
 * reads its MCP servers when a session starts, so one already running has no cabane tools.
 */
export const nextLines = (harness: string, shortId: string): string[] => [
	`next: in a new ${harness} session here,`,
	`say "take the next cabane issue" and`,
	`watch ${shortId} move on the board.`,
];

/**
 * A path cut to `room` columns from the left, whole segments at a time, so it never wraps mid-word
 * and keeps the file name: `/var/folders/…/cabane/.cabane/config.json` → `…/.cabane/config.json`.
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

export const outcomeLine = (
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
	const theme = useTheme();

	const fileFor = async (
		outcomes: readonly SetupPlan.InstallOutcome[],
	): Promise<FiledIssue | undefined> => {
		const harness = SetupPlan.firstIssueFor(outcomes, defaults);
		if (harness === undefined) return undefined;
		setPhase({
			kind: "working",
			step: `filing the first issue for ${harness}`,
		});
		return { harness, result: await fileFirstIssue(harness) };
	};

	const confirm = async (): Promise<void> => {
		const planned = SetupPlan.plan(current.current, defaults);
		if (!planned.ok) {
			setPhase({ kind: "form", error: planned.error.message });
			return;
		}
		setPhase({ kind: "working", step: "writing the config" });
		const saved = await save(planned.value);
		if (!saved.ok) {
			setPhase({ kind: "form", error: saved.error.message });
			return;
		}
		// Nothing to show but the path: straight on to the board.
		if (planned.value.install.length === 0) {
			onComplete();
			return;
		}
		setPhase({
			kind: "working",
			step: `adding cabane to ${agentCount(planned.value.install.length)}`,
		});
		const outcomes = await install(planned.value.install);
		const firstIssue = await fileFor(outcomes);
		setPhase({ kind: "done", configPath: saved.value, outcomes, firstIssue });
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
		} else if (key.name === "space" && field?.kind === "harness") {
			key.preventDefault();
			update(SetupPlan.toggle(current.current, defaults));
		}
	});

	const labelOf = (id: string): string =>
		defaults.harnesses.find((h) => h.id === id)?.label ?? id;

	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			<text fg={theme.defaultFg}>
				<span attributes={TextAttributes.BOLD}>cabane</span>
				{phase.kind === "welcome" ? null : (
					<span fg={theme.muted}> · setup</span>
				)}
			</text>
			<box style={{ flexDirection: "column", flexGrow: 1, marginTop: 1 }}>
				{phase.kind === "welcome" ? (
					<WelcomeCard />
				) : phase.kind === "done" ? (
					<>
						<SavedLine path={phase.configPath} />
						<box style={{ flexDirection: "column", marginTop: 1 }}>
							{phase.outcomes.map((outcome) => (
								<OutcomeRow
									key={outcome.id}
									outcome={outcome}
									label={labelOf(outcome.id)}
								/>
							))}
						</box>
						{phase.firstIssue ? (
							<FirstIssueBlock filed={phase.firstIssue} />
						) : null}
					</>
				) : (
					<SetupForm
						defaults={defaults}
						form={form}
						onName={(name) => update({ ...current.current, name })}
					/>
				)}
				{phase.kind === "form" ? (
					<EnterLines
						configPath={defaults.configPath}
						agents={form.checked.length}
						firstAgent={SetupPlan.firstAgent(form, defaults)}
					/>
				) : null}
				{phase.kind === "form" && phase.error ? (
					<text fg={theme.failed} style={{ marginTop: 1 }}>
						{phase.error}
					</text>
				) : null}
				{phase.kind === "working" ? (
					<text fg={theme.working} style={{ marginTop: 1 }}>
						{`${spinnerFrame} ${phase.step}`}
					</text>
				) : null}
			</box>
			<StatusBar hints={footerFor(phase, defaults)} />
		</box>
	);
};

const WelcomeCard = (): ReactNode => {
	const theme = useTheme();
	return (
		<box style={{ flexDirection: "column" }}>
			{WELCOME.map(([lead, ...rest], index) => (
				<box
					key={lead}
					style={{ flexDirection: "column", marginTop: index === 0 ? 0 : 1 }}
				>
					<text
						fg={theme.defaultFg}
						attributes={index === 0 ? TextAttributes.BOLD : undefined}
					>
						{lead}
					</text>
					{rest.map((line) => (
						<text key={line} fg={theme.defaultFg}>
							{line}
						</text>
					))}
				</box>
			))}
		</box>
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
		}
	};
	const [name, ...agents] = SetupPlan.fields(defaults).map(row);
	return (
		<box style={{ flexDirection: "column" }}>
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
						<text fg={theme.defaultFg}>
							{`${" ".repeat(2)}${"agents".padEnd(LABEL_WIDTH - 2)}`}
							{defaults.installOff ? AGENTS_OFF : NO_AGENTS}
						</text>
						<Note
							text={defaults.installOff ? AGENTS_OFF_NOTE : NO_AGENTS_NOTE}
						/>
					</>
				)}
			</box>
		</box>
	);
};

// A field's purpose, dim, under its value.
const Note = ({ text }: { text: string }): ReactNode => {
	const theme = useTheme();
	return <text fg={theme.muted}>{`${" ".repeat(LABEL_WIDTH)}${text}`}</text>;
};

// `enter` in the footer's key colour, then what it will do, dim.
const EnterLines = ({
	configPath,
	agents,
	firstAgent,
}: {
	configPath: string;
	agents: number;
	firstAgent?: string;
}): ReactNode => {
	const { width } = useTerminalDimensions();
	const theme = useTheme();
	const room = width - ENTER_INDENT - "saves ".length;
	return (
		<box style={{ flexDirection: "column", marginTop: 1 }}>
			{enterLines(elidePath(configPath, room), agents, firstAgent).map(
				(line, index) => (
					<text key={line} fg={theme.defaultFg}>
						{index === 0 ? "enter " : " ".repeat(ENTER_INDENT)}
						<span fg={theme.muted}>{line}</span>
					</text>
				),
			)}
		</box>
	);
};

const SavedLine = ({ path }: { path: string }): ReactNode => {
	const { width } = useTerminalDimensions();
	const theme = useTheme();
	const head = "✓ saved ";
	return (
		<text fg={theme.defaultFg}>
			<span fg={theme.done}>✓</span>
			{` saved ${elidePath(path, width - head.length)}`}
		</text>
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

const TextRow = ({
	label,
	value,
	focused,
	onInput,
}: TextRowProps): ReactNode => {
	const theme = useTheme();
	return (
		<box style={{ flexDirection: "row", height: 1 }}>
			<text fg={theme.defaultFg} style={{ flexShrink: 0 }}>
				<Gutter label={label} focused={focused} />
			</text>
			<input
				value={value}
				focused={focused}
				onInput={onInput}
				backgroundColor={theme.surface.raised}
				focusedBackgroundColor={theme.surface.selected}
				textColor={theme.text}
				focusedTextColor={theme.text}
				style={{ width: INPUT_WIDTH, flexShrink: 0 }}
			/>
		</box>
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
	const { width } = useTerminalDimensions();
	const theme = useTheme();
	if (note === undefined || note === "")
		return <text fg={theme.defaultFg}>{head}</text>;
	if (fitsBeside(width, headLength, note))
		return (
			<text fg={theme.defaultFg}>
				{head}
				<span fg={noteFg}>{` ${note}`}</span>
			</text>
		);
	return (
		<box style={{ flexDirection: "column" }}>
			<text fg={theme.defaultFg}>{head}</text>
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

// The issue setup filed, and the one thing to do for it to move. A failure to file says why and
// nothing more: the config and the installs already landed, and the board opens either way.
const FirstIssueBlock = ({ filed }: { filed: FiledIssue }): ReactNode => {
	const theme = useTheme();
	if (!filed.result.ok) {
		const head = "✗ first issue not filed";
		return (
			<box style={{ marginTop: 1 }}>
				<NotedLine
					head={<span fg={theme.failed}>{head}</span>}
					headLength={head.length}
					note={filed.result.error.message}
					noteFg={theme.failed}
				/>
			</box>
		);
	}
	const { shortId, title } = filed.result.value;
	return (
		<box style={{ flexDirection: "column", marginTop: 1 }}>
			<text fg={theme.defaultFg}>
				<span fg={theme.done}>✓</span>
				{` filed ${shortId} for ${filed.harness}`}
			</text>
			<box style={{ paddingLeft: NOTE_INDENT }}>
				<text fg={theme.muted}>{title}</text>
			</box>
			<box style={{ flexDirection: "column", marginTop: 1 }}>
				{nextLines(filed.harness, shortId).map((line) => (
					<text key={line} fg={theme.defaultFg}>
						{line}
					</text>
				))}
			</box>
		</box>
	);
};

type CheckRowProps = {
	// The column label, on the first agent row only.
	label: string;
	harness: string;
	checked: boolean;
	focused: boolean;
};

const CheckRow = ({
	label,
	harness,
	checked,
	focused,
}: CheckRowProps): ReactNode => {
	const theme = useTheme();
	return (
		<text fg={theme.defaultFg}>
			<Gutter label={label} focused={focused} />
			<span bg={focused ? theme.surface.selected : undefined}>
				{`[${checked ? "x" : " "}] ${harness}`}
			</span>
		</text>
	);
};

/**
 * Run the setup screen on its own renderer. Resolves true when the config was written and the
 * human asked for the board, false when they left — esc or ctrl-c before confirming writes nothing.
 */
export const startSetup = async (deps: SetupDeps): Promise<boolean> => {
	const renderer = await createCliRenderer({ exitOnCtrlC: true });
	let completed = false;
	try {
		const theme = await Theme.detect(renderer);
		createRoot(renderer).render(
			<ThemeProvider value={theme}>
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
		if (!renderer.isDestroyed) renderer.destroy();
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
