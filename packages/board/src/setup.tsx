/** @jsxImportSource @opentui/react */
// The first-run screen `cabane` shows on a device with no config: three short cards on what cabane
// is, then who you are and which detected harnesses get the MCP server. Enter writes the config through the host, runs the installs, and shows each
// harness's outcome; enter again hands over to the board. Everything it decides lives in SetupPlan.
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
import { SELECTED_BG } from "./board";
import { ErrorBoundary } from "./error-boundary";
import { StatusBar } from "./footer";
import { Keymap } from "./keymap";
import { SetupPlan } from "./setup-plan";

const MUTED_COLOR = "#6b7280";
const ACCENT_COLOR = "#f97316";
const ERROR_COLOR = "#ef4444";
const INPUT_BG = "#1c1c1c";
const INPUT_WIDTH = 24;
// `› ` plus the widest label, padded: where an input, a checkbox, or the note under one starts.
const LABEL_WIDTH = 9;
// `enter ` before the first line of what enter does: where the rest of those lines start.
const ENTER_INDENT = 6;

export type SetupDeps = {
	defaults: SetupPlan.Defaults;
	// Writes the config for this plan; resolves to where it went. The host's business:
	// the config schema is the CLI's, and the board never sees it.
	save: (plan: SetupPlan.Plan) => Promise<Result<string>>;
	// Registers the MCP server in each named harness, one outcome per id.
	install: (ids: readonly string[]) => Promise<SetupPlan.InstallOutcome[]>;
};

type Phase =
	| { kind: "intro"; card: number }
	| { kind: "form"; error?: string }
	| { kind: "working"; step: string }
	| {
			kind: "done";
			configPath: string;
			outcomes: SetupPlan.InstallOutcome[];
	  };

// Each card is one screen, first line bold. Every line fits 40 columns, so none wraps in the pane.
export const INTRO_CARDS: readonly (readonly string[])[] = [
	[
		"a tracker for you and your agents.",
		"issues live in sqlite on this machine.",
		"claude, codex, gemini use it over mcp.",
	],
	[
		"you plan, agents do the work.",
		"they pick up issues and report back.",
		"each write names you or the agent.",
	],
	[
		"not a team tracker.",
		"linear and github stay the team record.",
		"cabane links to their issues.",
		"your working notes stay here.",
	],
];

// The last card's enter opens the form, as esc does from any card.
const afterCard = (card: number): Phase =>
	card + 1 < INTRO_CARDS.length
		? { kind: "intro", card: card + 1 }
		: { kind: "form" };

