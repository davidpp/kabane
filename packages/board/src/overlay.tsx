/** @jsxImportSource @opentui/react */
// Centered overlays: the `a` dispatch picker (one list of host triggers), the `?` help sheet.
// Deliberately the MINIMAL cut of zact-v2's select-modal — no filter, no groups, no mouse: the
// reducers (nav.ts reduceDispatchKey / reduceHelpKey) own all input; these only draw their state.
// Frameless: herdr and the terminal already draw the pane's lines, so an overlay is set apart by
// the overlay surface and a cell of padding, never a border. Selection highlight follows board.tsx's
// rowStyle rule — explicit bg + fg on the row, NEVER INVERSE (JJAK-1017).
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { Keymap } from "./keymap";
import type { BoardNav } from "./nav";
import type { TriggerDescriptor } from "./ports";
import { type Theme, useTheme } from "./theme";

// A solid backdrop so the list behind the overlay never bleeds through unset cells: the overlay step,
// one above the raised panels it floats over.
const overlayBg = (theme: Theme.Tokens): string => theme.surface.overlay;

const DISPATCH_HINTS: readonly Keymap.Hint[] = [
	{ key: "enter", label: "run" },
	{ key: "esc", label: "close" },
];
const CLOSE_HINTS: readonly Keymap.Hint[] = [{ key: "esc", label: "close" }];
const HELP_HINTS: readonly Keymap.Hint[] = [{ key: "? / esc", label: "close" }];

const hintsLength = (hints: readonly Keymap.Hint[]): number =>
	Keymap.hintLine(hints).length;

// A hint row two-tone, as the footer draws it: the key in the overlay's foreground, the label muted.
const HintRow = ({ hints }: { hints: readonly Keymap.Hint[] }): ReactNode => {
	const theme = useTheme();
	const bg = overlayBg(theme);
	return (
		<text bg={bg} fg={theme.muted}>
			{hints.map((hint, index) => (
				<span key={hint.key}>
					{index > 0 ? " · " : ""}
					<span fg={theme.text}>{hint.key}</span> {hint.label}
				</span>
			))}
		</text>
	);
};

// The overlay's title in Title weight.
const Title = ({ text }: { text: string }): ReactNode => {
	const theme = useTheme();
	return (
		<text
			bg={overlayBg(theme)}
			fg={theme.text}
			attributes={TextAttributes.BOLD}
		>
			{text}
		</text>
	);
};

// Per-row colors, pure so the highlight contract (explicit bg+fg pair, never inverse) is assertable
// without a renderer — same seam as board.tsx's rowStyle.
export const overlayRowStyle = (
	selected: boolean,
	theme: Theme.Tokens,
): { bg: string; fg: string } =>
	selected
		? { bg: theme.surface.selected, fg: theme.text }
		: { bg: overlayBg(theme), fg: theme.text };

export type DispatchOverlayProps = {
	shortId: string;
	overlay: BoardNav.DispatchOverlay;
};

// The `?` help overlay: the FULL keybinding list (footers show only the app-specific subset),
// grouped, in the same centered-modal frame as the dispatch overlay. Pure display — the reducer
// (nav.ts reduceHelpKey) owns open/close.
export const HelpOverlay = (): ReactNode => {
	const { width, height } = useTerminalDimensions();
	const theme = useTheme();
	const bg = overlayBg(theme);
	const title = "keyboard shortcuts";
	// One flat render list: group titles + `key  label` rows (keys padded to a shared column).
	const keyWidth = Math.max(
		...Keymap.HELP_GROUPS.flatMap((g) => g.hints.map((h) => h.key.length)),
	);
	type HelpRow =
		| { kind: "gap" }
		| { kind: "group"; title: string }
		| { kind: "hint"; key: string; label: string };
	const rows: HelpRow[] = [];
	for (const group of Keymap.HELP_GROUPS) {
		if (rows.length > 0) rows.push({ kind: "gap" });
		rows.push({ kind: "group", title: group.title });
		for (const h of group.hints)
			rows.push({ kind: "hint", key: h.key.padEnd(keyWidth), label: h.label });
	}
	const rowLength = (row: HelpRow): number =>
		row.kind === "hint"
			? row.key.length + 2 + row.label.length
			: row.kind === "group"
				? row.title.length
				: 0;
	const inner = Math.max(
		title.length,
		hintsLength(HELP_HINTS),
		...rows.map(rowLength),
	);
	return (
		<OverlayBox
			width={width}
			height={height}
			title={title}
			hints={HELP_HINTS}
			rows={rows.length}
			inner={inner}
		>
			{rows.map((row, i) => (
				<text
					// biome-ignore lint/suspicious/noArrayIndexKey: static list, blank spacer rows repeat.
					key={i}
					bg={bg}
					fg={theme.muted}
					attributes={row.kind === "group" ? TextAttributes.BOLD : undefined}
				>
					{row.kind === "hint" ? (
						<>
							<span fg={theme.text}>{row.key}</span>
							{`  ${row.label}`.padEnd(inner - row.key.length)}
						</>
					) : row.kind === "group" ? (
						<span fg={theme.text}>{row.title.padEnd(inner)}</span>
					) : (
						" ".repeat(inner)
					)}
				</text>
			))}
		</OverlayBox>
	);
};

