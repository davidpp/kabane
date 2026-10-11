/** @jsxImportSource @opentui/react */
// The board's one multi-line input: OpenTUI's `<textarea>` as a field across the pane, a step above
// the panel it sits on, with the accent cursor of an input waiting on you. The copilot types into it,
// and so does every prompt a card's tab or a question's banner opens, so paste, word motions, ctrl+w,
// undo and multi-line input behave the same everywhere. The textarea owns its buffer: a caller mirrors
// it through `onContentChange` and pushes a whole new value in through the ref (a recalled prompt).
import type { TextareaRenderable } from "@opentui/core";
import { defaultTextareaKeyBindings, TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ReactNode, RefObject } from "react";
import { useTheme } from "./theme";

// Enter sends — the common case by far. A newline is ⇧enter where the terminal reports it and
// ctrl+j everywhere (⇧enter needs the kitty keyboard protocol; ctrl+j is plain ASCII LF).
const KEY_BINDINGS = [
	...defaultTextareaKeyBindings.filter(
		(binding) => binding.action !== "newline" && binding.action !== "submit",
	),
	{ name: "return", action: "submit" as const },
	{ name: "kpenter", action: "submit" as const },
	{ name: "return", shift: true, action: "newline" as const },
	{ name: "j", ctrl: true, action: "newline" as const },
];

// How many rows the field may take: enough to be useful, never enough to bury the view. It keeps its
// floor even on a short terminal — a one-row input is what this field exists to replace.
const MIN_ROWS = 3;
const MAX_ROWS = 8;

/** The field's height for `text` on a terminal `termRows` tall. */
export const fieldRows = (text: string, termRows: number): number => {
	const typed = text === "" ? 1 : text.split("\n").length;
	const room = Math.max(MIN_ROWS, Math.floor(termRows * 0.25));
	return Math.min(Math.max(MIN_ROWS, typed), MAX_ROWS, room);
};

/**
 * A prompt the board opened for a card's action or a typed answer: a raised panel naming what the
 * text is for and where it goes (`inject → claude:JREP-2`), over the field. It sits where the copilot
 * pane does, above the footer, and takes the keyboard the same way.
 */
export const PromptPanel = ({
	title,
	aim,
	placeholder,
	text,
	textareaRef,
	onSubmit,
	onContentChange,
}: {
	title: string;
	aim?: string;
	placeholder: string;
	// The mirror of what is typed, for the field's height.
	text: string;
	textareaRef: RefObject<TextareaRenderable | null>;
	onSubmit: () => void;
	onContentChange: () => void;
}): ReactNode => {
	const { height } = useTerminalDimensions();
	const theme = useTheme();
	const bg = theme.surface.raised;
	return (
		<box
			style={{ flexDirection: "column", flexShrink: 0, backgroundColor: bg }}
		>
			<box style={{ paddingLeft: 1, paddingRight: 1 }}>
				<text bg={bg} fg={theme.muted}>
					<span fg={theme.text} attributes={TextAttributes.BOLD}>
						{title}
					</span>
					{aim ? ` → ${aim}` : ""}
				</text>
			</box>
			<PromptField
				textareaRef={textareaRef}
				initialValue=""
				placeholder={placeholder}
				rows={fieldRows(text, height)}
				onSubmit={onSubmit}
				onContentChange={onContentChange}
			/>
		</box>
	);
};

export const PromptField = ({
	textareaRef,
	initialValue,
	placeholder,
	rows,
	onSubmit,
	onContentChange,
}: {
	textareaRef: RefObject<TextareaRenderable | null>;
	// Seeds a newly mounted field (a draft kept while it was closed); after that the textarea is the
	// source of truth.
	initialValue: string;
	placeholder: string;
	rows: number;
	onSubmit: () => void;
	onContentChange: () => void;
}): ReactNode => {
	const theme = useTheme();
	const fieldBg = theme.surface.overlay;
	return (
		<box
			style={{
				flexDirection: "row",
				flexShrink: 0,
				height: rows,
				backgroundColor: fieldBg,
				paddingLeft: 1,
				paddingRight: 1,
			}}
		>
			<text bg={fieldBg} fg={theme.muted}>
				▸{" "}
			</text>
			<textarea
				ref={textareaRef}
				focused
				keyBindings={KEY_BINDINGS}
				initialValue={initialValue}
				placeholder={placeholder}
				// One step brighter than chrome: on the field's surface, muted falls under 3.5:1.
				placeholderColor={theme.secondary}
				backgroundColor={fieldBg}
				focusedBackgroundColor={fieldBg}
				textColor={theme.text}
				focusedTextColor={theme.text}
				cursorColor={theme.accent}
				wrapMode="word"
				onSubmit={onSubmit}
				onContentChange={onContentChange}
				style={{ flexGrow: 1, height: rows }}
			/>
		</box>
	);
};
