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

	/** The parts as spans, inside a `<text>` that owns the row and its background. */
	export const spans = (segments: readonly Segment[]): ReactNode[] =>
		segments.map((segment, index) => (
			// Index keys: a line's parts are positional, and the same text can repeat.
			<span key={index} fg={segment.fg} attributes={segment.attributes}>
				{segment.text}
			</span>
		));
}
