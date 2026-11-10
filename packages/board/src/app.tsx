/** @jsxImportSource @opentui/react */
// The board's composition root. Each part of the board is a hook that owns its state and the effects
// it runs: the reducer's state (board-store), what the board reads (board-feed), the open detail
// view's records, the copilot's turns, the work running on the board's tasks, the writes to a task
// and its dispatch to the host, and the screen's renderables. App wires them to the ONE key and click
// router (board-input), whose reducer output runs through `runEffect` below, and draws Screen.
import { useRenderer } from "@opentui/react";
import { type ReactNode, useCallback } from "react";
import { useAnnouncement } from "./announcement";
import { useBoardFeed } from "./board-feed";
import { useBoardInput } from "./board-input";
import { useBoardStore } from "./board-store";
import { isCopilotEffect, useCopilotSession } from "./copilot-session";
import type { BoardData } from "./data";
import { useDetailRecords } from "./detail-records";
import { isDispatchEffect, useHostDispatch } from "./host-dispatch";
import type { BoardNav } from "./nav";
import { type SetNotice, useNotice } from "./notice";
import {
	type ActivitySource,
	type Announcer,
	type CardHeader,
	type Copilot,
	type Dispatcher,
	noAnnouncer,
	type SettingsSource,
} from "./ports";
import { ProgramStatus } from "./program-status";
import { isActivityEffect, useRunActivity } from "./run-activity";
import { isScreenEffect, Screen, useScreenRefs } from "./screen";
import { SettingsView } from "./settings-view";
import { isTaskEffect, useTaskActions } from "./task-actions";
import { useTheme } from "./theme";

export type AppProps = {
	cwd: string;
	// The storage handle the configured Db provider interprets (a directory for bun:sqlite).
	basePath: string;
	activity: ActivitySource;
	// Absent → `a` flashes "no dispatcher configured".
	dispatcher?: Dispatcher;
	// Absent → `A` flashes "no copilot configured".
	copilot?: Copilot;
	// Absent → the board opens on all scopes.
	resolveScope?: BoardData.ScopeResolver;
	// A host's own header for its cards, by card kind. Absent → every card tab heads with its title.
	headers?: Readonly<Record<string, CardHeader>>;
	// Absent → nothing is announced.
	announcer?: Announcer;
	// Absent → the `,` view says settings are not available here.
	settings?: SettingsSource;
	// Absent → the board opens on the board view.
	open?: { taskId: string };
	// Milliseconds, for how long a question has been on screen before a digit answers it
	// (BoardNav.ARM_MS). Absent → Date.now.
	clock?: () => number;
};

// Before the first load lands, or when it failed: the keys are useBoardInput's `r` and `q`.
const Loading = ({ error }: { error: string | null }): ReactNode => {
	const theme = useTheme();
	if (!error) return <text fg={theme.defaultFg}>Loading…</text>;
	return (
		<text fg={theme.failed}>
			Failed to load board: {error}
			{"\n"}
			<text fg={theme.muted}>press r to retry · q to quit</text>
		</text>
	);
};

// Each part's effect runner, and what the board runs itself.
type EffectRoutes = {
	task: ReturnType<typeof useTaskActions>;
	dispatch: ReturnType<typeof useHostDispatch>;
	copilot: ReturnType<typeof useCopilotSession>["runEffect"];
	activity: ReturnType<typeof useRunActivity>["runEffect"];
	screen: ReturnType<typeof useScreenRefs>["runEffect"];
	loadSettings: () => Promise<void>;
	reload: (next: BoardNav.BoardState) => Promise<void>;
	setNotice: SetNotice;
};

