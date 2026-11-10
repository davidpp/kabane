/** @jsxImportSource @opentui/react */
// The settings view on screen: across the pane, every setting under its namespace and then its
// group, each row its label, its value and the one word for the layer it comes from (`default`
// dimmed). The row in hand's detail opens under it: the file, what each word means, and what
// the layers under it set; on a row it can change, `enter` opens its editor: the new value, the layer
// it goes to and what that layer means, and the y/n a save to the repo asks. It draws
// settings-view.ts's state and reports clicks on rows; that module owns every key and what a click
// does.
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { type ReactNode, useEffect, useRef } from "react";
import { StatusBar } from "./footer";
import { Grid } from "./grid";
import { GridRow } from "./grid-view";
import { Keymap } from "./keymap";
import { overlayBg } from "./overlay";
import type { SettingLayer, SettingRow } from "./ports";
import { Segments } from "./segments";
import { SettingsView } from "./settings-view";
import { useTheme } from "./theme";

// What a value keeps, at least, when the labels are long and the pane narrow.
const VALUE_COLS = 8;
// ` default`, the longest layer word, and the space before it.
const BADGE_COLS = 8;
// The cursor's `› `, under its group's title, before every row.
const GUTTER = 4;
// A detail line starts under its row's label, a step in.
const DETAIL_INDENT = GUTTER + 2;

const HOW_TO_CHANGE =
	"The copilot (A) changes settings too, and kabane config set adds a record's entries.";

/** `text` in rows of at most `width` columns, broken where `Segments.wrap` breaks a line. */
const wrap = (text: string, width: number): string[] =>
	width <= 0 || text === ""
		? []
		: Segments.wrap([{ text, fg: "" }], width).map(Segments.plain);

/** `text` held to `cols`, cut with `…` where `Segments.fit` cuts it, and padded to them. */
const clip = (text: string, cols: number): string =>
	Segments.plain(Segments.fit([{ text, fg: "" }], cols)).padEnd(
		Math.max(0, cols),
	);

const markOf = (row: SettingRow): string =>
	row.readOnly ? " read-only" : row.protected ? " protected" : "";

// A title wherever the namespace or the group changes: the rows come ordered (SettingsView.ordered).
const linesOf = (rows: readonly SettingRow[]): Grid.Line<SettingRow>[] =>
	Grid.sections(rows, [SettingsView.namespaceOf, (row) => row.group]);

const rowId = (index: number): string => `setting-${index}`;

const Row = ({
	row,
	index,
	selected,
	detail,
	edit,
	said,
	inner,
	labelCols,
	onClick,
}: {
	row: SettingRow;
	index: number;
	selected: boolean;
	detail: boolean;
	edit: SettingsView.Edit | undefined;
	said: SettingsView.Said | undefined;
	inner: number;
	labelCols: number;
	onClick?: () => void;
}): ReactNode => {
	const theme = useTheme();
	const mark = markOf(row);
	const valueCols = Math.max(0, inner - GUTTER - labelCols - BADGE_COLS);
	const value = clip(
		SettingsView.display(row),
		Math.max(0, valueCols - mark.length),
	);
	const unset = row.value === null || row.value === undefined;
	return (
		<box id={rowId(index)} style={{ flexDirection: "column" }}>
			<GridRow
				selected={selected}
				indent={GUTTER - 2}
				label={row.label}
				labelCols={labelCols}
				onClick={onClick}
			>
				<span fg={unset ? theme.muted : theme.text}>{value}</span>
				<span fg={theme.faint}>{mark.slice(0, valueCols)}</span>
				<span
					fg={row.layer === "default" ? theme.faint : theme.text}
					attributes={row.layer === "default" ? 0 : TextAttributes.BOLD}
				>
					{row.layer.padStart(BADGE_COLS)}
				</span>
			</GridRow>
			{selected && detail ? (
				<Lines
					lines={SettingsView.detail(row)}
					inner={inner}
					fg={theme.muted}
				/>
			) : null}
			{selected && edit ? <Editor row={row} edit={edit} inner={inner} /> : null}
			{selected && said ? (
				<Lines
					lines={said.lines}
					inner={inner}
					fg={said.warn ? theme.accent : theme.done}
				/>
			) : null}
		</box>
	);
};

