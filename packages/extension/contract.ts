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
import type { z } from "zod";
import type { ParsedArgs } from "./args";
import type { Outcome } from "./outcome";
import type { Settings } from "./settings";

export type Extension = {
	/** What `config.json`'s `extensions` enables it by, and its trigger-id prefix on the board. */
	name: string;
	/**
	 * The schema of its settings namespace, which takes its name: what `<name>` in config.json,
	 * a project's `.kabane/<name>.json`, and the user's settings for a scope hold. Every layer is
	 * partial, so every key has a default or is optional; a strict schema refuses a typo.
	 */
	settings?: z.ZodTypeAny;
	/**
	 * How its settings read on a generated screen, by dotted path in the namespace (`budget.spend`):
	 * a label, a group, and where the choices come from. Optional, whole and per setting: a setting
	 * with none reads under its path, in its parent object's group or `Other`.
	 */
	looks?: Settings.Looks;
	commands?: readonly Extension.Command[];
	board?: (ctx: Extension.Ctx) => Promise<Extension.BoardPorts>;
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
		/**
		 * The mode harness sessions start in (`harness.mode` in the device config):
		 * `auto` is the harness's own auto mode, `default` selects none.
		 */
		harnessMode: "auto" | "default";
		/** Resolves a settings namespace through every layer, for the project at a directory. */
		settings: Settings.Port;
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
