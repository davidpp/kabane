// Public entry for @cabane/board. JSX-free on purpose: the render lifecycle lives in src/start.tsx so
// consumers that reach startBoard's type (e.g. the CLI) don't need OpenTUI's jsxImportSource.
export { App, type AppProps } from "./src/app";
export { Board, type BoardProps } from "./src/board";
export { BoardContext } from "./src/context";
export { BoardData } from "./src/data";
export type {
	ActivityCard,
	ActivityEvent,
	ActivitySource,
	ActivityStatus,
	Dispatcher,
	DispatchTarget,
	TriggerDescriptor,
	TriggerInput,
} from "./src/ports";
export { noActivity, noDispatcher } from "./src/ports";
export { type BoardDeps, startBoard } from "./src/start";
