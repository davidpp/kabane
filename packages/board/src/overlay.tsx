/** @jsxImportSource @opentui/react */
// The overlays: the `a` dispatch picker (one list of host triggers, centered) and the `?` sheet (the
// keys of the view in hand, anchored at the bottom, which-key style). Deliberately minimal — no
// filter, no mouse: the reducers (nav.ts reduceDispatchKey / reduceHelpKey) own all input; these only
// draw their state, and every hint they show comes from Keymap. Frameless: herdr and the terminal
// already draw the pane's lines, so an overlay is set apart by the overlay surface and a cell of
// padding, never a border. Selection highlight follows board.tsx's rowStyle rule — explicit bg + fg
// on the row, NEVER INVERSE (JJAK-1017).
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode, RefObject } from "react";
import { StatusBar } from "./footer";
import { Keymap } from "./keymap";
import type { BoardNav } from "./nav";
import type { TriggerDescriptor } from "./ports";
import { type Theme, useTheme } from "./theme";

// A solid backdrop so the list behind the overlay never bleeds through unset cells: the overlay step,
// one above the raised panels it floats over.
const overlayBg = (theme: Theme.Tokens): string => theme.surface.overlay;

const DISPATCH_HINTS = Keymap.footer("dispatch", { ready: true });
// Loading, or nothing to pick: only the way out does anything.
const CLOSE_HINTS = Keymap.footer("dispatch", { ready: false });

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

// One row of the `?` sheet, laid out: a group title, a gap between groups, or a binding with its key
// padded to the sheet's key column. Pure, so every row's width is checkable without a renderer.
export type SheetLine =
	| { kind: "title"; text: string; primary: boolean }
	| { kind: "gap" }
	| { kind: "row"; key: string; label: string; available: boolean };

export const sheetLines = (
	groups: readonly Keymap.SheetGroup[],
): SheetLine[] => {
	const keyWidth = Math.max(
		0,
		...groups.flatMap((group) => group.rows.map((row) => row.key.length)),
	);
	return groups.flatMap((group, index): SheetLine[] => [
		...(index > 0 ? [{ kind: "gap" } as const] : []),
		{ kind: "title", text: group.title, primary: index === 0 },
		...group.rows.map(
			(row): SheetLine => ({
				kind: "row",
				key: row.key.padEnd(keyWidth),
				label: row.label,
				available: row.available,
			}),
		),
	]);
};

/** Columns a sheet line takes, before padding. */
export const sheetLineWidth = (line: SheetLine): number =>
	line.kind === "row"
		? line.key.length + 2 + line.label.length
		: line.kind === "title"
			? line.text.length
			: 0;

export type HelpSheetProps = {
	// Whose keys to list (BoardNav.sheetContext) and what is true right now (keySituation).
	context: Keymap.ContextId;
	situation: Keymap.Situation;
	// The sheet's own scrollbox, which j/k move (the `helpScroll` effect). app.tsx holds the ref.
	scrollRef?: RefObject<ScrollBoxRenderable | null>;
};

// The `?` sheet, which-key style: across the pane at the bottom, the keys of the view in hand under
// its name, then the keys that work everywhere. A key that does nothing right now is faint rather
// than gone, so the sheet teaches the whole view and says what works now. As tall as its content up
// to the pane, less the header row, and scrollable past that; short, it leaves the view above it in
// sight. Its last row is its own footer: how to scroll it and close it.
export const HelpSheet = ({
	context,
	situation,
	scrollRef,
}: HelpSheetProps): ReactNode => {
	const { width, height } = useTerminalDimensions();
	const theme = useTheme();
	const bg = overlayBg(theme);
	const lines = sheetLines(Keymap.sheet(context, situation));
	const inner = Math.max(0, width - 2);
	// The padding row on top, every line, then the sheet's footer row.
	const wanted = lines.length + 2;
	const room = Math.max(3, height - 1);
	const sheetHeight = Math.min(wanted, room);
	const scrollable = wanted > room;
	const hints = Keymap.footer("help", { scrollable });
	return (
		<box
			style={{
				position: "absolute",
				left: 0,
				top: Math.max(0, height - sheetHeight),
				width,
				height: sheetHeight,
				zIndex: 100,
				flexDirection: "column",
				backgroundColor: bg,
			}}
		>
			{/* A scrollbar only when there is something to scroll: otherwise it is chrome for nothing. */}
			<scrollbox
				ref={scrollRef}
				style={{ flexGrow: 1 }}
				verticalScrollbarOptions={{ visible: scrollable }}
			>
				<box
					style={{
						flexDirection: "column",
						paddingTop: 1,
						paddingLeft: 1,
						paddingRight: 1,
						backgroundColor: bg,
					}}
				>
					{lines.map((line, i) => (
						<SheetRow
							// biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, and gap rows repeat.
							key={i}
							line={line}
							inner={inner}
						/>
					))}
				</box>
			</scrollbox>
			<StatusBar hints={hints} />
		</box>
	);
};

const SheetRow = ({
	line,
	inner,
}: {
	line: SheetLine;
	inner: number;
}): ReactNode => {
	const theme = useTheme();
	const bg = overlayBg(theme);
	const pad = " ".repeat(Math.max(0, inner - sheetLineWidth(line)));
	if (line.kind === "gap") return <text bg={bg}>{" ".repeat(inner)}</text>;
	if (line.kind === "title")
		return (
			<text
				bg={bg}
				fg={line.primary ? theme.text : theme.muted}
				attributes={TextAttributes.BOLD}
			>
				{line.text}
				{pad}
			</text>
		);
	// Two-tone as the footer is, and faint across the row when the key does nothing right now.
	return (
		<text bg={bg} fg={line.available ? theme.muted : theme.faint}>
			<span fg={line.available ? theme.text : theme.faint}>{line.key}</span>
			{`  ${line.label}`}
			{pad}
		</text>
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