// The single effect runner, shared by the keyboard and mouse dispatchers so both interaction paths
// execute the reducer's output the same way: each effect goes to the part that owns it, and the
// board runs quit, reload and notice itself. `next` is the post-reduce state a reload merges into.
const useEffectRunner = ({
	task,
	dispatch,
	copilot,
	activity,
	screen,
	loadSettings,
	reload,
	setNotice,
}: EffectRoutes): ((
	next: BoardNav.BoardState,
	effect: BoardNav.Effect,
) => void) => {
	const renderer = useRenderer();
	return useCallback(
		(next: BoardNav.BoardState, effect: BoardNav.Effect): void => {
			if (isTaskEffect(effect)) return task(next, effect);
			if (isDispatchEffect(effect)) return dispatch(next, effect);
			if (isCopilotEffect(effect)) return copilot(next, effect);
			if (isActivityEffect(effect)) return activity(next, effect);
			if (isScreenEffect(effect)) return screen(effect);
			switch (effect.type) {
				case "quit":
					renderer.destroy();
					return;
				case "reload":
					void reload(next);
					return;
				case "loadSettings":
					void loadSettings();
					return;
				case "notice":
					setNotice(effect.notice);
			}
		},
		[
			renderer,
			reload,
			task,
			dispatch,
			copilot,
			activity,
			screen,
			loadSettings,
			setNotice,
		],
	);
};

export const App = ({
	cwd,
	basePath,
	activity: activitySource,
	dispatcher,
	copilot,
	resolveScope,
	headers,
	announcer = noAnnouncer,
	settings,
	open,
	clock = Date.now,
}: AppProps): ReactNode => {
	const store = useBoardStore(clock);
	const [notice, setNotice] = useNotice();
	const detail = useDetailRecords(basePath, store);
	const { scope, scopeRef, activity, linked, error, retry, reload } =
		useBoardFeed({
			cwd,
			basePath,
			activitySource,
			resolveScope,
			copilot,
			open,
			store,
			setNotice,
			refreshDetail: detail.refresh,
		});
	const {
		log: copilotLog,
		current: currentLog,
		runEffect: runCopilotEffect,
	} = useCopilotSession({
		copilot,
		basePath,
		store,
		scopeRef,
		reload,
		setNotice,
	});
	const {
		shown: shownActivity,
		source: shownSource,
		takeCard,
		runEffect: runActivityEffect,
	} = useRunActivity({
		basePath,
		activity,
		activitySource,
		copilotLog,
		currentLog,
		store,
		setNotice,
		reload,
	});

	useAnnouncement(announcer, store);

	// The terminal hears when the board waits on the human, or works.
	ProgramStatus.useBoardStatus(store.state, activity.cards);

	const { refs, runEffect: runScreenEffect } = useScreenRefs(store.state);
	const runTaskEffect = useTaskActions({ basePath, store, setNotice, reload });
	const runDispatchEffect = useHostDispatch({
		basePath,
		dispatcher,
		copilot,
		store,
		setNotice,
		reload,
	});

	// The `,` view's rows, read now that it is open and never at board start.
	const { update } = store;
	const loadSettings = useCallback(async (): Promise<void> => {
		const listed = settings ? await settings.list() : undefined;
		const rows: SettingsView.Rows = !listed
			? { type: "unavailable" }
			: listed.ok
				? { type: "ready", rows: listed.value }
				: { type: "failed", error: listed.error.message };
		update((prev) => SettingsView.withRows(prev, rows));
	}, [settings, update]);

	const runEffect = useEffectRunner({
		task: runTaskEffect,
		dispatch: runDispatchEffect,
		copilot: runCopilotEffect,
		activity: runActivityEffect,
		screen: runScreenEffect,
		loadSettings,
		reload,
		setNotice,
	});

	const input = useBoardInput({
		store,
		clock,
		error,
		retry,
		runEffect,
		refs,
	});

	if (error || !store.state) return <Loading error={error} />;

	return (
		<Screen
			state={store.state}
			scope={scope}
			notice={notice}
			linked={linked}
			headers={headers}
			log={copilotLog}
			activity={shownActivity}
			source={shownSource}
			records={detail.records}
			refs={refs}
			input={input}
			onCard={takeCard}
		/>
	);
};