/** Lines under a row, a step in, each wrapped to the pane. */
const Lines = ({
	lines,
	inner,
	fg,
}: {
	lines: readonly string[];
	inner: number;
	fg: string;
}): ReactNode => {
	const bg = overlayBg(useTheme());
	return (
		<>
			{lines
				.flatMap((line) => wrap(line, inner - DETAIL_INDENT))
				.map((line, at) => (
					// Index keys: wrapped lines can repeat.
					<text key={at} bg={bg} fg={fg}>
						{" ".repeat(DETAIL_INDENT)}
						{line.padEnd(inner - DETAIL_INDENT)}
					</text>
				))}
		</>
	);
};

/** What the editor would write: the stepped value, the typed one (a secret masked), or none. */
const pending = (row: SettingRow, edit: SettingsView.Edit): string => {
	const { change } = edit;
	switch (change.type) {
		case "step":
			return `‹ ${SettingsView.display({ ...row, value: change.value })} ›`;
		case "type":
			return `${row.secret ? "•".repeat(change.text.length) : change.text}▏`;
		case "unset":
			return `remove it from ${edit.layer}`;
	}
};

/** The layers a save can go to, the one picked marked, then what it means. */
const LayerPicker = ({
	row,
	layer,
	inner,
}: {
	row: SettingRow;
	layer: SettingLayer;
	inner: number;
}): ReactNode => {
	const theme = useTheme();
	const bg = overlayBg(theme);
	const cols = inner - DETAIL_INDENT;
	const words = row.layers.map((each) =>
		each === layer ? `[${each}]` : ` ${each} `,
	);
	const used = 4 + words.join(" ").length;
	return (
		<>
			<text bg={bg} fg={theme.muted}>
				{" ".repeat(DETAIL_INDENT)}
				{"to  "}
				{row.layers.map((each, at) => (
					<span
						key={each}
						fg={each === layer ? theme.accent : theme.muted}
						attributes={each === layer ? TextAttributes.BOLD : 0}
					>
						{at > 0 ? " " : ""}
						{words[at]}
					</span>
				))}
				{" ".repeat(Math.max(0, cols - used))}
			</text>
			<Lines
				lines={[SettingsView.TARGET_MEANING[layer]]}
				inner={inner}
				fg={theme.muted}
			/>
		</>
	);
};

/** The row in hand's editor, under its detail. */
const Editor = ({
	row,
	edit,
	inner,
}: {
	row: SettingRow;
	edit: SettingsView.Edit;
	inner: number;
}): ReactNode => {
	const theme = useTheme();
	const bg = overlayBg(theme);
	const cols = inner - DETAIL_INDENT;
	const value = clip(
		edit.change.type === "unset"
			? pending(row, edit)
			: `new  ${pending(row, edit)}`,
		cols,
	);
	return (
		<box style={{ flexDirection: "column", marginTop: 1 }}>
			<text bg={bg} fg={theme.text} attributes={TextAttributes.BOLD}>
				{" ".repeat(DETAIL_INDENT)}
				{value}
			</text>
			{edit.error ? (
				<Lines lines={[edit.error]} inner={inner} fg={theme.failed} />
			) : null}
			<LayerPicker row={row} layer={edit.layer} inner={inner} />
			{edit.confirm ? (
				<Lines
					lines={[...SettingsView.asks(row, edit), "Save it? y/n"]}
					inner={inner}
					fg={theme.accent}
				/>
			) : null}
			{edit.saving ? (
				<Lines lines={["saving…"]} inner={inner} fg={theme.muted} />
			) : null}
		</box>
	);
};

export type SettingsOverlayProps = {
	view: SettingsView.View;
	// A click on a row, by its place in the view's rows (the reducer's `settingsRow`).
	onRow?: (index: number) => void;
};