// Centered, frameless overlay helper: the overlay surface, one cell of padding all round, the title,
// a blank row, the body, then its hints.
const OverlayBox = ({
	width: termW,
	height: termH,
	title,
	hints,
	rows,
	inner,
	children,
}: {
	width: number;
	height: number;
	title: string;
	hints: readonly Keymap.Hint[];
	rows: number;
	inner: number;
	children: ReactNode;
}): ReactNode => {
	const theme = useTheme();
	const bg = overlayBg(theme);
	const boxWidth = inner + 2;
	// Padding above and below, the title, the blank under it, the body, the hint row.
	const boxHeight = rows + 5;
	return (
		<box
			style={{
				position: "absolute",
				left: Math.max(0, Math.floor((termW - boxWidth) / 2)),
				top: Math.max(0, Math.floor((termH - boxHeight) / 2)),
				width: boxWidth,
				height: Math.min(boxHeight, termH),
				zIndex: 100,
				flexDirection: "column",
				backgroundColor: bg,
				padding: 1,
			}}
		>
			<Title text={title} />
			<text bg={bg}> </text>
			{children}
			<HintRow hints={hints} />
		</box>
	);
};

// Truncate to fit the picker width.
const truncateStr = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;

// The preview block under the list: description, inputs, and the hint when unsatisfiable. Exported
// pure so the copy is assertable without a renderer.
export const triggerPreview = (trigger: TriggerDescriptor): string[] => {
	const lines: string[] = [];
	const desc = trigger.description || "(no description)";
	lines.push(...desc.split("\n").slice(0, 4));
	const inputEntries = Object.entries(trigger.inputs);
	if (inputEntries.length > 0) {
		lines.push("");
		lines.push("inputs:");
		for (const [name, param] of inputEntries) {
			const suffix = param.required
				? " (required)"
				: param.default !== undefined
					? ` = ${String(param.default)}`
					: "";
			lines.push(`  ${name}: ${param.type}${suffix}`);
		}
	}
	if (!trigger.satisfiable) {
		lines.push("");
		lines.push(trigger.hint ?? "needs inputs the board cannot supply");
	}
	return lines;
};

export const DispatchOverlay = ({
	shortId,
	overlay,
}: DispatchOverlayProps): ReactNode => {
	const { width, height } = useTerminalDimensions();
	const theme = useTheme();
	const bg = overlayBg(theme);
	const title = `dispatch ${shortId}`;
	const { triggers, selected, loading } = overlay;

	if (loading) {
		const inner = Math.max(title.length, hintsLength(DISPATCH_HINTS), 20);
		return (
			<OverlayBox
				width={width}
				height={height}
				title={title}
				hints={CLOSE_HINTS}
				rows={1}
				inner={inner}
			>
				<text bg={bg} fg={theme.muted}>
					{"loading triggers…".padEnd(inner)}
				</text>
			</OverlayBox>
		);
	}

	if (triggers.length === 0) {
		const inner = Math.max(title.length, hintsLength(DISPATCH_HINTS), 30);
		return (
			<OverlayBox
				width={width}
				height={height}
				title={title}
				hints={CLOSE_HINTS}
				rows={1}
				inner={inner}
			>
				<text bg={bg} fg={theme.muted}>
					{"nothing to dispatch to".padEnd(inner)}
				</text>
			</OverlayBox>
		);
	}

	const selectedTrigger = triggers[selected];
	const previewLines = selectedTrigger ? triggerPreview(selectedTrigger) : [];

	// Row lines: `n label  description   source` — index n renders with hotkey n+1, matching the
	// reducer's digit mapping.
	const maxLabelLen = Math.max(...triggers.map((t) => t.label.length));
	const rowLines = triggers.map((t, i) => ({
		id: t.id,
		head: `${i + 1} ${t.label.padEnd(maxLabelLen)}`,
		desc: t.description ?? "",
		tag: t.source ?? "",
		satisfiable: t.satisfiable,
	}));
	const inner = Math.max(
		title.length,
		hintsLength(DISPATCH_HINTS),
		...rowLines.map(
			(r) => r.head.length + 3 + r.desc.length + 3 + r.tag.length,
		),
		...previewLines.map((l) => l.length),
		40,
	);

	// Total rows: trigger list + blank + preview.
	const totalRows = rowLines.length + 1 + previewLines.length;

	return (
		<OverlayBox
			width={width}
			height={height}
			title={title}
			hints={DISPATCH_HINTS}
			rows={totalRows}
			inner={inner}
		>
			{rowLines.map((r, i) => {
				const isSel = i === selected;
				const style = isSel
					? overlayRowStyle(true, theme)
					: { bg, fg: r.satisfiable ? theme.text : theme.faint };
				const line = `${r.head}  ${truncateStr(r.desc, inner - r.head.length - r.tag.length - 5)}`;
				return (
					<text key={r.id} bg={style.bg} fg={style.fg}>
						{line.padEnd(inner - r.tag.length - 2)}
						<span fg={theme.muted}>{r.tag}</span>
						{"  "}
					</text>
				);
			})}
			<text bg={bg}> </text>
			{previewLines.map((line, i) => (
				<text
					// biome-ignore lint/suspicious/noArrayIndexKey: static preview, lines can repeat.
					key={i}
					bg={bg}
					fg={theme.muted}
				>
					{line.padEnd(inner)}
				</text>
			))}
		</OverlayBox>
	);
};
