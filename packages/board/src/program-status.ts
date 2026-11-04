// What the terminal is told about the board, through OSC 7501 (OpenTUI's `setProgramStatus`): one
// root record for the board, `blocked` while anything on it waits on the human, else `working`
// while the copilot or a host card runs, else cleared; and a child record under it for each card
// with something pending, the copilot's turn among them. A terminal that does not implement the
// protocol ignores every report, so this costs nothing anywhere else.
//
// `reports` derives the whole set from board state and is pure; `useProgramStatus` writes only the
// records that changed since the last write, and clears the ones that went. The board clears the
// root (and with it every child) once its renderer has let go of the terminal (start.tsx).
import { createHash } from "node:crypto";
import { trySync } from "@cabane/core";
import type { ProgramStatus as Report, ProgramStatusKind } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { useEffect, useRef } from "react";
import type { BoardActivity } from "./activity";
import type { BoardNav } from "./nav";
import type { ActivityCard } from "./ports";

export namespace ProgramStatus {
	export type Input = {
		copilot: Pick<BoardNav.CopilotState, "turn" | "asks">;
		// Every session question waiting on the human, whoever asked it (the tab bar's queue).
		questions: readonly BoardActivity.AwaitingQuestion[];
		// The host's cards; the copilot's own card is the copilot's turn, not one of these.
		cards: readonly ActivityCard[];
	};

	const APP = "kabane";
	// The root record has no id; a report without one addresses it.
	export const ROOT = "";
	const COPILOT = "copilot";

	// One thing waiting on the human, as the protocol names it.
	type Blocker = { kind: ProgramStatusKind; asks: string };

	// The report that clears the root and every record beneath it, as raw bytes for the terminal once
	// the renderer that wrote the records is gone.
	export const CLEAR_ALL = "\x1b]7501;state=clear\x1b\\";

	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	// A record field is one line within a byte budget: control characters become spaces, runs of
	// space collapse, and a cut never splits a character.
	const clip = (text: string, bytes: number): string | undefined => {
		const line = text
			.replace(/[\p{Cc}]+/gu, " ")
			.replace(/\s+/g, " ")
			.trim();
		if (line === "") return undefined;
		const encoded = encoder.encode(line);
		if (encoded.byteLength <= bytes) return line;
		const cut = decoder.decode(encoded.subarray(0, bytes - 3));
		return `${cut.replace(/�+$/, "")}…`;
	};
	const TITLE_BYTES = 192;
	const MESSAGE_BYTES = 2048;

