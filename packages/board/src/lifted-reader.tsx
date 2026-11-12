/** @jsxImportSource @opentui/react */
// The reader `r` opens over an issue's detail: each lifted kind's newest entry in full, in the order
// the brief lifts them, where the `now` tab shows only a digest. It is the `?` sheet's look (the
// overlay surface across the pane, a cell of padding, its own footer row) at the pane's full height
// under the tab bar, with a scrollbox of its own. j/k scroll it; `[`/`]` move it to the previous or
// next heading of the entries' bodies, read leniently as DetailModel.sections reads them.
//
// Its first row is pinned over the scroll: once an entry's own first line has gone above the view,
// it says whose entry the view is in and which heading (`handoff · claude · Evidence`); at the top,
// where that line is in sight, it is the sheet's padding.
//
// The heading under the cursor is the last one scrolled past. When the poll brings a newer entry
// while the reader is open, that heading is kept where it was on screen; when the newer entry has no
// heading of that name, the reader goes back to the top.
import type { Result } from "@cabane/core";
import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { BoardStore } from "./board-store";
import type { BoardData } from "./data";
import { MarkdownBody, relativeTime } from "./detail";
import { DetailModel } from "./detail-model";
import { StatusBar } from "./footer";
import { Keymap } from "./keymap";
import { BoardNav } from "./nav";
import { overlayBg } from "./overlay";
import { Paging } from "./paging";
import { Segments } from "./segments";
import { useTheme } from "./theme";

export namespace LiftedReader {
	/** What the screen's effects reach into: the reader's scroll and its heading jumps. */
	export type Handle = {
		scroll: (motion: Paging.Motion) => void;
		jump: (delta: 1 | -1) => void;
	};

	/** One part of an entry as the reader draws it, with the renderable id of a headed one. */
	type Part = { id?: string; heading?: string; text: string };

	/** The renderable id of an entry's own box, which starts on its first line. */
	export const entryId = (kind: string): string => `reader:entry:${kind}`;

	/** What the pinned row names: the entry the view is in, and the heading it is at in it. */
	export type Pin = { kind: string; heading?: string };

	/**
	 * An entry's sections as the reader draws them. A headed section's id names its kind and its
	 * heading (and which one, when a heading repeats), so the same heading in a newer entry is the
	 * same renderable, which is how the reader keeps it in place.
	 */
	export const parts = (entry: DetailModel.LiftedEntry): Part[] => {
		const seen = new Map<string, number>();
		return entry.sections.map((section) => {
			const text = section.lines.join("\n");
			if (section.heading === undefined) return { text };
			const nth = seen.get(section.heading) ?? 0;
			seen.set(section.heading, nth + 1);
			return {
				id: `reader:${entry.kind}:${section.heading}#${String(nth)}`,
				heading: section.heading,
				text,
			};
		});
	};

	/** The ids of every headed section, across the entries, in reading order. */
	export const headingIds = (
		entries: readonly DetailModel.LiftedEntry[],
	): string[] =>
		entries.flatMap((entry) =>
			parts(entry).flatMap((part) => (part.id ? [part.id] : [])),
		);
}

/**
 * The `openReader` effect: the reader opens over the detail view on `taskId` when its records are
 * in and lift an entry to read. With nothing lifted, `r` does nothing, as its missing hint says.
 */
export const useOpenReader = (
	records: Result<BoardData.DetailRecords> | undefined,
	update: BoardStore["update"],
): ((taskId: string) => void) =>
	useCallback(
		(taskId: string): void => {
			if (
				records?.ok &&
				records.value.task.id === taskId &&
				DetailModel.lifted(records.value).length > 0
			)
				update((prev) => BoardNav.withReader(prev, taskId));
		},
		[records, update],
	);

// Where a heading sits in the scrolled content, in rows from its top.
const offsetOf = (box: ScrollBoxRenderable, id: string): number | undefined => {
	const node = box.findDescendantById(id);
	return node ? node.y - box.content.y : undefined;
};

// The pinned row's entry and heading. After a jump, the heading picked and its entry, though near
// the end of the scroll it cannot reach the top. Otherwise the last entry whose first line has gone
// above the view, and the heading under the cursor when it is that entry's; none while the first
// line of the entry at the top is in sight.
const pinAt = (
	box: ScrollBoxRenderable,
	entries: readonly DetailModel.LiftedEntry[],
	under: string | null,
	picked: string | null,
): LiftedReader.Pin | null => {
	const of = (id: string | null): LiftedReader.Pin | undefined => {
		for (const entry of entries)
			for (const part of LiftedReader.parts(entry))
				if (part.id === id) return { kind: entry.kind, heading: part.heading };
		return undefined;
	};
	const jumped = of(picked);
	if (jumped) return jumped;
	const entry = entries.findLast((e) => {
		const offset = offsetOf(box, LiftedReader.entryId(e.kind));
		return offset !== undefined && offset < box.scrollTop;
	});
	if (!entry) return null;
	const heading = of(under);
	return heading?.kind === entry.kind ? heading : { kind: entry.kind };
};

