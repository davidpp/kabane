// Public entry for @cabane/extension: the contract, plus the argument parsing and outcomes every
// command, built-in or extension, is written with.
export {
	flagBool,
	flagCsv,
	flagList,
	flagString,
	type ParsedArgs,
	parseArgs,
} from "./args";
export type { Extension } from "./contract";
export {
	conciseSuccess,
	failure,
	type Outcome,
	success,
	usage,
} from "./outcome";
