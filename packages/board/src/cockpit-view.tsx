/** @jsxImportSource @opentui/react */
// The regions a card tab's cockpit adds around its map and "now" (Cockpit): whose log is open, what
// the run runs with, and on a finished run every session it had. The arrangement is the event
// view's; these only lay out their rows.
import type { ActivityFact, ActivityStep } from "@kabane/extension";
import {
	type BoxRenderable,
	type ScrollBoxRenderable,
	TextAttributes,
} from "@opentui/core";
import { type ReactNode, type RefObject, useState } from "react";
import { Cockpit } from "./cockpit";
import { glyphOf, timeOf } from "./run-map-view";
import { Segments } from "./segments";
import { useTheme } from "./theme";

// The time column, as wide as the map's.
const TIME_COLS = 7;
// The name column never takes more than this share of the row.
const NAME_SHARE = 0.35;

/**
 * Over a session's log: whose log it is, and, when `enter` opened it rather than the cursor, the
 * way back.
 */
export const LogLabel = ({
	name,
	pinned,
}: {
	name: string;
	pinned: boolean;
}): ReactNode => {
	const theme = useTheme();
	return (
		<box style={{ flexShrink: 0, marginTop: 1 }}>
			<text wrapMode="none">
				<span fg={theme.defaultFg} attributes={TextAttributes.BOLD}>
					{name}
				</span>
				<span fg={theme.muted}>
					{pinned ? " · log · esc back to the stream" : " · log"}
				</span>
			</text>
		</box>
	);
};

/** What the run runs with, on the split's raised column: whole facts, as many to a row as fit. */
export const RunFacts = ({
	facts,
	width,
	surface,
}: {
	facts: readonly ActivityFact[];
	width: number;
	surface: string;
}): ReactNode => {
	const theme = useTheme();
	const [rows, setRows] = useState(0);
	if (facts.length === 0) return null;
	const packed = Cockpit.factRows(facts, width - 2);
	// The rows the map and the question leave, and no more: grown from nothing, so it never takes a
	// row from them (a heavier shrink would be the plain way, and the layout engine gets it wrong). It
	// shows whole or not at all; the `?` sheet lists the facts too.
	const whole = rows >= 1 + packed.length;
	return (
		<box
			style={{
				flexDirection: "column",
				marginTop: 1,
				flexGrow: 1,
				flexBasis: 0,
				flexShrink: 1,
				minHeight: 0,
				overflow: "hidden",
			}}
			onSizeChange={function (this: BoxRenderable) {
				setRows(this.height);
			}}
		>
			{whole ? (
				<text
					bg={surface}
					fg={theme.text}
					attributes={TextAttributes.BOLD}
					style={{ height: 1, flexShrink: 0 }}
				>
					{" run"}
				</text>
			) : null}
			{(whole ? packed : []).map((row) => (
				<text
					key={row.map((fact) => fact.label).join(" ")}
					bg={surface}
					wrapMode="none"
					style={{ height: 1, flexShrink: 0 }}
				>
					{/* A fact wider than the column alone on its row is cut with `…`. */}
					{Segments.spans(
						Segments.fit(
							[
								{ text: " ", fg: theme.text },
								...row.flatMap((fact, at) => [
									{
										text: `${at > 0 ? " · " : ""}${fact.label} `,
										fg: theme.muted,
									},
									{ text: fact.value, fg: theme.text },
								]),
							],
							width - 1,
						),
					)}
				</text>
			))}
		</box>
	);
};

/**
 * Every session a finished run had, in the order its steps ran: glyph, name, time and result, one
 * row each. Where the split's log stands while the cursor is on no session.
 */
export const SessionsTable = ({
	steps,
	width,
	scrollRef,
}: {
	steps: readonly ActivityStep[];
	width: number;
	scrollRef: RefObject<ScrollBoxRenderable | null>;
}): ReactNode => {
	const theme = useTheme();
	const sessions = steps.flatMap((step) => step.sessions ?? []);
	const nameCols = Math.min(
		Math.max(0, ...sessions.map((session) => session.name.length)),
		Math.floor(width * NAME_SHARE),
	);
	return (
		// Grown from nothing, so the trace above keeps the rows it asked for.
		<box
			style={{
				flexDirection: "column",
				flexGrow: 1,
				flexBasis: 0,
				minHeight: 0,
				marginTop: 1,
			}}
		>
			<text wrapMode="none" style={{ flexShrink: 0 }}>
				<span fg={theme.defaultFg} attributes={TextAttributes.BOLD}>
					sessions
				</span>
				<span fg={theme.muted}>{` · ${sessions.length}`}</span>
			</text>
			<scrollbox ref={scrollRef} style={{ flexGrow: 1 }}>
				{sessions.map((session, at) => {
					const glyph = glyphOf(session.state, true, "●", theme);
					const name =
						session.name.length > nameCols
							? `${session.name.slice(0, Math.max(0, nameCols - 1))}…`
							: session.name.padEnd(nameCols);
					return (
						// Index keys: two steps may run sessions of one name.
						<text key={at} wrapMode="none" style={{ flexShrink: 0 }}>
							{Segments.spans(
								Segments.fit(
									[
										{ text: `${glyph.text} `, fg: glyph.fg },
										{ text: name, fg: theme.defaultFg },
										{
											text: ` ${timeOf(session).padStart(TIME_COLS)}  `,
											fg: theme.muted,
										},
										{ text: session.result ?? "", fg: theme.muted },
									],
									width - 2,
								),
							)}
						</text>
					);
				})}
			</scrollbox>
		</box>
	);
};
