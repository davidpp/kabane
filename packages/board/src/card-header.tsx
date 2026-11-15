/** @jsxImportSource @opentui/react */
import { TextAttributes } from "@opentui/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ActivityCard, Header, HeaderPart } from "./ports";
import { Segments } from "./segments";
import { Theme, useTheme } from "./theme";

/** Shared by clipped card rows and wrapping trigger previews. */
export const segmentsOf = (
	line: readonly HeaderPart[],
	theme: Theme.Tokens,
): Segments.Segment[] =>
	line.map((part) => ({
		text: part.text,
		fg:
			"series" in part
				? Theme.seriesOf(theme, part.series)
				: theme[
						part.tone === undefined || part.tone === "default"
							? "text"
							: part.tone
					],
		...(part.bold ? { attributes: TextAttributes.BOLD } : {}),
	}));

export const CardHeader = ({
	header,
	card,
	width,
	expanded,
}: {
	header: Header;
	card: ActivityCard;
	width: number;
	expanded: boolean;
}): ReactNode => {
	const theme = useTheme();
	const room = Math.max(0, width - 2);
	const [lines, setLines] = useState<readonly (readonly HeaderPart[])[] | null>(
		null,
	);
	const latest = useRef({ card, width: room, expanded });
	latest.current = { card, width: room, expanded };
	const pending = useRef(false);
	useEffect(() => {
		let cancelled = false;
		setLines(null);
		const poll = async (): Promise<void> => {
			if (pending.current) return;
			pending.current = true;
			try {
				const current = latest.current;
				const result = await header(current.card, {
					width: current.width,
					expanded: current.expanded,
				});
				if (!cancelled && result.ok) setLines(result.value);
			} catch {
				// A broken extension leaves the last good header visible.
			} finally {
				pending.current = false;
			}
		};
		void poll();
		const timer = setInterval(() => void poll(), 1000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [header, card.id]);
	return (
		<box
			style={{
				width,
				flexDirection: "column",
				flexShrink: 0,
				backgroundColor: theme.surface.raised,
				paddingLeft: 1,
				paddingRight: 1,
				overflow: "hidden",
			}}
		>
			{(lines ?? [[{ text: "loading…", tone: "muted" }]]).map((line, index) => (
				// Lines have positional identity, including repeated and empty rows.
				<text
					key={index}
					bg={theme.surface.raised}
					wrapMode="none"
					style={{ height: 1, flexShrink: 0, width: room }}
				>
					{Segments.spans(segmentsOf(line, theme))}
				</text>
			))}
		</box>
	);
};
