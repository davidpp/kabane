/** @jsxImportSource @opentui/react */
// Renderer lifecycle for the board. Owns the renderer: create it, mount the App, and always destroy
// it (try/finally) so a crash still restores the terminal. The host has already called
// `Runtime.configure` with a Db provider; the board only needs the base path that provider reads.

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard, useRenderer } from "@opentui/react";
import type { ReactNode } from "react";
import { App } from "./app";
import type { BoardData } from "./data";
import { ErrorBoundary } from "./error-boundary";
import {
	type ActivitySource,
	type Copilot,
	type Dispatcher,
	noActivity,
} from "./ports";
import { Theme, ThemeProvider, useTheme } from "./theme";

export type BoardDeps = {
	// Working directory the board was launched from — handed to `resolveScope`.
	cwd: string;
	// Storage handle for the configured Db provider (a directory for bun:sqlite).
	basePath: string;
	// Host activity feed. Default: none, the sidebar shows "no activity".
	activity?: ActivitySource;
	// Host dispatch. Default: none, `a` flashes "no dispatcher configured".
	dispatcher?: Dispatcher;
	// The `A` prompt's copilot. Default: none, `A` flashes "no copilot configured".
	copilot?: Copilot;
	// How cwd maps to a scope. Default: none, the board opens on all scopes.
	resolveScope?: BoardData.ScopeResolver;
};

// Last-resort fallback if a render throws past App: show the error, offer `q` to quit. startBoard's
// finally still destroys the renderer, so the terminal is restored either way.
const CrashScreen = ({ error }: { error: Error }): ReactNode => {
	const renderer = useRenderer();
	const theme = useTheme();
	useKeyboard((key) => {
		if (key.name === "q") renderer.destroy();
	});
	return (
		<box style={{ flexDirection: "column", flexGrow: 1 }}>
			<text fg={theme.failed}>Board crashed: {error.message}</text>
			<text fg={theme.muted}>q quit</text>
		</box>
	);
};

export const startBoard = async (deps: BoardDeps): Promise<void> => {
	const renderer = await createCliRenderer({ exitOnCtrlC: true });
	try {
		// Once, before the first frame: every surface below reads its colours from this.
		const theme = await Theme.detect(renderer);
		createRoot(renderer).render(
			<ThemeProvider value={theme}>
				<ErrorBoundary fallback={(error) => <CrashScreen error={error} />}>
					<App
						cwd={deps.cwd}
						basePath={deps.basePath}
						activity={deps.activity ?? noActivity}
						dispatcher={deps.dispatcher}
						copilot={deps.copilot}
						resolveScope={deps.resolveScope}
					/>
				</ErrorBoundary>
			</ThemeProvider>,
		);
		// Resolve when the user quits (`q` or Ctrl-C both call renderer.destroy()).
		await new Promise<void>((resolve) => {
			renderer.on("destroy", resolve);
		});
	} finally {
		if (!renderer.isDestroyed) renderer.destroy();
	}
};