const INTRO_FOOTER: readonly Keymap.Hint[] = [
	{ key: "enter", label: "next" },
	{ key: "esc", label: "skip" },
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
	if (phase.kind === "intro") return INTRO_FOOTER;
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

/** What enter will do, one change a line, so nothing it touches goes unsaid. */
export const enterLines = (
	configPath: string,
	agents: number,
): readonly string[] => [
	`saves ${configPath}`,
	...(agents > 0
		? [`adds cabane to ${agents} agent${agents === 1 ? "" : "s"}`]
		: []),
	"opens the board",
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

export const outcomeLine = (
	outcome: SetupPlan.InstallOutcome,
	label: string,
): string => `${label.padEnd(14)} ${STATUS_TEXT[outcome.status]}`;

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
	const [phase, setPhase] = useState<Phase>({ kind: "intro", card: 0 });

	const confirm = async (): Promise<void> => {
		const planned = SetupPlan.plan(current.current, defaults);
		if (!planned.ok) {
			setPhase({ kind: "form", error: planned.error.message });
			return;
		}
		setPhase({ kind: "working", step: "writing the config…" });
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
			step: `adding cabane to ${planned.value.install.join(", ")}…`,
		});
		const outcomes = await install(planned.value.install);
		setPhase({ kind: "done", configPath: saved.value, outcomes });
	};

	useKeyboard((key) => {
		if (phase.kind === "working") return;
		if (phase.kind === "intro") {
			if (key.name === "escape") setPhase({ kind: "form" });
			else if (key.name === "return") setPhase(afterCard(phase.card));
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
			<text>
				<span attributes={TextAttributes.BOLD}>cabane</span>
				<span fg={MUTED_COLOR}>
					{phase.kind === "intro"
						? ` · ${phase.card + 1}/${INTRO_CARDS.length}`
						: " · setup"}
				</span>
			</text>
			<box style={{ flexDirection: "column", flexGrow: 1, marginTop: 1 }}>
				{phase.kind === "intro" ? (
					<IntroCard lines={INTRO_CARDS[phase.card] ?? []} />
				) : phase.kind === "done" ? (
					<>
						<SavedLine path={phase.configPath} />
						<box style={{ flexDirection: "column", marginTop: 1 }}>
							{phase.outcomes.map((outcome) => (
								<NotedLine
									key={outcome.id}
									head={outcomeLine(outcome, labelOf(outcome.id))}
									note={outcome.message}
									indent={2}
									fg={outcome.status === "failed" ? ERROR_COLOR : undefined}
								/>
							))}
						</box>
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
					/>
				) : null}
				{phase.kind === "form" && phase.error ? (
					<text fg={ERROR_COLOR} style={{ marginTop: 1 }}>
						{phase.error}
					</text>
				) : null}
				{phase.kind === "working" ? (
					<text fg={ACCENT_COLOR} style={{ marginTop: 1 }}>
						{phase.step}
					</text>
				) : null}
			</box>
			<StatusBar
				text={Keymap.hintLine(footerFor(phase, defaults))}
				fg={MUTED_COLOR}
			/>
		</box>
	);
};

const IntroCard = ({ lines }: { lines: readonly string[] }): ReactNode => {
	const [lead, ...rest] = lines;
	return (
		<box style={{ flexDirection: "column" }}>
			<text attributes={TextAttributes.BOLD}>{lead}</text>
			{rest.map((line) => (
				<text key={line}>{line}</text>
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
						<text>
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
const Note = ({ text }: { text: string }): ReactNode => (
	<text fg={MUTED_COLOR}>{`${" ".repeat(LABEL_WIDTH)}${text}`}</text>
);

// `enter` in the footer's key colour, then what it will do, dim.
const EnterLines = ({
	configPath,
	agents,
}: {
	configPath: string;
	agents: number;
}): ReactNode => {
	const { width } = useTerminalDimensions();
	const room = width - ENTER_INDENT - "saves ".length;
	return (
		<box style={{ flexDirection: "column", marginTop: 1 }}>
			{enterLines(elidePath(configPath, room), agents).map((line, index) => (
				<text key={line}>
					{index === 0 ? "enter " : " ".repeat(ENTER_INDENT)}
					<span fg={MUTED_COLOR}>{line}</span>
				</text>
			))}
		</box>
	);
};

const SavedLine = ({ path }: { path: string }): ReactNode => {
	const { width } = useTerminalDimensions();
	const head = "✓ saved ";
	return <text>{`${head}${elidePath(path, width - head.length)}`}</text>;
};

type TextRowProps = {
	label: string;
	value: string;
	focused: boolean;
	onInput: (value: string) => void;
};

const TextRow = ({
	label,
	value,
	focused,
	onInput,
}: TextRowProps): ReactNode => (
	<box style={{ flexDirection: "row", height: 1 }}>
		<text fg={focused ? ACCENT_COLOR : undefined} style={{ flexShrink: 0 }}>
			{`${focused ? "›" : " "} ${label.padEnd(LABEL_WIDTH - 2)}`}
		</text>
		<input
			value={value}
			focused={focused}
			onInput={onInput}
			backgroundColor={INPUT_BG}
			focusedBackgroundColor={SELECTED_BG}
			style={{ width: INPUT_WIDTH, flexShrink: 0 }}
		/>
	</box>
);

type NotedLineProps = {
	head: string;
	note?: string;
	indent: number;
	fg?: string;
};

const NotedLine = ({ head, note, indent, fg }: NotedLineProps): ReactNode => {
	const { width } = useTerminalDimensions();
	if (note === undefined || note === "") return <text fg={fg}>{head}</text>;
	if (fitsBeside(width, head.length, note))
		return <text fg={fg}>{`${head} ${note}`}</text>;
	return (
		<box style={{ flexDirection: "column" }}>
			<text fg={fg}>{head}</text>
			{/* A harness's error can outrun the pane: padding, not spaces, keeps its wrap indented. */}
			<box style={{ paddingLeft: indent }}>
				<text fg={fg ?? MUTED_COLOR}>{note}</text>
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
}: CheckRowProps): ReactNode => (
	<text fg={focused ? ACCENT_COLOR : undefined}>
		{`${focused ? "›" : " "} ${label.padEnd(LABEL_WIDTH - 2)}`}
		<span bg={focused ? SELECTED_BG : undefined}>
			{`[${checked ? "x" : " "}] ${harness}`}
		</span>
	</text>
);

/**
 * Run the setup screen on its own renderer. Resolves true when the config was written and the
 * human asked for the board, false when they left — esc or ctrl-c before confirming writes nothing.
 */
export const startSetup = async (deps: SetupDeps): Promise<boolean> => {
	const renderer = await createCliRenderer({ exitOnCtrlC: true });
	let completed = false;
	try {
		createRoot(renderer).render(
			<ErrorBoundary fallback={(error) => <SetupCrash error={error} />}>
				<SetupScreen
					{...deps}
					onComplete={() => {
						completed = true;
						renderer.destroy();
					}}
					onQuit={() => renderer.destroy()}
				/>
			</ErrorBoundary>,
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
	useKeyboard((key) => {
		if (key.name === "q") renderer.destroy();
	});
	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			<text fg={ERROR_COLOR}>Setup crashed: {error.message}</text>
			<text fg={MUTED_COLOR}>q quit</text>
		</box>
	);
};
