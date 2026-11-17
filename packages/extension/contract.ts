/**
 * The extension contract: a plain object returned by a directory extension's factory.
 * It lives outside the CLI so hosts and extensions share the contract without
 * extensions depending on a host implementation.
 */

import type { ToolDef } from "@cabane/core";
import type { z } from "zod";
import type { ParsedArgs } from "./args";
import type { Doctor } from "./doctor";
import type { Outcome } from "./outcome";
import type { ActivitySource, Dispatcher, Header, JobSource } from "./ports";
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
	doctor?: Doctor.Source["doctor"];
	commands?: readonly Extension.Command[];
	board?: (ctx: Extension.Ctx) => Promise<Extension.BoardPorts>;
	/** Device MCP vocabulary and tools, named `kabane_<extension>_<verb>`. */
	mcp?: (
		ctx: Extension.Ctx,
	) => Promise<{ instructions?: string; tools?: readonly ToolDef[] }>;
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
		headers?: Readonly<Record<string, Header>>;
		/** Facts about the device's jobs, for the board's Jobs tab, whatever scope they are in. */
		jobs?: JobSource;
	};
}
