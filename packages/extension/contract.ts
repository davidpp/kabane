/**
 * The extension contract: a plain object the CLI keeps in its list of official
 * extensions. It lives outside the CLI because the CLI imports every extension,
 * so an extension importing the CLI would be a cycle.
 */

import type {
	ActivitySource,
	CardHeader,
	Dispatcher,
} from "@cabane/board/ports";
import type { ParsedArgs } from "./args";
import type { Outcome } from "./outcome";

export type Extension = {
	/** What `config.json`'s `extensions` enables it by, and its trigger-id prefix on the board. */
	name: string;
	commands?: readonly Extension.Command[];
	board?: (ctx: Extension.Ctx) => Extension.BoardPorts;
};

export namespace Extension {
	/** What every command runs with. The CLI's own commands also get the device config. */
	export type Ctx = {
		/** KABANE_HOME: where config.json lives. */
		home: string;
		/** The storage handle every core call receives (the database's directory). */
		store: string;
		cwd: string;
		/** The actor for this invocation: `--as`, else the configured one. */
		actor: string;
	};

	export type Command<C extends Ctx = Ctx> = {
		name: string;
		usage: string;
		summary: string;
		/** Runs without a config file (init, help). */
		standalone?: boolean;
		run: (args: ParsedArgs, ctx: C) => Promise<Outcome>;
	};

	/**
	 * What an extension adds to the board, merged with every other enabled
	 * extension's. `headers` are its own card headers, by the card kind its
	 * activity source names.
	 */
	export type BoardPorts = {
		activity?: ActivitySource;
		dispatcher?: Dispatcher;
		headers?: Readonly<Record<string, CardHeader>>;
	};
}