// The last heading at or above the top of the view; none while the view is above the first.
const headingUnder = (
	box: ScrollBoxRenderable,
	ids: readonly string[],
): string | null =>
	ids.findLast((id) => {
		const offset = offsetOf(box, id);
		return offset !== undefined && offset <= box.scrollTop;
	}) ?? null;

/**
 * Where `[` (-1) or `]` (+1) goes: a heading's id, null for the top, undefined for nowhere. Straight
 * after a jump it steps from the heading picked; otherwise from the top of the view, to the first
 * heading below it or the last one above it.
 */
const jumpTarget = (
	box: ScrollBoxRenderable,
	ids: readonly string[],
	picked: string | null,
	delta: 1 | -1,
): string | null | undefined => {
	const at = picked === null ? -1 : ids.indexOf(picked);
	if (at >= 0) {
		const next = at + delta;
		return next < 0 ? null : ids[next];
	}
	const top = box.scrollTop;
	const placed = ids.flatMap((id) => {
		const offset = offsetOf(box, id);
		return offset === undefined ? [] : [{ id, offset }];
	});
	return delta > 0
		? placed.find((h) => h.offset > top)?.id
		: (placed.findLast((h) => h.offset < top)?.id ?? null);
};

export type LiftedReaderSheetProps = {
	entries: readonly DetailModel.LiftedEntry[];
	// The handle the screen's `readerScroll` and `readerJump` effects call.
	handleRef: RefObject<LiftedReader.Handle | null>;
};

// Where the reader's view is: its scrollbox, what its pinned row names, and what a move of the view
// by the mouse settles. The handle's keys move it; a newer entry holds it in place.
const useReaderView = (
	entries: readonly DetailModel.LiftedEntry[],
	handleRef: RefObject<LiftedReader.Handle | null>,
): {
	box: RefObject<ScrollBoxRenderable | null>;
	pin: LiftedReader.Pin | null;
	settle: () => void;
} => {
	const box = useRef<ScrollBoxRenderable | null>(null);
	const ids = LiftedReader.headingIds(entries);
	const idsRef = useRef(ids);
	idsRef.current = ids;
	const entriesRef = useRef(entries);
	entriesRef.current = entries;
	const [pin, setPin] = useState<LiftedReader.Pin | null>(null);
	const cursor = useRef<string | null>(null);
	// The heading the last `[`/`]` went to, until the view is moved some other way. A heading near
	// the end cannot reach the top (the scroll stops at the end), so the next jump steps from the
	// heading picked, not from where the view stopped.
	const picked = useRef<string | null>(null);
	// Ends the hold a newer entry put on the heading under the cursor (see below).
	const held = useRef<(() => void) | null>(null);
	const loosen = (): void => {
		held.current?.();
		held.current = null;
	};
	useEffect(() => loosen, []);

	// The pinned row, once the view's move is laid out.
	const repin = (current: ScrollBoxRenderable): void => {
		current.afterLayout(() => {
			setPin(
				pinAt(current, entriesRef.current, cursor.current, picked.current),
			);
		});
	};

	// After the view moves, the heading under its top is the one a newer entry keeps in place.
	const settle = (): void => {
		loosen();
		picked.current = null;
		const current = box.current;
		current?.afterLayout(() => {
			cursor.current = headingUnder(current, idsRef.current);
		});
		if (current) repin(current);
	};

	useImperativeHandle(handleRef, () => ({
		scroll: (motion) => {
			loosen();
			Paging.apply(box.current, motion);
			settle();
		},
		jump: (delta) => {
			loosen();
			const current = box.current;
			if (!current) return;
			const target = jumpTarget(current, idsRef.current, picked.current, delta);
			if (target === undefined) return;
			if (target === null) current.scrollTo(0);
			else current.scrollChildIntoView(target, { align: "start" });
			picked.current = target;
			cursor.current = target;
			repin(current);
		},
	}));

	// A newer entry came in: the heading under the cursor stays where it is on screen (the old layout
	// is still in place while this runs), or, gone, the reader starts over. The hold lasts until the
	// human moves the view, since markdown lays out over several frames after the commit.
	const signature = entries.map((e) => e.id).join(" ");
	const shown = useRef(signature);
	useLayoutEffect(() => {
		if (shown.current === signature) return;
		shown.current = signature;
		const current = box.current;
		const under = cursor.current;
		if (!current || under === null) return;
		loosen();
		const node = current.findDescendantById(under);
		if (node) {
			held.current = current.anchor(node);
			return;
		}
		current.scrollTo(0);
		cursor.current = null;
		picked.current = null;
		setPin(null);
	}, [signature]);

	return { box, pin, settle };
};

