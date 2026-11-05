// How this kabane runs itself again: the harness MCP entry, the copilot's session server and the
// loop's runner all spawn it, and its readers find the templates shipped beside it. A binary from
// `bun build --compile` sees its own entry as `/$bunfs/root/<name>` in `process.argv[1]` and
// `Bun.main`, a virtual path nothing outside the process can run, and resolves `import.meta.url`
// inside that same virtual root. Off the package barrel: it reads the Bun process, which the hub
// does not have.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { trySync } from "./result";

export namespace Self {
	/** What the process says about itself. Tests pass their own. */
	export type Host = {
		/** A module's `import.meta.url`: inside the embedded filesystem when compiled. */
		moduleUrl: string;
		/** The real executable: bun for a script, the binary itself when compiled. */
		execPath: string;
		/** `Bun.main`, the entry script. */
		main: string;
		/** `process.argv[1]`, the entry as it was invoked. */
		entry: string | undefined;
	};

	export type Launch = { command: string; args: string[] };

	const HOST: Host = {
		moduleUrl: import.meta.url,
		execPath: process.execPath,
		main: Bun.main,
		entry: process.argv[1],
	};

	// The embedded filesystem's root as Bun names it, from the start of a file URL's decoded path:
	// `/$bunfs/root/` on Unix, `B:/~BUN/root/` on Windows. Anchored, because a directory of the
	// user's own may hold either string further along.
	const EMBEDDED_ROOT = /^\/(?:\$bunfs|B:\/~BUN)\/root\//;

	// A `file:` URL's path, percent-decoded (`%7EBUN`); left encoded if it does not decode.
	const pathOf = (url: string): string => {
		const path = url.startsWith("file://") ? url.slice("file://".length) : url;
		const decoded = trySync(() => decodeURIComponent(path));
		return decoded.ok ? decoded.value : path;
	};

	/** Whether this is a standalone binary from `bun build --compile`. */
	export const compiled = (host: Host = HOST): boolean =>
		EMBEDDED_ROOT.test(pathOf(host.moduleUrl));

	/**
	 * An executable path that runs kabane with no interpreter in front of it: the binary, or the
	 * entry script, whose `#!/usr/bin/env bun` shebang finds bun on PATH.
	 */
	export const executable = (host: Host = HOST): string => {
		if (compiled(host)) return host.execPath;
		return host.entry ? resolve(host.entry) : "kabane";
	};

	/**
	 * A launch that needs nothing on PATH: the binary alone, or the absolute bun with the entry
	 * script. A harness spawns its MCP servers with its own PATH, which often lacks ~/.bun/bin.
	 */
	export const launch = (host: Host = HOST): Launch =>
		compiled(host)
			? { command: host.execPath, args: [] }
			: { command: host.execPath, args: [host.main] };

	/**
	 * The directory of the shipped template `name`. A binary's archive carries `templates/` beside
	 * the executable; anywhere else it is `../templates/<name>` from the reading module (`from`, its
	 * `import.meta.url`): the package's own directory in the workspace, `templates/` beside `bin/`
	 * in the published package.
	 */
	export const templates = (
		name: string,
		from: string,
		host: Host = HOST,
	): string =>
		compiled(host)
			? join(dirname(host.execPath), "templates", name)
			: fileURLToPath(new URL(`../templates/${name}`, from));
}
