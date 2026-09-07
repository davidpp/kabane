/** @jsxImportSource @opentui/react */
// Centered modal overlays: the `a` dispatch picker (one list of host triggers), the `?` help
// sheet. Deliberately the MINIMAL cut of zact-v2's select-modal — no filter, no groups, no
// mouse: the reducers (nav.ts reduceDispatchKey / reduceHelpKey) own all input; these only
// draw their state. Selection highlight follows board.tsx's SELECTED_BG/FG rule — explicit
// bg + fg on the row, NEVER INVERSE (JJAK-1017).
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode } from "react";
import { SELECTED_BG, SELECTED_FG } from "./board";
import { Keymap } from "./keymap";
import type { BoardNav } from "./nav";
import type { TriggerDescriptor } from "./ports";

const MUTED_COLOR = "#6b7280";
// A solid backdrop so the list behind the modal never bleeds through unset cells.
const OVERLAY_BG = "#1c1c1c";
// Dimmed text for unsatisfiable triggers.
const DIMMED_COLOR = "#4b5563";

const DISPATCH_HINT = "enter run · esc close";

// Per-row colors, pure so the highlight contract (explicit bg+fg pair, never inverse) is assertable
// without a renderer — same seam as board.tsx's rowStyle.
export const overlayRowStyle = (
	selected: boolean,
): { bg: string; fg: string } =>
	selected
		? { bg: SELECTED_BG, fg: SELECTED_FG }
		: { bg: OVERLAY_BG, fg: "#c9d1d9" };

export type DispatchOverlayProps = {
	shortId: string;
	overlay: BoardNav.DispatchOverlay;
};

// The `?` help overlay: the FULL keybinding list (footers show only the app-specific subset),
// grouped, in the same centered-modal frame as the dispatch overlay. Pure display — the reducer
// (nav.ts reduceHelpKey) owns open/close.
export const HelpOverlay = (): ReactNode => {
	const { width, height } = useTerminalDimensions();
	const title = "keyboard shortcuts";
	const hint = "? / esc close";
	// One flat render list: group header rows + `key  label` rows (keys padded to a shared column).
	const keyWidth = Math.max(
		...Keymap.HELP_GROUPS.flatMap((g) => g.hints.map((h) => h.key.length)),
	);
	const rows: { text: string; muted: boolean }[] = [];
	for (const group of Keymap.HELP_GROUPS) {
		if (rows.length > 0) rows.push({ text: "", muted: true });
		rows.push({ text: group.title, muted: true });
		for (const h of group.hints) {
			rows.push({
				text: `${h.key.padEnd(keyWidth)}  ${h.label}`,
				muted: false,
			});
		}
	}
	const inner = Math.max(
		title.length,
		hint.length,
		...rows.map((row) => row.text.length),
	);
	const boxWidth = inner + 4;
	const boxHeight = rows.length + 5;
	return (
		<box
			style={{
				position: "absolute",
				left: Math.max(0, Math.floor((width - boxWidth) / 2)),
				top: Math.max(0, Math.floor((height - boxHeight) / 2)),
				width: boxWidth,
				height: Math.min(boxHeight, height),
				zIndex: 100,
				flexDirection: "column",
				border: true,
				borderColor: MUTED_COLOR,
				backgroundColor: OVERLAY_BG,
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<text bg={OVERLAY_BG} fg={SELECTED_FG}>
				{title}
			</text>
			<text bg={OVERLAY_BG}> </text>
			{rows.map((row, i) => (
				<text
					// biome-ignore lint/suspicious/noArrayIndexKey: static list, blank spacer rows repeat.
					key={i}
					bg={OVERLAY_BG}
					fg={row.muted ? MUTED_COLOR : "#c9d1d9"}
				>
					{row.text.padEnd(inner)}
				</text>
			))}
			<text bg={OVERLAY_BG} fg={MUTED_COLOR}>
				{hint}
			</text>
		</box>
	);
};

// Centered modal box helper.
const ModalBox = ({
	width: termW,
	height: termH,
	title,
	hint,
	rows,
	inner,
	children,
}: {
	width: number;
	height: number;
	title: string;
	hint: string;
	rows: number;
	inner: number;
	children: ReactNode;
}): ReactNode => {
	const boxWidth = inner + 4;
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
				border: true,
				borderColor: MUTED_COLOR,
				backgroundColor: OVERLAY_BG,
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<text bg={OVERLAY_BG} fg={SELECTED_FG}>
				{title}
			</text>
			<text bg={OVERLAY_BG}> </text>
			{children}
			<text bg={OVERLAY_BG} fg={MUTED_COLOR}>
				{hint}
			</text>
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
	const title = `dispatch ${shortId}`;
	const { triggers, selected, loading } = overlay;

	if (loading) {
		const inner = Math.max(title.length, DISPATCH_HINT.length, 20);
		return (
			<ModalBox
				width={width}
				height={height}
				title={title}
				hint="esc close"
				rows={1}
				inner={inner}
			>
				<text bg={OVERLAY_BG} fg={MUTED_COLOR}>
					{"loading triggers…".padEnd(inner)}
				</text>
			</ModalBox>
		);
	}

	if (triggers.length === 0) {
		const inner = Math.max(title.length, DISPATCH_HINT.length, 30);
		return (
			<ModalBox
				width={width}
				height={height}
				title={title}
				hint="esc close"
				rows={1}
				inner={inner}
			>
				<text bg={OVERLAY_BG} fg={MUTED_COLOR}>
					{"nothing to dispatch to".padEnd(inner)}
				</text>
			</ModalBox>
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
		DISPATCH_HINT.length,
		...rowLines.map(
			(r) => r.head.length + 3 + r.desc.length + 3 + r.tag.length,
		),
		...previewLines.map((l) => l.length),
		40,
	);

	// Total rows: trigger list + blank + preview.
	const totalRows = rowLines.length + 1 + previewLines.length;

	return (
		<ModalBox
			width={width}
			height={height}
			title={title}
			hint={DISPATCH_HINT}
			rows={totalRows}
			inner={inner}
		>
			{rowLines.map((r, i) => {
				const isSel = i === selected;
				const style = isSel
					? overlayRowStyle(true)
					: { bg: OVERLAY_BG, fg: r.satisfiable ? "#c9d1d9" : DIMMED_COLOR };
				const line = `${r.head}  ${truncateStr(r.desc, inner - r.head.length - r.tag.length - 5)}`;
				return (
					<text key={r.id} bg={style.bg} fg={style.fg}>
						{line.padEnd(inner - r.tag.length - 2)}
						<span fg={MUTED_COLOR}>{r.tag}</span>
						{"  "}
					</text>
				);
			})}
			<text bg={OVERLAY_BG}> </text>
			{previewLines.map((line, i) => (
				<text
					// biome-ignore lint/suspicious/noArrayIndexKey: static preview, lines can repeat.
					key={i}
					bg={OVERLAY_BG}
					fg={MUTED_COLOR}
				>
					{line.padEnd(inner)}
				</text>
			))}
		</ModalBox>
	);
};
