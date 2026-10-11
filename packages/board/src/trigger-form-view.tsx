/** @jsxImportSource @opentui/react */
// The trigger form on screen: the host's preview at the centre (the thing being agreed to), its
// settings beside it in a fixed column, grouped under titles, and the stack of both when the pane
// cannot spare the width. A default's value is dimmed and a changed one is bright with a `•` after
// it, so what this start does differently reads before what it does not. It draws the form's state
// and reports clicks on its fields; trigger-form.ts owns every key and what a click does.
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { Keymap } from "./keymap";
import type { BoardNav } from "./nav";
import {
	DispatchOverlay,
	HintRow,
	overlayBg,
	overlayRowStyle,
} from "./overlay";
import type { PanelLine, PanelTone } from "./ports";
import { Segments } from "./segments";
import { type Theme, useTheme } from "./theme";
import { TriggerForm } from "./trigger-form";

const HINTS = Keymap.footer("dispatchForm");

// The settings column beside the preview: label, value and the change mark, fixed so the preview
// gets every other column. Below this width the two stack.
const SETTINGS_COLS = 46;
const LABEL_COLS = 24;
// What a value keeps, at least, when the labels are long and the pane narrow.
const VALUE_COLS = 10;
const SIDE_BY_SIDE = 100;
const MAX_WIDTH = 140;

/** A form value as its row shows it: booleans as on and off, everything else as written. */
const shown = (value: unknown): string =>
	value === true ? "on" : value === false ? "off" : String(value);

// A group row starts a section: titled, or untitled for ungrouped inputs that follow a group, so
// they do not read as the previous title's.
type Row =
	| { kind: "group"; title?: string }
	| {
			kind: "field";
			index: number;
			label: string;
			value: string;
			changed: boolean;
	  };

/**
 * The inputs as rows, in the host's order, with a section wherever the group changes: a title only
 * spans consecutive inputs, so a group the host lists twice is titled twice.
 */
const formRows = (form: TriggerForm.Form): Row[] => {
	const rows: Row[] = [];
	let group: string | undefined;
	Object.entries(form.trigger.inputs).forEach(([name, input], index) => {
		if (index === 0 ? input.group !== undefined : input.group !== group)
			rows.push({
				kind: "group",
				...(input.group === undefined ? {} : { title: input.group }),
			});
		group = input.group;
		rows.push({
			kind: "field",
			index,
			label: input.label ?? name,
			value: shown(form.values[name]),
			changed: TriggerForm.changed(form, name),
		});
	});
	return rows;
};

/** The rows' height: a field or a title is one row, and every section but the first a gap above. */
const rowsHeight = (rows: readonly Row[]): number =>
	rows.reduce(
		(height, row, at) =>
			height +
			(row.kind === "field"
				? 1
				: (row.title === undefined ? 0 : 1) + (at === 0 ? 0 : 1)),
		0,
	);

const toneFg = (tone: PanelTone | undefined, theme: Theme.Tokens): string => {
	switch (tone) {
		case "muted":
			return theme.muted;
		case "working":
			return theme.working;
		case "done":
			return theme.done;
		case "failed":
			return theme.failed;
		case "accent":
			return theme.accent;
		default:
			return theme.text;
	}
};

const segmentsOf = (line: PanelLine, theme: Theme.Tokens): Segments.Segment[] =>
	line.map((part) => ({
		text: part.text,
		fg: toneFg(part.tone, theme),
		...(part.bold ? { attributes: TextAttributes.BOLD } : {}),
	}));

