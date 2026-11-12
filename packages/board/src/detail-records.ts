// The records the open detail view shows (BoardData.taskDetail), fetched when it opens or its task
// changes. A different task opens on its loading line; the same task refetches in place, so a
// v/x/n/s on it keeps its tab and its scroll. Its first records settle the tab it opens on
// (BoardNav.withOpeningTab). The task's open decisions and its checklist go on into
// the board's state, where the keys that answer and tick them are reduced (BoardDecisions.withOpen,
// BoardChecklist.withOpen).
//
// A refetch of the same task is diffed against the records it replaces (DetailModel.changed), and
// the blocks of `now` it changed stay fresh until the human has seen them (Detail marks them and
// says when). Its first records mark nothing, nor does a change this board wrote itself: the
// writes still on the board's state when the records land (a tick, an answer) are its own. A v/x/n/s
// changes the task row, which is no block of `now`. Another task, or the detail closing, forgets
// them.
import type { Result } from "@cabane/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BoardStore } from "./board-store";
import { BoardChecklist } from "./checklist";
import { BoardData } from "./data";
import { BoardDecisions } from "./decisions";
import { DetailModel } from "./detail-model";
import { BoardNav } from "./nav";

export type DetailRecords = {
	// Undefined while no detail view is open or its records load.
	records: Result<BoardData.DetailRecords> | undefined;
	// Reload the open task's records if anything landed on it since; every board reload calls it.
	refresh: (taskId: string) => Promise<void>;
	fresh: Fresh;
};

/** The blocks of `now` a change landed on since the human last saw them, and how they say so. */
export type Fresh = {
	blocks: ReadonlySet<DetailModel.BlockName>;
	seen: (name: DetailModel.BlockName) => void;
};

const NOTHING_FRESH: ReadonlySet<DetailModel.BlockName> = new Set();

export const useDetailRecords = (
	basePath: string,
	{ state, ref, update }: Pick<BoardStore, "state" | "ref" | "update">,
): DetailRecords => {
	const [records, setRecords] = useState<
		Result<BoardData.DetailRecords> | undefined
	>(undefined);
	// Which task those records are for, and their stamp (BoardData.recordsStamp): the poll compares a
	// fresh stamp against it and reloads the records only when something landed.
	const loadedId = useRef<string | null>(null);
	const stamp = useRef<string | null>(null);
	// The open task's last records, which the next read of it is diffed against.
	const last = useRef<BoardData.DetailRecords | null>(null);
	const [freshBlocks, setFresh] = useState(NOTHING_FRESH);

	// Store the records of the open detail view and the stamp they carry.
	const show = useCallback(
		(taskId: string, next: Result<BoardData.DetailRecords>): void => {
			const before = loadedId.current === taskId ? last.current : null;
			const board = ref.current;
			if (before && next.ok && board) {
				const landed = DetailModel.changed(before, next.value, {
					ticked: new Map(
						[...board.checklist.writes].map(
							([id, write]) => [id, write.wanted] as const,
						),
					),
					answered: board.decisions.pending,
				});
				const standing = new Set(
					DetailModel.now(next.value).map((block) => block.name),
				);
				setFresh((prev) =>
					landed.length === 0 && [...prev].every((name) => standing.has(name))
						? prev
						: new Set(
								[...prev, ...landed].filter((name) => standing.has(name)),
							),
				);
			}
			if (next.ok) last.current = next.value;
			loadedId.current = taskId;
			stamp.current = next.ok ? BoardData.recordsStamp(next.value) : null;
			setRecords(next);
			if (next.ok)
				update((prev) =>
					BoardNav.withOpeningTab(
						BoardChecklist.withOpen(
							BoardDecisions.withOpen(prev, taskId, next.value.questions),
							taskId,
							next.value.checklist,
							DetailModel.openable(next.value),
						),
						taskId,
						DetailModel.openingTab(next.value),
					),
				);
		},
		[update, ref],
	);

	// A comment, work log, session activity or checklist tick lands without touching the task row, so the open
	// detail view checks the cheap stamp on every poll and reloads its records only when it moved.
	// The records are replaced in place, never cleared, so the view keeps its tab and its scroll.
	// A failed read keeps what is on screen: the board's own poll already reports a broken store.
	const refresh = useCallback(
		async (taskId: string): Promise<void> => {
			const fresh = await BoardData.detailStamp(basePath, taskId);
			if (!fresh.ok || fresh.value === stamp.current) return;
			const next = await BoardData.taskDetail(basePath, taskId);
			const open = ref.current?.view;
			if (open?.type !== "detail" || open.taskId !== taskId) return;
			if (next.ok) show(taskId, next);
		},
		[basePath, show, ref],
	);

	const taskId = state?.view.type === "detail" ? state.view.taskId : null;
	const task = taskId && state ? BoardNav.taskById(state, taskId) : undefined;
	// task?.updatedAt is an intentional trigger — a v/x/n/s mutation on the open task re-fetches the records without changing taskId.
	useEffect(() => {
		if (loadedId.current !== taskId) {
			loadedId.current = null;
			stamp.current = null;
			last.current = null;
			setFresh(NOTHING_FRESH);
			setRecords(undefined);
			update((prev) =>
				BoardChecklist.withOpen(BoardDecisions.withOpen(prev, null), null),
			);
		}
		if (!taskId) return;
		let cancelled = false;
		void (async () => {
			const result = await BoardData.taskDetail(basePath, taskId);
			if (cancelled) return;
			show(taskId, result);
		})();
		return () => {
			cancelled = true;
		};
	}, [basePath, taskId, task?.updatedAt, show, update]);

	const seen = useCallback((name: DetailModel.BlockName): void => {
		setFresh((prev) => {
			if (!prev.has(name)) return prev;
			const rest = new Set(prev);
			rest.delete(name);
			return rest;
		});
	}, []);
	const fresh = useMemo(
		() => ({ blocks: freshBlocks, seen }),
		[freshBlocks, seen],
	);

	return { records, refresh, fresh };
};
