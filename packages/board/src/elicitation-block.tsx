/** @jsxImportSource @opentui/react */
// The harness stopped to ask the human to fill in a form, and is blocked until it hears back. The
// permission block's visual language, a field at a time: the harness's message verbatim, then the
// field in hand with how to answer it. Choices are numbered as a permission's options are; a
// multi-select shows what is toggled; text and numbers are typed into a one-line input, the one
// thing here that takes the keyboard as text. The keys themselves are nav.ts's
// (elicitation-form.ts); this only draws the draft.
import type { ColorInput } from "@opentui/core";
import type { ReactNode } from "react";
import { ElicitationForm } from "./elicitation-form";
import { FormField } from "./form-field";
import type {
	CopilotElicitation,
	CopilotFormField,
	CopilotFormOption,
} from "./ports";
import { Segments } from "./segments";
import { type Theme, useTheme } from "./theme";

type Segment = Segments.Segment;

const sep = (theme: Theme.Tokens): Segment => ({
	text: " · ",
	fg: theme.muted,
});

// A key in the text color and what it does muted, as the footer and the permission block read.
const keyed = (
	pairs: readonly (readonly [string, string])[],
	theme: Theme.Tokens,
	textFg: ColorInput,
): Segment[] =>
	pairs.flatMap(([key, does], index) => [
		...(index > 0 ? [sep(theme)] : []),
		{ text: key, fg: textFg },
		{ text: ` ${does}`, fg: theme.muted },
	]);

/** The keys that answer the field in hand, in the order the human reaches for them. */
export const answerKeys = (
	field: CopilotFormField | undefined,
): (readonly [string, string])[] => {
	const skip = field && !field.required ? ([["enter", "skip"]] as const) : [];
	const decline = ["esc", "decline"] as const;
	switch (field?.type) {
		case undefined:
			return [["enter", "accept"], decline];
		case "choice":
			return [...skip, decline];
		case "choices":
			return [["enter", "confirm"], decline];
		case "boolean":
			return [["y", "yes"], ["n", "no"], ...skip, decline];
		case "text":
		case "number":
			return [
				["enter", field.required ? "send" : "send, empty skips"],
				decline,
			];
	}
};

// `1 Redis`, or `1 [x] Redis` on a multi-select: the digit in the text color, the rest muted
// unless picked.
const optionSegments = (
	option: CopilotFormOption,
	index: number,
	picked: boolean | undefined,
	theme: Theme.Tokens,
	textFg: ColorInput,
): Segment[] => [
	{ text: `${index + 1}`, fg: textFg },
	...(picked === undefined
		? []
		: [
				{
					text: picked ? " [x]" : " [ ]",
					fg: picked ? theme.accent : theme.muted,
				},
			]),
	{ text: ` ${option.label}`, fg: picked ? textFg : theme.muted },
];

/** The field's title, what it is for, where it sits in the form, and whether it may stay empty. */
const fieldSegments = (
	request: CopilotElicitation,
	field: CopilotFormField,
	at: number,
	theme: Theme.Tokens,
	textFg: ColorInput,
): Segment[] => [
	{ text: field.title, fg: textFg },
	...(field.description
		? [{ text: `: ${field.description}`, fg: theme.muted }]
		: []),
	...(request.fields.length > 1
		? [
				sep(theme),
				{ text: `${at + 1} of ${request.fields.length}`, fg: theme.muted },
			]
		: []),
	...(field.required
		? []
		: [sep(theme), { text: "optional", fg: theme.muted }]),
];

const optionsOf = (
	field: CopilotFormField | undefined,
): readonly CopilotFormOption[] =>
	field?.type === "choice" || field?.type === "choices" ? field.options : [];

export type ElicitationBlockProps = {
	request: CopilotElicitation;
	draft: ElicitationForm.Draft;
	// How many more requests are queued behind this one.
	waiting?: number;
	// Columns the text may take, chrome already subtracted by the caller.
	width: number;
	// The surface's background, so a row inside a panel paints its whole width like its neighbours.
	bg?: string;
	// Whether the form has the keys (BoardNav.askInHand): its input is focused only then.
	inHand: boolean;
	// `enter` in the input, with what it holds.
	onSubmit: (text: string) => void;
};

