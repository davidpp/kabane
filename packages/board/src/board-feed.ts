// What the board reads from the tracker and the host: the first load scoped to the detected project
// (`esc` widens to all scopes), a 5s poll that keeps it fresh, the reload a write asks for, and the
// FTS search merged into the rows. Selection survives every reload by task id (BoardNav.withSections).
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { BoardActivity } from "./activity";
import type { BoardStore } from "./board-store";
import { BoardChecklist } from "./checklist";
import { BoardData } from "./data";
import { BoardDecisions } from "./decisions";
import { BoardNav } from "./nav";
import type { SetNotice } from "./notice";
import type { ActivitySource, Copilot } from "./ports";

const POLL_INTERVAL_MS = 5000;
// Stable identity so a board with nothing linked doesn't re-render on it.
const EMPTY_LINKS: ReadonlySet<string> = new Set<string>();

export type BoardFeed = {
	// The project the board opened on, null when it opened on all scopes; its ref for the callbacks.
	scope: BoardData.ScopeInfo | null;
	scopeRef: RefObject<BoardData.ScopeInfo | null>;
	// In-flight host cards and awaiting-input questions, refreshed by the same poll as the board data. A
	// failed activity read keeps the previous map — the board is a glance surface, badges degrade quietly.
	activity: BoardActivity.ActivityMap;
	// Task ids pointing at an external issue, refreshed by the same poll. Degrades the same way the
	// activity map does: a failed read keeps the last-good set rather than un-glyphing every row.
	linked: ReadonlySet<string>;
	// Why the first load failed; `retry` loads again.
	error: string | null;
	retry: () => void;
	// Reload with the filters `s` implies, merging the rows in.
	reload: (s: BoardNav.BoardState) => Promise<void>;
};

// One read of what a load puts on the board: its rows, the host's activity, and the badges read
// across the whole tracker (open decisions, checklist progress). A badge read that failed is
// undefined, so the last-good badges stay, as a failed activity read keeps the last-good map.
const loadFeed = async (
	basePath: string,
	filters: BoardData.BoardFilters,
	activitySource: ActivitySource,
) => {
	const [rows, activity, counts, progress] = await Promise.all([
		BoardData.loadBoard(basePath, filters),
		BoardActivity.loadActivity(basePath, activitySource),
		BoardData.openQuestionCounts(basePath),
		BoardData.checklistProgress(basePath),
	]);
	return {
		rows,
		activity,
		counts: counts.ok ? counts.value : undefined,
		progress: progress.ok ? progress.value : undefined,
	};
};

