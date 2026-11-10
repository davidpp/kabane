/** @jsxImportSource @opentui/react */
// The grid's row on screen, for the trigger form and the settings view: the cursor, the label in
// its column, then whatever the surface shows of the value. Selected, it sits on the selected
// surface. A click on it is reported; what the click does is the surface's reducer's.
import type { ReactNode } from "react";
import { Grid } from "./grid";
import { overlayRowStyle } from "./overlay";
import { useTheme } from "./theme";

export const GridRow = ({
	id,
	selected,
	indent,
	label,
	labelCols,
	onClick,
	children,
}: {
	id?: string;
	selected: boolean;
	// Columns before the cursor: a row under a nested title steps in.
	indent: number;
	label: string;
	labelCols: number;
	onClick?: (() => void) | undefined;
	children: ReactNode;
}): ReactNode => {
	const theme = useTheme();
	const style = overlayRowStyle(selected, theme);
	return (
		<text
			{...(id === undefined ? {} : { id })}
			bg={style.bg}
			fg={theme.secondary}
			onMouseDown={onClick}
		>
			<span fg={theme.accent}>
				{" ".repeat(indent)}
				{selected ? "› " : "  "}
			</span>
			{Grid.label(label, labelCols)}
			{children}
		</text>
	);
};
