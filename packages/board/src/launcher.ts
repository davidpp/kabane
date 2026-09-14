// Hands a linked issue's URI to the host OS. Structurally a sibling of Clipboard: one native command
// per platform, spawned, with the runner injectable so tests never shell out. It lives here and not in
// @cabane/core because core also runs on Cloudflare Workers, where `node:child_process` has no meaning;
// the CLI already depends on this package, so both callers reach it from one place.
import { spawn } from "node:child_process";
import { platform } from "node:os";
import { err, ok, type Result } from "@cabane/core";
import { Clipboard } from "./clipboard";

export namespace Launcher {
	// Where the URI actually went. `clipboard` is not a failure: over ssh or tmux there is no opener,
	// and handing the human a pasteable URL is the honest outcome.
	export type OpenMethod = "app" | "browser" | "clipboard";

	/** The identity of a linked issue, which is all opening it needs. */
	export type Target = {
		provider: string;
		identifier?: string;
		url: string;
	};

	// Resolves true when the URI was handed off. Injectable so tests skip the subprocess.
	export type Runner = (uri: string) => Promise<boolean>;
	// Resolves true when the text reached a clipboard. Injectable for the same reason.
	export type Copier = (text: string) => Promise<boolean>;

	type Command = { command: string; args: readonly string[] };

	/**
	 * The desktop-app URI for a provider that registers a scheme, else null.
	 * Linear is the only one today; GitHub registers none, so it opens on the web.
	 */
	export const deepLink = (target: Target): string | null => {
		if (target.provider.toLowerCase() !== "linear") return null;
		if (!target.identifier) return null;
		return `linear://issue/${target.identifier}`;
	};

	/** What the human calls this issue. The identifier when there is one, else the raw URL. */
	export const label = (target: Target): string =>
		target.identifier ?? target.url;

	// The OS handler command per platform. Windows routes through cmd's `start`, whose first quoted
	// argument is a window title rather than the URL — hence the empty string.
	export const nativeCommand = (
		os: NodeJS.Platform = platform(),
	): Command | null => {
		if (os === "darwin") return { command: "open", args: [] };
		if (os === "win32") return { command: "cmd", args: ["/c", "start", ""] };
		if (os === "linux") return { command: "xdg-open", args: [] };
		return null;
	};

	const runNative: Runner = (uri) =>
		new Promise((resolve) => {
			const handler = nativeCommand();
			if (!handler) {
				resolve(false);
				return;
			}
			const child = spawn(handler.command, [...handler.args, uri], {
				stdio: ["ignore", "ignore", "ignore"],
			});
			child.on("error", () => resolve(false));
			child.on("close", (code) => resolve(code === 0));
		});

	/**
	 * Try the desktop app, then the web URL, then the clipboard. The first two
	 * fail the same way — no handler registered, or no opener on this host — and
	 * the third is what makes the action still useful over ssh, where
	 * `Clipboard.write` falls through to its OSC 52 escape.
	 */
	export const open = async (
		target: Target,
		deps: { run?: Runner; copy?: Copier } = {},
	): Promise<Result<OpenMethod>> => {
		const run = deps.run ?? runNative;

		const app = deepLink(target);
		if (app && (await run(app))) return ok("app");
		if (await run(target.url)) return ok("browser");

		const copy =
			deps.copy ?? (async (text: string) => (await Clipboard.write(text)).ok);
		if (await copy(target.url)) return ok("clipboard");

		return err(new Error(`could not open ${label(target)}`));
	};
}