// One setting: `› label   ‹ value ›` for the field in hand, on the selected surface.
const Field = ({
	row,
	focused,
	cols,
	labelCols,
	onClick,
}: {
	row: Extract<Row, { kind: "field" }>;
	focused: boolean;
	cols: number;
	labelCols: number;
	onClick?: () => void;
}): ReactNode => {
	const theme = useTheme();
	const style = overlayRowStyle(focused, theme);
	const valueCols = Math.max(0, cols - labelCols - 4);
	const value = focused ? `‹ ${row.value} ›` : `  ${row.value}`;
	const label =
		row.label.length < labelCols
			? row.label
			: `${row.label.slice(0, Math.max(0, labelCols - 2))}…`;
	return (
		<text bg={style.bg} fg={theme.secondary} onMouseDown={onClick}>
			<span fg={theme.accent}>{focused ? "› " : "  "}</span>
			{label.padEnd(labelCols)}
			<span
				fg={row.changed || focused ? theme.text : theme.muted}
				attributes={row.changed ? TextAttributes.BOLD : 0}
			>
				{value.slice(0, valueCols).padEnd(valueCols)}
			</span>
			<span fg={theme.text}>{row.changed ? " •" : "  "}</span>
		</text>
	);
};

const Settings = ({
	rows,
	field,
	cols,
	onField,
}: {
	rows: readonly Row[];
	field: number;
	cols: number;
	onField?: (index: number) => void;
}): ReactNode => {
	const theme = useTheme();
	const bg = overlayBg(theme);
	// As wide as the longest label needs, up to LABEL_COLS, leaving the values their room.
	const longest = Math.max(
		0,
		...rows.map((row) => (row.kind === "field" ? row.label.length : 0)),
	);
	const labelCols = Math.max(
		0,
		Math.min(LABEL_COLS, longest + 2, cols - VALUE_COLS - 4),
	);
	return (
		<>
			{rows.map((row, at) =>
				row.kind === "group" ? (
					// Keyed by place: a host may list a group twice.
					<box key={`g${at}`} style={{ marginTop: at === 0 ? 0 : 1 }}>
						{row.title === undefined ? null : (
							<text bg={bg} fg={theme.text} attributes={TextAttributes.BOLD}>
								{row.title}
							</text>
						)}
					</box>
				) : (
					<Field
						key={`f${row.index}`}
						row={row}
						focused={row.index === field}
						cols={cols}
						labelCols={labelCols}
						{...(onField ? { onClick: () => onField(row.index) } : {})}
					/>
				),
			)}
		</>
	);
};

export type TriggerFormViewProps = {
	shortId: string;
	form: TriggerForm.Form;
	// A click on a field, by its place in the trigger's inputs (the reducer's `formField`).
	onField?: (index: number) => void;
};

// The host's preview on the raised step, already wrapped to its room.
const Preview = ({
	rows,
	side,
}: {
	rows: readonly Segments.Segment[][];
	side: boolean;
}): ReactNode => {
	const theme = useTheme();
	return (
		<box
			style={{
				flexDirection: "column",
				flexGrow: side ? 1 : 0,
				flexShrink: 0,
				backgroundColor: theme.surface.raised,
				paddingLeft: 1,
				paddingRight: 1,
				marginBottom: side ? 0 : 1,
			}}
		>
			{rows.map((line, index) => (
				// Index keys: the host's lines are positional and can repeat.
				<text key={`p${index}`} bg={theme.surface.raised}>
					{Segments.spans(line)}
				</text>
			))}
		</box>
	);
};

type Layout = {
	boxWidth: number;
	boxHeight: number;
	inner: number;
	side: boolean;
	settingsCols: number;
	previewRoom: number;
	hints: boolean;
};

/**
 * Where everything goes in a `width` × `height` pane: side by side from SIDE_BY_SIDE columns, else
 * stacked, and the hint row only when it fits on one row (the board's footer under the form names
 * the same keys).
 */
