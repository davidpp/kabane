/** @jsxImportSource @opentui/react */
// The harness stopped to ask, and is blocked until it hears back. Two surfaces show the choice —
// the transcript when it is open on the copilot's card, the copilot pane everywhere else — and,
// like the plan, they must read as one block rather than as two renderings that drifted apart.
// Never both at once: one surface owns a fact (see spinner.ts).
//
// The options are numbered rather than moved through with j/k: the dispatch overlay's digits are
// the board's idiom for a short list, and unlike that overlay this one must not own the keyboard —
// the turn behind it still has to be cancellable.
import type { ColorInput } from "@opentui/core";
import type { ReactNode } from "react";
import type { CopilotPermission } from "./ports";
import { Segments } from "./segments";
import { type Theme, useTheme } from "./theme";

const fit = (text: string, room: number): string =>
	text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text;

// `1 Allow once · 2 Reject`: the numbered options, in the order the harness offered them.
const optionsLine = (request: CopilotPermission): string =>
	request.options
		.map((option, index) => `${index + 1} ${option.label}`)
		.join(" · ");

// The questions queued behind the one on screen, said after its title: a harness running tools in
// parallel asks for each before hearing back on any, and the human should know the next is coming.
const waitingNote = (waiting: number): string =>
	waiting > 0 ? ` · ${waiting} more waiting` : "";

// The whole request on ONE row, for the collapsed pane: what is being asked, then how to answer.
// Exported pure so the copy is assertable without a renderer.
export const permissionLine = (
	request: CopilotPermission,
	waiting = 0,
): string =>
	`? ${request.title}${waitingNote(waiting)} · ${optionsLine(request)} · esc decline`;

// How to answer, a part an answer so each can be clicked: each option's key and label in the text
// color, since the label is what the human decides by, and the separators and `esc`'s label muted
// as the footer's are. The `?` before the title is the request, and the only part in the accent:
// the options are answers, not asks.
const answerParts = (
	request: CopilotPermission,
	theme: Theme.Tokens,
	textFg: ColorInput,
): Segments.Segment[][] => [
	...request.options.map((option, index) => [
		...(index > 0 ? [{ text: " · ", fg: theme.muted }] : []),
		{ text: `${index + 1}`, fg: textFg },
		{ text: ` ${option.label}`, fg: textFg },
	]),
	[
		{ text: " · ", fg: theme.muted },
		{ text: "esc", fg: textFg },
		{ text: " decline", fg: theme.muted },
	],
];

const answerSegments = (
	request: CopilotPermission,
	theme: Theme.Tokens,
	textFg: ColorInput,
): Segments.Segment[] => answerParts(request, theme, textFg).flat();

/** A part of a ClickRow, and what a click on it does. */
export type ClickPart = { segments: Segments.Segment[]; onPress?: () => void };

/**
 * One row of parts fitted as one line (Segments.fit), each part its own cell so a click lands on
 * the one it means. A narrow row loses its tail as any row does, and a part cut to nothing is gone.
 */
export const ClickRow = ({
	parts,
	width,
	bg,
}: {
	parts: readonly ClickPart[];
	width: number;
	bg?: string;
}): ReactNode => {
	const owner = parts.flatMap((part, index) => part.segments.map(() => index));
	const fitted = Segments.fit(
		parts.flatMap((part) => part.segments),
		width,
	);
	return (
		<box
			style={{
				flexDirection: "row",
				flexShrink: 0,
				height: 1,
				...(bg ? { backgroundColor: bg } : {}),
			}}
		>
			{parts.map((part, index) => {
				const segments = fitted.filter((_, at) => owner[at] === index);
				return segments.length > 0 ? (
					<text
						// Index keys: a row's parts are positional.
						key={index}
						bg={bg}
						onMouseDown={part.onPress}
						style={{ flexShrink: 0 }}
					>
						{Segments.spans(segments)}
					</text>
				) : null;
			})}
		</box>
	);
};

/** `permissionLine` in its colors: the collapsed pane's one row, and the same words as the block. */
export const permissionSegments = (
	request: CopilotPermission,
	theme: Theme.Tokens,
	textFg: ColorInput,
	waiting = 0,
): Segments.Segment[] => [
	{ text: "? ", fg: theme.accent },
	{ text: request.title, fg: textFg },
	...(waiting > 0 ? [{ text: waitingNote(waiting), fg: theme.muted }] : []),
	{ text: " · ", fg: theme.muted },
	...answerSegments(request, theme, textFg),
];

/**
 * The collapsed row while something else holds the answer keys (BoardNav.askReach): a session
 * question on the view (BoardNav.copilotOutranked), an open prompt, a `/` query. What the copilot
 * asks (a permission's title, a form's message), with the key that reaches it in place of answer
 * keys that would not reach it.
 */
export const outrankedSegments = (
	asked: string,
	theme: Theme.Tokens,
	textFg: ColorInput,
	waiting = 0,
	key = "tab",
): Segments.Segment[] => [
	{ text: "? ", fg: theme.accent },
	{ text: "copilot asks: ", fg: theme.muted },
	{ text: asked, fg: textFg },
	...(waiting > 0 ? [{ text: waitingNote(waiting), fg: theme.muted }] : []),
	{ text: " · ", fg: theme.muted },
	{ text: key, fg: textFg },
	{ text: " to answer", fg: theme.muted },
];

export type PermissionBlockProps = {
	request: CopilotPermission;
	// How many more requests are queued behind this one.
	waiting?: number;
	// Columns the text may take, chrome already subtracted by the caller.
	width: number;
	// The surface's background, so a row inside a panel paints its whole width like its neighbours.
	bg?: string;
	// A click on option `index`, and on `esc decline` (the key router's `escape`): the keys' own
	// paths, so a click and a key can never disagree. Without them the answers are only drawn.
	onPick?: (index: number) => void;
	onKey?: (name: string) => void;
};

export const PermissionBlock = ({
	request,
	waiting = 0,
	width,
	bg,
	onPick,
	onKey,
}: PermissionBlockProps): ReactNode => {
	const theme = useTheme();
	// On a painted surface the text takes the surface's foreground; off one, the terminal's own.
	const textFg = bg ? theme.text : theme.defaultFg;
	const note = waitingNote(waiting);
	return (
		<>
			<text bg={bg} fg={theme.accent}>
				? <span fg={textFg}>{fit(request.title, width - 2 - note.length)}</span>
				{note ? <span fg={theme.muted}>{note}</span> : null}
			</text>
			<ClickRow
				parts={answerParts(request, theme, textFg).map((segments, index) => ({
					segments,
					onPress:
						index < request.options.length
							? onPick && (() => onPick(index))
							: onKey && (() => onKey("escape")),
				}))}
				width={width}
				{...(bg ? { bg } : {})}
			/>
		</>
	);
};
