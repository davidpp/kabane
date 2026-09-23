/** @jsxImportSource @opentui/react */
// The first-run screen `cabane` shows on a device with no config: who you are, what this machine is
// called, which detected harnesses get the MCP server, and optionally a scope pin for the repo it
// was opened in. Enter writes the config through the host, runs the installs, and shows each
// harness's outcome; enter again hands over to the board. Everything it decides lives in SetupPlan.
//
// Key arbitration is the copilot pane's: the focused <input> and the one useKeyboard handler both
// see every key, handler first, and the handler preventDefaults the keys it takes (tab, arrows,
// enter, esc, and space on a checkbox row) so the input never acts on them too.

import type { Result } from "@cabane/core";
import { createCliRenderer, TextAttributes } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
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

export type SetupDeps = {
	defaults: SetupPlan.Defaults;
	// Writes the config (and the pin) for this plan; resolves to where it went. The host's business:
	// the config schema is the CLI's, and the board never sees it.
	save: (plan: SetupPlan.Plan) => Promise<Result<string>>;
	// Registers the MCP server in each named harness, one outcome per id.
	install: (ids: readonly string[]) => Promise<SetupPlan.InstallOutcome[]>;
};

type Phase =
	| { kind: "form"; error?: string }
	| { kind: "working"; step: string }
	| {
			kind: "done";
			configPath: string;
			outcomes: SetupPlan.InstallOutcome[];
	  };

const FORM_FOOTER: readonly Keymap.Hint[] = [
	{ key: "tab/↑↓", label: "move" },
	{ key: "space", label: "toggle" },
	{ key: "enter", label: "confirm" },
	{ key: "esc", label: "quit" },
];

const DONE_FOOTER: readonly Keymap.Hint[] = [
	{ key: "enter", label: "open the board" },
	{ key: "q", label: "quit" },
];

export const SYNC_HINT =
	"several machines? cabane init --sync-url … --sync-token … (docs/deploy.md)";
export const NO_HARNESS_HINT =
	"no harness found on PATH · snippets for any MCP client: cabane mcp install --print";

const STATUS_TEXT: Record<SetupPlan.InstallStatus, string> = {
	installed: "✓ installed",
	already: "· already installed",
	failed: "✗ failed",
};

export const outcomeLine = (
	outcome: SetupPlan.InstallOutcome,
	label: string,
): string =>
	[label.padEnd(14), STATUS_TEXT[outcome.status], outcome.message]
		.filter((part) => part !== undefined && part !== "")
		.join(" ");

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
	// form the last render saw: tab, tab, space must toggle the row two below the name.
	const current = useRef(form);
	const update = (next: SetupPlan.Form): void => {
		current.current = next;
		setForm(next);
	};
	const [phase, setPhase] = useState<Phase>({ kind: "form" });

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
			step: `wiring ${planned.value.install.join(", ")}…`,
		});
		const outcomes = await install(planned.value.install);
		setPhase({ kind: "done", configPath: saved.value, outcomes });
	};

	useKeyboard((key) => {
		if (phase.kind === "working") return;
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
		} else if (
			key.name === "space" &&
			(field?.kind === "harness" || field?.kind === "pin")
		) {
			key.preventDefault();
			update(SetupPlan.toggle(current.current, defaults));
		}
	});

	const labelOf = (id: string): string =>
		defaults.harnesses.find((h) => h.id === id)?.label ?? id;

	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			<text>
				<span attributes={TextAttributes.BOLD}>cabane · setup</span>
			</text>
			<box style={{ flexDirection: "column", flexGrow: 1, marginTop: 1 }}>
				{phase.kind === "done" ? (
					<>
						<text>✓ wrote {phase.configPath}</text>
						<box style={{ flexDirection: "column", marginTop: 1 }}>
							{phase.outcomes.map((outcome) => (
								<text
									key={outcome.id}
									fg={outcome.status === "failed" ? ERROR_COLOR : undefined}
								>
									{outcomeLine(outcome, labelOf(outcome.id))}
								</text>
							))}
						</box>
					</>
				) : (
					<SetupForm
						defaults={defaults}
						form={form}
						onName={(name) => update({ ...current.current, name })}
						onDevice={(device) => update({ ...current.current, device })}
					/>
				)}
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
			<text fg={MUTED_COLOR}>{SYNC_HINT}</text>
			<StatusBar
				text={Keymap.hintLine(
					phase.kind === "done" ? DONE_FOOTER : FORM_FOOTER,
				)}
				fg={MUTED_COLOR}
			/>
		</box>
	);
};

type SetupFormProps = {
	defaults: SetupPlan.Defaults;
	form: SetupPlan.Form;
	onName: (name: string) => void;
	onDevice: (device: string) => void;
};

const SetupForm = ({
	defaults,
	form,
	onName,
	onDevice,
}: SetupFormProps): ReactNode => {
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
						note={SetupPlan.actorUri(form.name)}
					/>
				);
			case "device":
				return (
					<TextRow
						key="device"
						label="device"
						value={form.device}
						focused={focused}
						onInput={onDevice}
					/>
				);
			case "harness":
				return (
					<CheckRow
						key={field.harness.id}
						label={field.harness.label}
						checked={form.checked.includes(field.harness.id)}
						focused={focused}
					/>
				);
			case "pin":
				return (
					<box key="pin" style={{ marginTop: 1 }}>
						<CheckRow
							label={`pin this repo's scope · ${field.repo.name} (${field.repo.scopeId})`}
							checked={form.pin}
							focused={focused}
						/>
					</box>
				);
		}
	};
	const [name, device, ...rest] = SetupPlan.fields(defaults).map(row);
	return (
		<box style={{ flexDirection: "column" }}>
			{name}
			{device}
			<text fg={MUTED_COLOR} style={{ marginTop: 1 }}>
				wire the cabane mcp server into
			</text>
			{defaults.harnesses.length === 0 ? (
				<text fg={MUTED_COLOR}>{`  ${NO_HARNESS_HINT}`}</text>
			) : null}
			{rest}
		</box>
	);
};

type TextRowProps = {
	label: string;
	value: string;
	focused: boolean;
	onInput: (value: string) => void;
	note?: string;
};

const TextRow = ({
	label,
	value,
	focused,
	onInput,
	note,
}: TextRowProps): ReactNode => (
	<box style={{ flexDirection: "row", height: 1 }}>
		<text fg={focused ? ACCENT_COLOR : undefined}>
			{`${focused ? "›" : " "} ${label.padEnd(7)}`}
		</text>
		<input
			value={value}
			focused={focused}
			onInput={onInput}
			backgroundColor={INPUT_BG}
			focusedBackgroundColor={SELECTED_BG}
			style={{ width: INPUT_WIDTH }}
		/>
		{note ? <text fg={MUTED_COLOR}>{`  ${note}`}</text> : null}
	</box>
);

type CheckRowProps = { label: string; checked: boolean; focused: boolean };

const CheckRow = ({ label, checked, focused }: CheckRowProps): ReactNode => (
	<text
		fg={focused ? ACCENT_COLOR : undefined}
		bg={focused ? SELECTED_BG : undefined}
	>
		{`${focused ? "›" : " "} [${checked ? "x" : " "}] ${label}`}
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
