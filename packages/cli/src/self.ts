// How this kabane runs itself again: the harness MCP entry, the copilot's session server and the
// loop's runner all spawn it. A binary from `bun build --compile` sees its own entry as
// `/$bunfs/root/<name>` in `process.argv[1]` and `Bun.main`, a virtual path nothing outside the
// process can run, and resolves `import.meta.url` inside that same virtual root.
// This belongs to the CLI host: it reads the Bun process.
import { existsSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { trySync } from "@kabane/core/result";

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

	// Homebrew's keg, `<prefix>/Cellar/kabane/<version>/`. Bun reports a binary's real path, and
	// `brew upgrade` removes the old keg, while `<prefix>/bin/kabane` links whichever is installed.
	const CELLAR = /^(.*)\/Cellar\/kabane\/[^/]+\//;

	// mise's install, `<mise data>/installs/<tool>/<version>/<path>`. `mise up` installs the next
	// version beside it and prunes this one, while `<tool>/latest` links the newest installed.
	// Not mise's shim: it picks a version per working directory and fails where none is set.
	const MISE_INSTALL = /^(.*\/installs\/[^/]+)\/[^/]+\/(.+)$/;

	// The link a package manager keeps to the binary at real path `execPath` across upgrades.
	const linkTo = (execPath: string): string | undefined => {
		const keg = CELLAR.exec(execPath);
		if (keg) return join(keg[1] ?? "", "bin/kabane");
		const mise = MISE_INSTALL.exec(execPath);
		return mise ? join(mise[1] ?? "", "latest", mise[2] ?? "") : undefined;
	};

	const realPath = (path: string): string | undefined => {
		const real = trySync(() => realpathSync(path));
		return real.ok ? real.value : undefined;
	};

	/**
	 * An executable path that runs kabane with no interpreter in front of it: the binary, or the
	 * entry script, whose hashbang finds bun on PATH. A source entry's hashbang also passes the
	 * production NODE_ENV define, through `env -S`; the bundle has the define built in. A binary in
	 * Homebrew's keg or a mise install is named by the link its manager keeps to it, so a path
	 * written down outlives an upgrade.
	 */
	export const executable = (
		host: Host = HOST,
		real: (path: string) => string | undefined = realPath,
	): string => {
		if (!compiled(host)) return host.entry ? resolve(host.entry) : "kabane";
		const linked = linkTo(host.execPath);
		return linked !== undefined && real(linked) === host.execPath
			? linked
			: host.execPath;
	};

	/**
	 * A launch that needs nothing on PATH: the binary alone, or the absolute bun with the entry
	 * script. A harness spawns its MCP servers with its own PATH, which often lacks ~/.bun/bin.
	 */
	export const launch = (host: Host = HOST): Launch =>
		compiled(host)
			? { command: host.execPath, args: [] }
			: { command: host.execPath, args: [host.main] };

	// A bun mise installed: `<mise data>/installs/bun/<version>/bin/bun`, and its version-free shim
	// `<mise data>/shims/bun`. The data directory is captured, not assumed, so MISE_DATA_DIR holds.
	const MISE_BUN = /^(.*)\/installs\/bun\/[^/]+\/bin\/bun$/;

	const isFile = (path: string): boolean =>
		existsSync(path) && statSync(path).isFile();

	/**
	 * `launch` for a config that outlives this process, the harness MCP entry: a mise-installed bun
	 * becomes mise's shim, which picks the pinned bun at each start, so a Bun bump leaves the entry
	 * working. Any other bun stays as `launch` has it, and a binary is named as `executable` names it.
	 */
	export const lasting = (
		host: Host = HOST,
		exists: (path: string) => boolean = isFile,
		real: (path: string) => string | undefined = realPath,
	): Launch => {
		const now = launch(host);
		if (compiled(host)) return { command: executable(host, real), args: [] };
		const data = MISE_BUN.exec(now.command)?.[1];
		const shim = data === undefined ? undefined : join(data, "shims/bun");
		return shim !== undefined && exists(shim) ? { ...now, command: shim } : now;
	};

	/**
	 * `executable` for a process that outlives an update, asked again each time it spawns kabane:
	 * the path this process started from while it is still there, else `kabane` on PATH, else null.
	 * Replacing the install deletes or moves the first and leaves the second, the newer kabane.
	 */
	export const current = (
		host: Host = HOST,
		exists: (path: string) => boolean = isFile,
		which: (name: string) => string | null = (name) => Bun.which(name),
	): string | null => {
		const recorded = executable(host);
		return recorded !== "kabane" && exists(recorded)
			? recorded
			: which("kabane");
	};
}
