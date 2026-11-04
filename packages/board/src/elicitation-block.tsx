/** @jsxImportSource @opentui/react */
// The harness stopped to ask the human to fill in a form, and is blocked until it hears back. The
// permission block's visual language, a field at a time: the harness's message verbatim, then the
// field in hand with how to answer it. Choices are numbered as a permission's options are, one a
// row, the cursor's on the selected surface; a multi-select shows what is toggled; text and numbers are typed into a one-line input, the one
// thing here that takes the keyboard as text. The keys themselves are nav.ts's
// (elicitation-form.ts); this only draws the draft.
import { type ColorInput, TextAttributes } from "@opentui/core";
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

// `1 Redis`, or `1 [x] Redis` on a multi-select. The answer is what the human reads to decide, so the
// digit and the label are both in the text color; only an unpicked box recedes.
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
	{ text: ` ${option.label}`, fg: textFg },
];

/** The field's title as a Label, what it is for, where it sits in the form, and whether it may stay empty. */
const fieldSegments = (
	request: CopilotElicitation,
	field: CopilotFormField,
	at: number,
	theme: Theme.Tokens,
	textFg: ColorInput,
): Segment[] => [
	{ text: field.title, fg: textFg, attributes: TextAttributes.BOLD },
	...(field.description
		? [{ text: `: ${field.description}`, fg: theme.secondary }]
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

// The rows an answer list takes, given how much of its options' descriptions it can show: each
// description whole on its own lines under its label, or cut to the label's row. Never fewer than a
// row an option, because the cursor is a row; so a description is never left out, since its cut
// tail costs no row.
type Notes = "whole" | "inline";

// One row of the answer list, and the option it belongs to: the cursor's option paints every one of
// its rows, its note's included.
type AnswerRow = { line: Segment[]; option: number };

// The answer list at `notes`, a row an option at least. The cursor's option is drawn under the
// Selection Rule, an explicit foreground on every cell, so its labels take the text color off a
// painted surface too.
const answerList = (
	field: CopilotFormField | undefined,
	draft: ElicitationForm.Draft,
	{ notes, width }: { notes: Notes; width: number },
	theme: Theme.Tokens,
	textFg: ColorInput,
): AnswerRow[] => {
	if (field?.type !== "choice" && field?.type !== "choices") return [];
	const cursor = ElicitationForm.cursorOf(draft);
	return field.options.flatMap((option, index) => {
		const label = optionSegments(
			option,
			index,
			field.type === "choices" ? draft.picked.includes(index) : undefined,
			theme,
			index === cursor ? theme.text : textFg,
		);
		const note = option.description;
		const indent = Segments.plain(label).length - option.label.length;
		const lines = !note
			? Segments.wrap(label, width)
			: notes === "inline"
				? [
						Segments.fit(
							[...label, { text: `  ${note}`, fg: theme.secondary }],
							width,
						),
					]
				: [
						...Segments.wrap(label, width),
						...Segments.wrap(
							[
								{ text: " ".repeat(indent), fg: theme.secondary },
								{ text: note, fg: theme.secondary },
							],
							width,
						),
					];
		return lines.map((line) => ({ line, option: index }));
	});
};

// What the block gives up, in order, to stay inside its rows: the blank rows between its groups
// first, since content outranks rhythm, then each description's tail.
type Fit = { gaps: boolean; notes: Notes };
const TIGHTEST: Fit = { gaps: false, notes: "inline" };
const FITS: readonly Fit[] = [
	{ gaps: true, notes: "whole" },
	{ gaps: false, notes: "whole" },
	TIGHTEST,
];

// The harness's message under its `?`, a paragraph at a time, each wrapped by word under the column
// its text starts at, so the left edge holds nothing but the `?`, the digits and the keys.
const messageRows = (
	request: CopilotElicitation,
	waiting: number,
	width: number,
	theme: Theme.Tokens,
	textFg: ColorInput,
): Segment[][] =>
	request.message
		.split("\n")
		.flatMap((paragraph, index, all) =>
			Segments.wrap(
				[
					index === 0
						? { text: "? ", fg: theme.accent }
						: { text: "  ", fg: textFg },
					{ text: paragraph, fg: textFg },
					...(waiting > 0 && index === all.length - 1
						? [{ text: ` · ${waiting} more waiting`, fg: theme.muted }]
						: []),
				],
				width,
			),
		);

export type ElicitationBlockProps = {
	request: CopilotElicitation;
	draft: ElicitationForm.Draft;
	// How many more requests are queued behind this one.
	waiting?: number;
	// Columns the text may take, chrome already subtracted by the caller.
	width: number;
	// The most rows the block may take. It gives up its blank rows, then the tails of its options'
	// descriptions, to stay inside them (FITS).
	rows: number;
	// The surface's background, so a row inside a panel paints its whole width like its neighbours.
	bg?: string;
	// Whether the form has the keys (BoardNav.askInHand): its input is focused only then.
	inHand: boolean;
	// `enter` in the input, with what it holds.
	onSubmit: (text: string) => void;
};

/**
 * Three groups a blank row apart: what is asked (the message and the field in hand), the answers
 * (the options, or the input and why it refused), and the keys. Each option takes a row, the
 * cursor's under the Selection Rule; a described one has its description on the rows under its
 * label, indented to the label's column.
 */
export const ElicitationBlock = ({
	request,
	draft,
	waiting = 0,
	width,
	rows,
	bg,
	inHand,
	onSubmit,
}: ElicitationBlockProps): ReactNode => {
	const theme = useTheme();
	const textFg = bg ? theme.text : theme.defaultFg;
	const field = ElicitationForm.field(request, draft);
	const cursor = ElicitationForm.cursorOf(draft);
	const typed = ElicitationForm.typed(field);
	const fieldBg = theme.surface.overlay;

	const asked = [
		...messageRows(request, waiting, width, theme, textFg),
		...(field
			? Segments.wrap(
					fieldSegments(request, field, draft.at, theme, textFg),
					width,
				)
			: []),
	];
	const answersOf = (notes: Notes): AnswerRow[] =>
		answerList(field, draft, { notes, width }, theme, textFg);
	const refusal = draft.error
		? Segments.wrap([{ text: draft.error, fg: theme.failed }], width)
		: [];
	const keys = [Segments.fit(keyed(answerKeys(field), theme, textFg), width)];
	// The input is one row, outside the segment rows, so it is counted here.
	const answerRows = (answers: readonly AnswerRow[]): number =>
		answers.length + (typed ? 1 : 0) + refusal.length;
	const heightOf = (fit: Fit): number => {
		const answered = answerRows(answersOf(fit.notes));
		const gaps = fit.gaps ? (answered > 0 ? 2 : 1) : 0;
		return asked.length + answered + keys.length + gaps;
	};
	const fit = FITS.find((each) => heightOf(each) <= rows) ?? TIGHTEST;
	const answers = answersOf(fit.notes);
	const gap = (key: string): ReactNode =>
		fit.gaps ? (
			<text key={key} bg={bg}>
				{" "}
			</text>
		) : null;
	// Index keys: a block's rows are positional, and the same row can repeat.
	const lines = (from: Segment[][], key: string): ReactNode[] =>
		from.map((line, index) => (
			<text key={`${key}${index}`} bg={bg}>
				{Segments.spans(line)}
			</text>
		));
	// The cursor's rows padded to the width, so the selected surface spans the row and not the words.
	const answerLines = answers.map(({ line, option }, index) => {
		const selected = option === cursor;
		const used = Segments.plain(line).length;
		return (
			<text
				// Index keys: a block's rows are positional, and the same row can repeat.
				key={`answer${index}`}
				bg={selected ? theme.surface.selected : bg}
			>
				{Segments.spans(
					selected
						? [
								...line,
								{ text: " ".repeat(Math.max(0, width - used)), fg: theme.text },
							]
						: line,
				)}
			</text>
		);
	});
	return (
		<>
			{lines(asked, "asked")}
			{answerRows(answers) > 0 ? gap("before answers") : null}
			{answerLines}
			{typed && field ? (
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
			{lines(refusal, "refusal")}
			{gap("before keys")}
			{lines(keys, "keys")}
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