	/**
	 * A record id the protocol takes: 1-32 bytes of `[A-Za-z0-9_.+-]`. A card id that is not one
	 * (`loop:r1`) is hashed, so it stays the same id for as long as the card does.
	 */
	export const recordId = (id: string): string =>
		/^[\w.+-]{1,32}$/.test(id)
			? id
			: `card_${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;

	// The kind several blockers share, or none when they differ.
	const kindOf = (
		blockers: readonly Blocker[],
	): ProgramStatusKind | undefined => {
		const kinds = new Set(blockers.map((b) => b.kind));
		const [only] = kinds;
		return kinds.size === 1 ? only : undefined;
	};

	const copilotBlockers = (input: Input): Blocker[] =>
		input.copilot.asks.map((ask) =>
			ask.type === "permission"
				? { kind: "permission", asks: ask.request.title }
				: { kind: "question", asks: ask.request.message },
		);

	const questionBlocker = (
		question: BoardActivity.AwaitingQuestion,
	): Blocker => ({
		kind: question.permission ? "permission" : "question",
		asks: question.question,
	});

	type Pending = {
		id: string;
		title: string;
		blockers: readonly Blocker[];
		working: boolean;
	};

	const cardTitle = (card: ActivityCard): string =>
		[card.label, card.taskShortId].filter(Boolean).join(" ");

	// Every card with something pending: the copilot's turn, then each host card that waits on the
	// human or runs. A card that is over, or paused with nothing to ask, has nothing to report.
	const pending = (input: Input): Pending[] => {
		const copilot: Pending = {
			id: COPILOT,
			title: "copilot",
			blockers: copilotBlockers(input),
			working: input.copilot.turn === "running",
		};
		const cards = input.cards.map((card): Pending => ({
			id: recordId(card.id),
			title: cardTitle(card),
			blockers: input.questions
				.filter((q) => card.sessionIds?.includes(q.sessionId))
				.map(questionBlocker),
			working:
				(card.status === "running" || card.status === "pending") && !card.stale,
		}));
		return [copilot, ...cards].filter(
			(p) => p.blockers.length > 0 || p.working,
		);
	};

	const needInput = (n: number): string =>
		`${n} need${n === 1 ? "s" : ""} input`;

	const record = (p: Pending): Report => {
		const title = clip(p.title, TITLE_BYTES);
		const head = p.blockers[0];
		if (!head) return { state: "working", id: p.id, app: APP, title };
		const message = clip(
			p.blockers.length === 1 ? head.asks : needInput(p.blockers.length),
			MESSAGE_BYTES,
		);
		const kind = kindOf(p.blockers);
		return {
			state: "blocked",
			id: p.id,
			app: APP,
			title,
			message,
			...(kind ? { kind } : {}),
		};
	};

	// The board as a whole: blocked on everything waiting on the human, whichever card asked it (a
	// question no card owns counts here too), else working while anything runs, else nothing.
	const root = (
		input: Input,
		cards: readonly Pending[],
	): Report | undefined => {
		const blockers = [
			...copilotBlockers(input),
			...input.questions.map(questionBlocker),
		];
		if (blockers.length > 0) {
			const kind = kindOf(blockers);
			return {
				state: "blocked",
				app: APP,
				message: needInput(blockers.length),
				...(kind ? { kind } : {}),
			};
		}
		const working = cards.filter((p) => p.working);
		const [one] = working;
		if (!one) return undefined;
		return {
			state: "working",
			app: APP,
			message:
				working.length === 1
					? `${one.title} working`
					: `${working.length} working`,
		};
	};

	/** Every record the board should hold now, by record id (`ROOT` for the root). */
	export const reports = (input: Input): ReadonlyMap<string, Report> => {
		const cards = pending(input);
		const top = root(input, cards);
		if (!top) return new Map();
		return new Map([
			[ROOT, top],
			...cards.map((p): [string, Report] => [p.id, record(p)]),
		]);
	};

	/**
	 * The reports that turn what was `sent` (each record's last report, as JSON) into `next`: a
	 * clear for each record that went, children before the root, then each record that changed.
	 * Nothing when nothing moved.
	 */
	export const changes = (
		sent: ReadonlyMap<string, string>,
		next: ReadonlyMap<string, Report>,
	): { key: string; report: Report }[] => {
		const gone = [...sent.keys()]
			.filter((key) => !next.has(key))
			.sort((a, b) => (a === ROOT ? 1 : b === ROOT ? -1 : 0))
			.map((key) => ({
				key,
				report: (key === ROOT
					? { state: "clear" }
					: { state: "clear", id: key }) satisfies Report,
			}));
		const moved = [...next]
			.filter(([key, report]) => sent.get(key) !== JSON.stringify(report))
			.map(([key, report]) => ({ key, report }));
		return [...gone, ...moved];
	};

	/**
	 * Keep the terminal's records on `next`, writing only what changed. A report the renderer did not
	 * queue (it is shutting down, its output is full) or refused is not remembered as sent, so the
	 * next change tries it again.
	 */
	export const useProgramStatus = (next: ReadonlyMap<string, Report>): void => {
		const renderer = useRenderer();
		const sent = useRef(new Map<string, string>());
		useEffect(() => {
			for (const { key, report } of changes(sent.current, next)) {
				const written = trySync(() => renderer.setProgramStatus(report));
				if (!written.ok || !written.value) continue;
				if (report.state === "clear") sent.current.delete(key);
				else sent.current.set(key, JSON.stringify(report));
			}
		}, [renderer, next]);
	};
}
