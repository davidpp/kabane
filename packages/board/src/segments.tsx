/** @jsxImportSource @opentui/react */
// A one-row line built from colored parts. A row here never wraps (a wrapped row breaks the scan), so
// a line too long for its room loses its tail a part at a time: the part that overflows is cut with
// `…`, and every part ahead of it keeps its words and its color.
import type { ColorInput } from "@opentui/core";
import type { ReactNode } from "react";

export namespace Segments {
	export type Segment = { text: string; fg: ColorInput; attributes?: number };

	export const plain = (segments: readonly Segment[]): string =>
		segments.map((segment) => segment.text).join("");

	export const fit = (
		segments: readonly Segment[],
		room: number,
	): Segment[] => {
		const fitted: Segment[] = [];
		let used = 0;
		for (const segment of segments) {
			const left = room - used;
			if (segment.text.length <= left) {
				fitted.push(segment);
				used += segment.text.length;
				continue;
			}
			if (left > 0)
				fitted.push({
					...segment,
					text: `${segment.text.slice(0, left - 1)}…`,
				});
			break;
		}
		return fitted;
	};

	// A part wraps under the column it started at unless that leaves it less than this; then it
	// starts again at the row's left edge.
	const MIN_HANG = 8;

	/** Where to cut `text` to fit `width`: after the last space or comma that fits, else at `width`. */
	const breakAt = (text: string, width: number): number => {
		for (let at = width; at > 0; at--) {
			const before = text[at - 1];
			if (before === " " || before === ",") return at;
		}
		return width;
	};

	/**
	 * The parts as rows of `room` columns, for a host's line that must be read whole (a plan's
	 * blockers) rather than cut. Parts that fit stay on the row; the part that overflows breaks at
	 * a space or a comma and carries on under the column it started at, with its color. Padding
	 * that would only spill over the edge is dropped.
	 */
	export const wrap = (
		segments: readonly Segment[],
		room: number,
	): Segment[][] => {
		const width = Math.max(1, room);
		const rows: Segment[][] = [[]];
		let used = 0;
		const push = (segment: Segment): void => {
			rows[rows.length - 1]?.push(segment);
			used += segment.text.length;
		};
		const newRow = (indent: number, like: Segment): void => {
			rows.push(indent > 0 ? [{ ...like, text: " ".repeat(indent) }] : []);
			used = indent;
		};
		for (const segment of segments) {
			if (segment.text.length <= width - used) {
				push(segment);
				continue;
			}
			const trimmed = segment.text.trimEnd();
			if (trimmed.length <= width - used) {
				// Its padding kept the next part apart: with no room for it, the next part starts a row.
				if (trimmed !== "") push({ ...segment, text: trimmed });
				used = width;
				continue;
			}
			const hang = width - used >= MIN_HANG ? used : 0;
			if (hang === 0 && used > 0) newRow(0, segment);
			let text = segment.text;
			while (text.length > width - used) {
				const cut = breakAt(text, width - used);
				push({ ...segment, text: text.slice(0, cut).trimEnd() });
				text = text.slice(cut).trimStart();
				if (text === "") {
					used = width;
					break;
				}
				newRow(hang, segment);
			}
			if (text !== "") push({ ...segment, text });
		}
		return rows;
	};

	/** The parts as spans, inside a `<text>` that owns the row and its background. */
	export const spans = (segments: readonly Segment[]): ReactNode[] =>
		segments.map((segment, index) => (
			// Index keys: a line's parts are positional, and the same text can repeat.
			<span key={index} fg={segment.fg} attributes={segment.attributes}>
				{segment.text}
			</span>
		));
}
