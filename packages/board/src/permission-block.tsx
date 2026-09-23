/** @jsxImportSource @opentui/react */
// The harness stopped to ask, and is blocked until it hears back. Two surfaces show the choice —
// the transcript when it is open on the copilot's card, the copilot pane everywhere else — and,
// like the plan, they must read as one block rather than as two renderings that drifted apart.
// Never both at once: one surface owns a fact (see spinner.ts).
//
// The options are numbered rather than moved through with j/k: the dispatch overlay's digits are
// the board's idiom for a short list, and unlike that overlay this one must not own the keyboard —
// the turn behind it still has to be cancellable.
import type { ReactNode } from "react";
import type { CopilotPermission } from "./ports";
import { useTheme } from "./theme";

const fit = (text: string, room: number): string =>
	text.length > room ? `${text.slice(0, Math.max(0, room - 1))}…` : text;

// `1 Allow once · 2 Reject`: the numbered options, in the order the harness offered them.
export const optionsLine = (request: CopilotPermission): string =>
	request.options
		.map((option, index) => `${index + 1} ${option.label}`)
		.join(" · ");

// The whole request on ONE row, for the collapsed pane: what is being asked, then how to answer.
// Exported pure so the copy is assertable without a renderer.
export const permissionLine = (request: CopilotPermission): string =>
	`? ${request.title} · ${optionsLine(request)} · esc decline`;

export type PermissionBlockProps = {
	request: CopilotPermission;
	// Columns the text may take, chrome already subtracted by the caller.
	width: number;
	// The surface's background, so a row inside a panel paints its whole width like its neighbours.
	bg?: string;
};

export const PermissionBlock = ({
	request,
	width,
	bg,
}: PermissionBlockProps): ReactNode => {
	const theme = useTheme();
	// On a painted surface the text takes the surface's foreground; off one, the terminal's own.
	const textFg = bg ? theme.text : theme.defaultFg;
	return (
		<>
			<text bg={bg} fg={theme.accent}>
				? <span fg={textFg}>{fit(request.title, width - 2)}</span>
			</text>
			<text bg={bg} fg={theme.accent}>
				{fit(optionsLine(request), width)}
				<span fg={theme.muted}> · esc decline</span>
			</text>
		</>
	);
};
