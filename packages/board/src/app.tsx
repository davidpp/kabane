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
import { useNotice } from "./notice";
import {
	type ActivitySource,
	type Announcer,
	type CardHeader,
	type Copilot,
	type Dispatcher,
	noAnnouncer,
} from "./ports";
import { ProgramStatus } from "./program-status";
import { isActivityEffect, useRunActivity } from "./run-activity";
import { isScreenEffect, Screen, useScreenRefs } from "./screen";
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

export const App = ({
	cwd,
	basePath,
	activity: activitySource,
	dispatcher,
	copilot,
	resolveScope,
	headers,
	announcer = noAnnouncer,
	clock = Date.now,
}: AppProps): ReactNode => {
	const renderer = useRenderer();
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

	// The single effect runner, shared by the keyboard and mouse dispatchers so both interaction paths
	// execute the reducer's output the same way. `next` is the post-reduce state a reload merges into.
	const runEffect = useCallback(
		(next: BoardNav.BoardState, effect: BoardNav.Effect): void => {
			if (isTaskEffect(effect)) return runTaskEffect(next, effect);
			if (isDispatchEffect(effect)) return runDispatchEffect(next, effect);
			if (isCopilotEffect(effect)) return runCopilotEffect(next, effect);
			if (isActivityEffect(effect)) return runActivityEffect(next, effect);
			if (isScreenEffect(effect)) return runScreenEffect(effect);
			switch (effect.type) {
				case "quit":
					renderer.destroy();
					return;
				case "reload":
					void reload(next);
					return;
				case "notice":
					setNotice(effect.notice);
			}
		},
		[
			renderer,
			reload,
			runTaskEffect,
			runDispatchEffect,
			runCopilotEffect,
			runActivityEffect,
			runScreenEffect,
			setNotice,
		],
	);

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