export const useBoardFeed = ({
	cwd,
	basePath,
	activitySource,
	resolveScope,
	copilot,
	store: { state, ref, set, update },
	setNotice,
	refreshDetail,
}: {
	cwd: string;
	basePath: string;
	activitySource: ActivitySource;
	resolveScope: BoardData.ScopeResolver | undefined;
	// Its shortcuts and actor go into the first state.
	copilot: Copilot | undefined;
	store: BoardStore;
	setNotice: SetNotice;
	// Every reload checks the open detail view's records too.
	refreshDetail: (taskId: string) => Promise<void>;
}): BoardFeed => {
	const [scope, setScope] = useState<BoardData.ScopeInfo | null>(null);
	const scopeRef = useRef<BoardData.ScopeInfo | null>(null);
	scopeRef.current = scope;
	const [activity, setActivity] = useState<BoardActivity.ActivityMap>(
		BoardActivity.emptyActivity(),
	);
	const [linked, setLinked] = useState<ReadonlySet<string>>(EMPTY_LINKS);
	const [error, setError] = useState<string | null>(null);
	// A retry counter so the initial-load effect can be re-triggered by `r` from the error screen.
	const [retryCount, setRetryCount] = useState(0);
	const retry = useCallback((): void => {
		setError(null);
		setRetryCount((c) => c + 1);
	}, []);

	const filtersFor = useCallback(
		(s: BoardNav.BoardState): BoardData.BoardFilters => ({
			kind: s.kind === "all" ? undefined : s.kind,
			scopeUri: s.scoped ? scopeRef.current?.scopeUri : undefined,
		}),
		[],
	);

	const fireFts = useSearch(basePath, filtersFor, { state, ref, update });

	// Reload columns using the filters implied by `s`, then merge them in preserving selection.
	// When a query is active, re-fire the FTS search after the reload so tier-2 results stay merged.
	const reload = useCallback(
		async (s: BoardNav.BoardState): Promise<void> => {
			const feed = await loadFeed(basePath, filtersFor(s), activitySource);
			const result = feed.rows;
			if (!result.ok) {
				// Non-fatal: keep last-good state, surface as a transient notice.
				setNotice({ text: result.error.message, tone: "error" });
				return;
			}
			// Clear any previous poll-error notice on success.
			setNotice((prev) => (prev?.tone === "error" ? null : prev));
			update((prev) =>
				BoardChecklist.withProgress(
					BoardNav.withSections(prev, result.value, feed.counts),
					feed.progress,
				),
			);
			if (feed.activity.ok) setActivity(feed.activity.value);
			const links = await BoardData.loadLinkedTaskIds(basePath, result.value);
			if (links.ok) setLinked(links.value);
			if (BoardNav.activeQuery(s.search)) void fireFts(s);
			if (s.view.type === "detail") void refreshDetail(s.view.taskId);
		},
		[
			basePath,
			filtersFor,
			fireFts,
			activitySource,
			refreshDetail,
			update,
			setNotice,
		],
	);

	// Initial load: detect scope, then build the first state scoped to the project (if any).
	// retryCount is in deps so `r` from the error screen re-triggers this effect.
	useEffect(() => {
		void retryCount;
		let cancelled = false;
		void (async () => {
			const detected = resolveScope ? await resolveScope(cwd) : null;
			const filters: BoardData.BoardFilters = detected
				? { scopeUri: detected.scopeUri }
				: {};
			const feed = await loadFeed(basePath, filters, activitySource);
			const result = feed.rows;
			if (cancelled) return;
			setScope(detected);
			if (feed.activity.ok) setActivity(feed.activity.value);
			if (result.ok) {
				const links = await BoardData.loadLinkedTaskIds(basePath, result.value);
				if (!cancelled && links.ok) setLinked(links.value);
			}
			if (result.ok) {
				const first = BoardNav.withCopilotPort(
					BoardNav.init(result.value, { scoped: Boolean(detected) }),
					{
						shortcuts: copilot?.shortcuts() ?? [],
						actor: copilot?.actor ?? null,
					},
				);
				set(
					BoardChecklist.withProgress(
						BoardDecisions.withCounts(first, feed.counts),
						feed.progress,
					),
				);
			} else setError(result.error.message);
		})();
		return () => {
			cancelled = true;
		};
	}, [cwd, basePath, resolveScope, activitySource, copilot, retryCount, set]);

	// 5s background poll — reloads with whatever filters are currently active.
	useEffect(() => {
		const timer = setInterval(() => {
			const current = ref.current;
			if (current) void reload(current);
		}, POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [reload, ref]);

	return { scope, scopeRef, activity, linked, error, retry, reload };
};

// Tier-2 FTS: debounced 200ms while typing, immediate on commit. Fires on every search query change
// so FTS results merge into the board alongside the instant client-side tier-1 filter. Hands back
// the search itself, which every reload fires again so its results stay merged.
const useSearch = (
	basePath: string,
	filtersFor: (s: BoardNav.BoardState) => BoardData.BoardFilters,
	{ state, ref, update }: Pick<BoardStore, "state" | "ref" | "update">,
): ((s: BoardNav.BoardState) => Promise<void>) => {
	// Fire the FTS tier-2 search and merge results into the current state.
	const fireFts = useCallback(
		async (s: BoardNav.BoardState): Promise<void> => {
			const query = BoardNav.activeQuery(s.search);
			if (!query) return;
			const result = await BoardData.searchBoard(
				basePath,
				query,
				filtersFor(s),
			);
			if (!result.ok) return;
			update((prev) => BoardNav.withSearchResults(prev, query, result.value));
		},
		[basePath, filtersFor, update],
	);

	const searchQuery = state?.search.mode !== "off" ? state?.search.query : null;
	const searchMode = state?.search.mode ?? "off";
	useEffect(() => {
		const current = ref.current;
		if (!current || searchMode === "off" || !searchQuery) return;
		// Committed queries fire immediately (user pressed enter).
		const delay = searchMode === "committed" ? 0 : 200;
		const timer = setTimeout(() => {
			const latest = ref.current;
			if (latest) void fireFts(latest);
		}, delay);
		return () => clearTimeout(timer);
	}, [searchQuery, searchMode, fireFts, ref]);
	return fireFts;
};