const layoutOf = (
	pane: { width: number; height: number },
	rows: readonly Row[],
	previewRows: (room: number) => number,
): Layout => {
	const boxWidth = Math.max(0, Math.min(pane.width - 2, MAX_WIDTH));
	const inner = Math.max(0, boxWidth - 2);
	const side = boxWidth >= SIDE_BY_SIDE;
	// The preview panel's own padding, and the gap to the settings beside it.
	const previewRoom = (side ? inner - SETTINGS_COLS - 2 : inner) - 2;
	const preview = previewRows(previewRoom);
	const settings = rowsHeight(rows);
	const body = side
		? Math.max(preview, settings)
		: preview + (preview > 0 ? 1 : 0) + settings;
	const hints = Keymap.hintLine(HINTS).length <= inner;
	// The padding above and below, the title and the gap under it, then the gap and the hints.
	const boxHeight = Math.min(pane.height, body + 4 + (hints ? 2 : 0));
	return {
		boxWidth,
		boxHeight,
		inner,
		side,
		settingsCols: side ? SETTINGS_COLS : inner,
		previewRoom,
		hints,
	};
};

// `start loop JREP-1  · 1 changed from the defaults`, held to one row.
const titleOf = (
	form: TriggerForm.Form,
	shortId: string,
	changed: number,
	layout: Layout,
	theme: Theme.Tokens,
): Segments.Segment[] => {
	const said =
		changed === 0
			? "  · defaults"
			: `  · ${changed} changed${layout.side ? " from the defaults" : ""}`;
	return Segments.fit(
		[
			{
				text: `${form.trigger.label} ${shortId}`,
				fg: theme.text,
				attributes: TextAttributes.BOLD,
			},
			{ text: said, fg: theme.muted },
		],
		layout.inner,
	);
};

export const TriggerFormView = ({
	shortId,
	form,
	onField,
}: TriggerFormViewProps): ReactNode => {
	const pane = useTerminalDimensions();
	const theme = useTheme();
	const bg = overlayBg(theme);
	const rows = formRows(form);
	const wrapped = (room: number): Segments.Segment[][] =>
		(form.trigger.preview ?? []).flatMap((line) =>
			Segments.wrap(segmentsOf(line, theme), room),
		);
	const layout = layoutOf(pane, rows, (room) => wrapped(room).length);
	const preview = wrapped(layout.previewRoom);
	const changed = rows.filter((r) => r.kind === "field" && r.changed).length;
	return (
		<box
			style={{
				position: "absolute",
				left: Math.max(0, Math.floor((pane.width - layout.boxWidth) / 2)),
				top: Math.max(0, Math.floor((pane.height - layout.boxHeight) / 2)),
				width: layout.boxWidth,
				height: layout.boxHeight,
				zIndex: 100,
				flexDirection: "column",
				backgroundColor: bg,
				padding: 1,
			}}
		>
			<text bg={bg}>
				{Segments.spans(titleOf(form, shortId, changed, layout, theme))}
			</text>
			<box
				style={{
					flexDirection: layout.side ? "row" : "column",
					flexGrow: 1,
					marginTop: 1,
				}}
			>
				{preview.length > 0 ? (
					<Preview rows={preview} side={layout.side} />
				) : null}
				<box
					style={{
						flexDirection: "column",
						width: layout.settingsCols,
						flexShrink: 0,
						marginLeft: layout.side && preview.length > 0 ? 2 : 0,
					}}
				>
					<Settings
						rows={rows}
						field={form.field}
						cols={layout.settingsCols}
						{...(onField ? { onField } : {})}
					/>
				</box>
			</box>
			{layout.hints ? (
				<box style={{ marginTop: 1 }}>
					<HintRow hints={HINTS} />
				</box>
			) : null}
		</box>
	);
};

/** What `a` floats over the view: the trigger's form when it has one open, else the picker. */
export const DispatchLayer = ({
	shortId,
	overlay,
	onField,
}: {
	shortId: string;
	overlay: BoardNav.DispatchOverlay;
	onField?: (index: number) => void;
}): ReactNode =>
	overlay.form ? (
		<TriggerFormView
			shortId={shortId}
			form={overlay.form}
			{...(onField ? { onField } : {})}
		/>
	) : (
		<DispatchOverlay shortId={shortId} overlay={overlay} />
	);
