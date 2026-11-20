/** @jsxImportSource @opentui/react */
import type { ActivityCard, Header, HeaderPart } from "@kabane/extension";
import { TextAttributes } from "@opentui/core";
import { type ReactNode, useEffect, useRef, useState } from "react";
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

/** A row held to `room` columns: one that runs over ends on `…` rather than stopping mid-word. */
const clip = (
	line: readonly HeaderPart[],
	room: number,
): readonly HeaderPart[] => {
	const total = line.reduce((sum, part) => sum + part.text.length, 0);
	if (total <= room) return line;
	const kept: HeaderPart[] = [];
	let left = Math.max(0, room - 1);
	for (const part of line) {
		if (left === 0) break;
		const text = part.text.slice(0, left);
		kept.push({ ...part, text });
		left -= text.length;
	}
	const last = kept.at(-1);
	return last
		? [...kept.slice(0, -1), { ...last, text: `${last.text}…` }]
		: [{ text: "…" }];
};

export const CardHeader = ({
	header,
	card,
	width,
	expanded,
	intervalMs = 1000,
}: {
	header: Header;
	card: ActivityCard;
	width: number;
	expanded: boolean;
	intervalMs?: number;
}): ReactNode => {
	const theme = useTheme();
	const room = Math.max(0, width - 2);
	const [lines, setLines] = useState<readonly (readonly HeaderPart[])[] | null>(
		null,
	);
	const latest = useRef({ card, width: room, expanded });
	latest.current = { card, width: room, expanded };
	const pending = useRef(false);
	const refresh = useRef<(() => void) | null>(null);
	useEffect(() => setLines(null), [header, card.id]);
	useEffect(() => {
		let cancelled = false;
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
				// A view change during a read must not wait for the next tick.
				if (cancelled) refresh.current?.();
			}
		};
		refresh.current = () => void poll();
		void poll();
		const timer = setInterval(() => void poll(), intervalMs);
		return () => {
			cancelled = true;
			refresh.current = null;
			clearInterval(timer);
		};
	}, [header, card.id, expanded, room, intervalMs]);
	if (!lines)
		return (
			<text fg={theme.muted} style={{ flexShrink: 0 }}>
				loading…
			</text>
		);
	return (
		<box
			style={{
				flexDirection: "column",
				flexShrink: 0,
				backgroundColor: theme.surface.raised,
				paddingLeft: 1,
				paddingRight: 1,
				overflow: "hidden",
			}}
		>
			{lines.map((line, index) => (
				// Lines have positional identity, including repeated and empty rows.
				<text
					key={index}
					bg={theme.surface.raised}
					wrapMode="none"
					style={{ height: 1, flexShrink: 0 }}
				>
					{Segments.spans(segmentsOf(clip(line, room), theme))}
				</text>
			))}
		</box>
	);
};