// What the view says in place of rows: still reading, nothing to read from, or the failure.
const Message = ({
	view,
	inner,
}: {
	view: SettingsView.View;
	inner: number;
}): ReactNode => {
	const theme = useTheme();
	const bg = overlayBg(theme);
	const { rows } = view;
	const [text, fg] =
		rows.type === "loading"
			? ["reading settings…", theme.muted]
			: rows.type === "unavailable"
				? ["settings are not available here", theme.muted]
				: rows.type === "failed"
					? [rows.error, theme.failed]
					: ["no settings", theme.muted];
	return (
		<>
			{wrap(text, inner).map((line, at) => (
				// Index keys: wrapped lines can repeat.
				<text key={at} bg={bg} fg={fg}>
					{line.padEnd(inner)}
				</text>
			))}
		</>
	);
};

export const SettingsOverlay = ({
	view,
	onRow,
}: SettingsOverlayProps): ReactNode => {
	const { width, height } = useTerminalDimensions();
	const theme = useTheme();
	const bg = overlayBg(theme);
	const scrollRef = useRef<ScrollBoxRenderable | null>(null);
	const inner = Math.max(0, width - 2);
	// The rows leave the scrollbar its column, and a space before it.
	const listCols = Math.max(0, inner - 2);
	const rows = view.rows.type === "ready" ? view.rows.rows : [];
	const hints = Keymap.footer("settings", SettingsView.situation(view));
	const labelCols = Grid.labelCols(
		rows.map((row) => row.label),
		listCols,
		GUTTER + VALUE_COLS + BADGE_COLS,
	);
	const { selected, detail, edit, said } = view;
	// The row in hand stays on screen, its detail and its editor with it.
	useEffect(() => {
		scrollRef.current?.scrollChildIntoView(rowId(selected));
	}, [selected, detail, edit, said]);
	return (
		<box
			style={{
				position: "absolute",
				left: 0,
				top: 0,
				width,
				height,
				zIndex: 100,
				flexDirection: "column",
				backgroundColor: bg,
			}}
		>
			<box
				style={{
					flexDirection: "column",
					flexGrow: 1,
					paddingTop: 1,
					paddingLeft: 1,
					paddingRight: 1,
					backgroundColor: bg,
				}}
			>
				<box style={{ flexShrink: 0, height: 2 }}>
					<text bg={bg} fg={theme.text} attributes={TextAttributes.BOLD}>
						{"settings".padEnd(inner)}
					</text>
				</box>
				<scrollbox ref={scrollRef} style={{ flexGrow: 1 }}>
					{rows.length === 0 ? (
						<Message view={view} inner={listCols} />
					) : (
						linesOf(rows).map((line, at) =>
							line.kind === "item" ? (
								<Row
									key={line.item.key}
									row={line.item}
									index={line.index}
									selected={line.index === selected}
									detail={detail}
									edit={edit?.key === line.item.key ? edit : undefined}
									said={said?.key === line.item.key ? said : undefined}
									inner={listCols}
									labelCols={labelCols}
									{...(onRow ? { onClick: () => onRow(line.index) } : {})}
								/>
							) : (
								<box
									// Keyed by place: a group's name repeats across namespaces.
									key={`${line.depth}${at}`}
									style={{
										marginTop: line.depth === 0 && at > 0 ? 1 : 0,
									}}
								>
									<text
										bg={bg}
										fg={line.depth === 0 ? theme.text : theme.muted}
										attributes={TextAttributes.BOLD}
									>
										{"  ".repeat(line.depth)}
										{line.title}
									</text>
								</box>
							),
						)
					)}
				</scrollbox>
				<box style={{ flexShrink: 0, flexDirection: "column" }}>
					{wrap(HOW_TO_CHANGE, inner).map((line, at) => (
						// Index keys: wrapped lines can repeat.
						<text key={at} bg={bg} fg={theme.muted}>
							{line.padEnd(inner)}
						</text>
					))}
				</box>
			</box>
			<StatusBar hints={hints} />
		</box>
	);
};