export const LiftedReaderSheet = ({
	entries,
	handleRef,
}: LiftedReaderSheetProps): ReactNode => {
	const { width, height } = useTerminalDimensions();
	const theme = useTheme();
	const bg = overlayBg(theme);
	const { box, pin, settle } = useReaderView(entries, handleRef);

	// The prose's own width: the sheet's padding and the markdown's inset off the pane.
	const room = Math.max(0, width - 2);
	const pinned = entries.find((entry) => entry.kind === pin?.kind);
	return (
		<box
			style={{
				position: "absolute",
				left: 0,
				// Under the tab bar, which stays in sight as the `?` sheet leaves it.
				top: 1,
				width,
				height: Math.max(3, height - 1),
				// Under the `?` sheet, which `?` opens over it.
				zIndex: 90,
				flexDirection: "column",
				backgroundColor: bg,
			}}
		>
			<box
				style={{
					flexShrink: 0,
					height: 1,
					paddingLeft: 1,
					paddingRight: 1,
					backgroundColor: bg,
				}}
			>
				{pinned ? (
					<PinRow entry={pinned} heading={pin?.heading} room={room} />
				) : null}
			</box>
			<scrollbox ref={box} style={{ flexGrow: 1 }} onMouseScroll={settle}>
				<box
					style={{
						flexDirection: "column",
						paddingLeft: 1,
						paddingRight: 1,
						paddingBottom: 1,
						backgroundColor: bg,
					}}
				>
					{entries.length === 0 ? (
						<text bg={bg} fg={theme.faint}>
							nothing to read
						</text>
					) : (
						entries.map((entry, index) => (
							<ReaderEntry
								key={entry.kind}
								entry={entry}
								room={room}
								first={index === 0}
							/>
						))
					)}
				</box>
			</scrollbox>
			<StatusBar hints={Keymap.footer("reader")} />
		</box>
	);
};

// The pinned row: the kind's title in Label weight and its author muted, as the entry's own first
// line reads, then the heading the view is at in the terminal's foreground, held whole while a long
// name is cut.
const PinRow = ({
	entry,
	heading,
	room,
}: {
	entry: DetailModel.LiftedEntry;
	heading: string | undefined;
	room: number;
}): ReactNode => {
	const theme = useTheme();
	const bg = overlayBg(theme);
	const line = Segments.fitHolding(
		[
			{
				text: entry.title.toLowerCase(),
				fg: theme.defaultFg,
				attributes: TextAttributes.BOLD,
			},
			{ text: ` · ${entry.author}`, fg: theme.muted },
		],
		heading === undefined
			? []
			: [
					{ text: " · ", fg: theme.muted },
					{ text: heading, fg: theme.defaultFg },
				],
		room,
	);
	return <text bg={bg}>{Segments.spans(line)}</text>;
};

// One entry in full: who and when on its first line, the kind's title in Label weight; the framing
// muted under it; then each section, its heading drawn by the markdown as the description draws one.
const ReaderEntry = ({
	entry,
	room,
	first,
}: {
	entry: DetailModel.LiftedEntry;
	room: number;
	first: boolean;
}): ReactNode => {
	const theme = useTheme();
	const line = Segments.fitHolding(
		[
			{
				text: entry.title.toLowerCase(),
				fg: theme.defaultFg,
				attributes: TextAttributes.BOLD,
			},
			{ text: ` · ${entry.author}`, fg: theme.muted },
		],
		[{ text: ` · ${relativeTime(entry.at)}`, fg: theme.muted }],
		room,
	);
	return (
		<box
			id={LiftedReader.entryId(entry.kind)}
			style={{ flexDirection: "column", marginTop: first ? 0 : 2 }}
		>
			<text>{Segments.spans(line)}</text>
			<text fg={theme.muted} style={{ maxWidth: room }}>
				{entry.framing}
			</text>
			{LiftedReader.parts(entry).map((part) => (
				<box
					key={part.id ?? "opening"}
					id={part.id}
					style={{ flexDirection: "column", marginTop: 1 }}
				>
					<MarkdownBody
						content={
							part.heading === undefined
								? part.text
								: `## ${part.heading}\n\n${part.text}`
						}
					/>
				</box>
			))}
		</box>
	);
};