export const ElicitationBlock = ({
	request,
	draft,
	waiting = 0,
	width,
	bg,
	inHand,
	onSubmit,
}: ElicitationBlockProps): ReactNode => {
	const theme = useTheme();
	const textFg = bg ? theme.text : theme.defaultFg;
	const field = ElicitationForm.field(request, draft);
	const options = optionsOf(field);
	const multi = field?.type === "choices";
	// One option a row once any of them explains itself: the explanation is what the human picks by.
	const listed = options.some((option) => option.description);
	const fieldBg = theme.surface.overlay;
	return (
		<>
			<text bg={bg} fg={textFg} wrapMode="word">
				<span fg={theme.accent}>? </span>
				{request.message}
				{waiting > 0 ? (
					<span fg={theme.muted}>{` · ${waiting} more waiting`}</span>
				) : null}
			</text>
			{field ? (
				<text bg={bg} wrapMode="word">
					{Segments.spans(
						fieldSegments(request, field, draft.at, theme, textFg),
					)}
				</text>
			) : null}
			{listed
				? options.map((option, index) => (
						<text key={option.value} bg={bg} wrapMode="word">
							{Segments.spans(
								optionSegments(
									option,
									index,
									multi ? draft.picked.includes(index) : undefined,
									theme,
									textFg,
								),
							)}
							{option.description ? (
								<span fg={theme.muted}>{`  ${option.description}`}</span>
							) : null}
						</text>
					))
				: null}
			{!listed && options.length > 0 ? (
				<text bg={bg}>
					{Segments.spans(
						Segments.fit(
							options.flatMap((option, index) => [
								...(index > 0 ? [sep(theme)] : []),
								...optionSegments(
									option,
									index,
									multi ? draft.picked.includes(index) : undefined,
									theme,
									textFg,
								),
							]),
							width,
						),
					)}
				</text>
			) : null}
			{ElicitationForm.typed(field) && field ? (
				<box
					style={{
						flexDirection: "row",
						flexShrink: 0,
						height: 1,
						backgroundColor: fieldBg,
						paddingLeft: 1,
						paddingRight: 1,
					}}
				>
					<text bg={fieldBg} fg={theme.muted}>
						▸{" "}
					</text>
					<input
						// A new field is a new input: what was typed for the last one does not carry over.
						key={`${request.id}#${draft.at}`}
						focused={inHand}
						placeholder={FormField.wants(field)}
						placeholderColor={theme.secondary}
						backgroundColor={fieldBg}
						focusedBackgroundColor={fieldBg}
						textColor={theme.text}
						focusedTextColor={theme.text}
						cursorColor={theme.accent}
						// The input's `enter` carries its value; the prop's type also admits a textarea's
						// event, which an input never sends.
						onSubmit={(value: unknown) =>
							onSubmit(typeof value === "string" ? value : "")
						}
						style={{ flexGrow: 1 }}
					/>
				</box>
			) : null}
			{draft.error ? (
				<text bg={bg} fg={theme.failed} wrapMode="word">
					{draft.error}
				</text>
			) : null}
			<text bg={bg}>
				{Segments.spans(
					Segments.fit(keyed(answerKeys(field), theme, textFg), width),
				)}
			</text>
		</>
	);
};

/**
 * The form on ONE row, for a pane that has no room for the block: what is asked, then the way out.
 * Exported pure so the copy is assertable without a renderer.
 */
export const elicitationSegments = (
	request: CopilotElicitation,
	theme: Theme.Tokens,
	textFg: ColorInput,
	waiting = 0,
): Segment[] => [
	{ text: "? ", fg: theme.accent },
	{ text: request.message, fg: textFg },
	...(waiting > 0
		? [{ text: ` · ${waiting} more waiting`, fg: theme.muted }]
		: []),
	sep(theme),
	...keyed([["esc", "decline"]], theme, textFg),
];
