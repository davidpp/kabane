// The records the open detail view shows (BoardData.taskDetail), fetched when it opens or its task
// changes. A different task opens on its loading line; the same task refetches in place, so a
// v/x/n/s on it keeps its tab and its scroll.
import type { Result } from "@cabane/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BoardStore } from "./board-store";
import { BoardData } from "./data";
import { BoardNav } from "./nav";

export type DetailRecords = {
	// Undefined while no detail view is open or its records load.
	records: Result<BoardData.DetailRecords> | undefined;
	// Reload the open task's records if anything landed on it since; every board reload calls it.
	refresh: (taskId: string) => Promise<void>;
};

export const useDetailRecords = (
	basePath: string,
	{ state, ref }: Pick<BoardStore, "state" | "ref">,
): DetailRecords => {
	const [records, setRecords] = useState<
		Result<BoardData.DetailRecords> | undefined
	>(undefined);
	// Which task those records are for, and their stamp (BoardData.recordsStamp): the poll compares a
	// fresh stamp against it and reloads the records only when something landed.
	const loadedId = useRef<string | null>(null);
	const stamp = useRef<string | null>(null);

	// Store the records of the open detail view and the stamp they carry.
	const show = useCallback(
		(taskId: string, next: Result<BoardData.DetailRecords>): void => {
			loadedId.current = taskId;
			stamp.current = next.ok ? BoardData.recordsStamp(next.value) : null;
			setRecords(next);
		},
		[],
	);

	// A comment, work log or session activity lands without touching the task row, so the open
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
			setRecords(undefined);
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
	}, [basePath, taskId, task?.updatedAt, show]);

	return { records, refresh };
};
