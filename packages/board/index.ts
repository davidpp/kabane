// Public entry for @cabane/board. JSX-free on purpose: the render lifecycle lives in src/start.tsx so
// consumers that reach startBoard's type (e.g. the CLI) don't need OpenTUI's jsxImportSource.
export { App, type AppProps } from "./src/app";
export { Board, type BoardProps } from "./src/board";
export { BoardContext } from "./src/context";
export { BoardData } from "./src/data";
// Exported for the CLI: `kabane open` walks the same app → browser → clipboard chain the `O` key does.
export { Launcher } from "./src/launcher";
export type {
	ActivityCard,
	ActivityEvent,
	ActivitySource,
	ActivityStatus,
	Copilot,
	CopilotShortcut,
	CopilotUpdate,
	Dispatcher,
	DispatchTarget,
	TriggerDescriptor,
	TriggerInput,
} from "./src/ports";
export { noActivity, noCopilot, noDispatcher } from "./src/ports";
export { type SetupDeps, startSetup } from "./src/setup";
export { SetupPlan } from "./src/setup-plan";
export { type BoardDeps, startBoard } from "./src/start";
