/** @jsxImportSource @opentui/react */
// The regions a card tab's cockpit adds around its map and "now" (Cockpit): whose log is open, what
// the run runs with, and on a finished run every session it had. The arrangement is the event
// view's; these only lay out their rows.
import type { ActivityFact, ActivityStep } from "@kabane/extension";
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import type { ReactNode, RefObject } from "react";
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
	if (facts.length === 0) return null;
	return (
		<box
			style={{
				flexDirection: "column",
				marginTop: 1,
				// The first region to give way when the column runs short: the `?` sheet lists it too.
				flexShrink: 100,
				minHeight: 0,
				overflow: "hidden",
			}}
		>
			<text bg={surface} fg={theme.text} attributes={TextAttributes.BOLD}>
				{" run"}
			</text>
			{Cockpit.factRows(facts, width - 1).map((row) => (
				<text
					key={row.map((fact) => fact.label).join(" ")}
					bg={surface}
					wrapMode="none"
					style={{ height: 1, flexShrink: 0 }}
				>
					{" "}
					{row.flatMap((fact, at) => [
						<span key={`${fact.label}:label`} fg={theme.muted}>
							{`${at > 0 ? " · " : ""}${fact.label} `}
						</span>,
						<span key={`${fact.label}:value`} fg={theme.text}>
							{fact.value}
						</span>,
					])}
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
