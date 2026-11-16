// How this kabane runs itself again: the harness MCP entry, the copilot's session server and the
// loop's runner all spawn it. A binary from `bun build --compile` sees its own entry as
// `/$bunfs/root/<name>` in `process.argv[1]` and `Bun.main`, a virtual path nothing outside the
// process can run, and resolves `import.meta.url` inside that same virtual root.
// This belongs to the CLI host: it reads the Bun process.
import { resolve } from "node:path";
import { trySync } from "@cabane/core/result";

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

	type Launch = { command: string; args: string[] };

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
	 * entry script, whose hashbang finds bun on PATH. A source entry's hashbang also passes the
	 * production NODE_ENV define, through `env -S`; the bundle has the define built in.
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
}
