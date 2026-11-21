import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { Self } from "./self";

const SCRIPT: Self.Host = {
	moduleUrl:
		"file:///home/me/.bun/install/global/node_modules/kabane/bin/kabane.js",
	execPath: "/home/me/.bun/bin/bun",
	main: "/home/me/.bun/install/global/node_modules/kabane/bin/kabane.js",
	entry: "/home/me/.bun/bin/kabane",
};

// What a probe binary printed on Bun 1.4.2: argv[1] and Bun.main are the embedded entry.
const BINARY: Self.Host = {
	moduleUrl: "file:///$bunfs/root/kabane",
	execPath: "/opt/kabane/kabane",
	main: "/$bunfs/root/kabane",
	entry: "/$bunfs/root/kabane",
};

describe("Self.compiled", () => {
	it("knows the embedded filesystem by each name Bun gives it", () => {
		for (const moduleUrl of [
			"file:///$bunfs/root/kabane",
			"file:///B:/~BUN/root/kabane.exe",
			"file:///B:/%7EBUN/root/kabane.exe",
		])
			expect(Self.compiled({ ...BINARY, moduleUrl })).toBe(true);
	});

	it("is false for a user path that holds those names past its root", () => {
		for (const moduleUrl of [
			"file:///home/me/~BUN-project/node_modules/kabane/bin/kabane.js",
			"file:///home/me/%7EBUN/node_modules/kabane/bin/kabane.js",
			"file:///home/me/$bunfs/root/kabane.js",
			"file:///C:/Users/me/~BUN/root/kabane.js",
			"file:///$bunfs-old/root/kabane.js",
		])
			expect(Self.compiled({ ...SCRIPT, moduleUrl })).toBe(false);
	});

	it("is false for a script on disk, and for this test run", () => {
		expect(Self.compiled(SCRIPT)).toBe(false);
		expect(Self.compiled()).toBe(false);
	});
});

describe("Self.launch", () => {
	it("runs a script as the absolute bun with its entry", () => {
		expect(Self.launch(SCRIPT)).toEqual({
			command: "/home/me/.bun/bin/bun",
			args: [SCRIPT.main],
		});
	});

	it("runs a binary as itself, never its embedded entry", () => {
		expect(Self.launch(BINARY)).toEqual({
			command: "/opt/kabane/kabane",
			args: [],
		});
	});
});

describe("Self.executable", () => {
	it("is a script's entry as invoked, resolved", () => {
		expect(Self.executable(SCRIPT)).toBe("/home/me/.bun/bin/kabane");
		expect(Self.executable({ ...SCRIPT, entry: "bin/kabane" })).toBe(
			resolve("bin/kabane"),
		);
	});

	it("is the binary itself when compiled", () => {
		expect(Self.executable(BINARY)).toBe("/opt/kabane/kabane");
	});

	it("falls back to kabane on PATH with no entry", () => {
		expect(Self.executable({ ...SCRIPT, entry: undefined })).toBe("kabane");
	});
});

describe("Self.current", () => {
	const onPath = () => "/home/me/.local/bin/kabane";

	it("is the path this process started from while it is still there", () => {
		expect(Self.current(SCRIPT, () => true, onPath)).toBe(
			"/home/me/.bun/bin/kabane",
		);
	});

	it("is kabane on PATH once that path is gone", () => {
		expect(Self.current(SCRIPT, () => false, onPath)).toBe(
			"/home/me/.local/bin/kabane",
		);
	});

	it("is null when neither is left", () => {
		expect(
			Self.current(
				SCRIPT,
				() => false,
				() => null,
			),
		).toBeNull();
	});
});

describe("Self.upgraded", () => {
	const KEG: Self.Host = {
		...BINARY,
		execPath: "/opt/homebrew/Cellar/kabane/1.0.0/libexec/kabane",
	};
	const MISE: Self.Host = {
		...BINARY,
		execPath: "/home/me/.local/share/mise/installs/kabane/1.0.0/kabane",
	};
	const none = () => null;

	it("is the link brew or mise keeps, which an upgrade moved off this binary", () => {
		// brew upgrade removed the 1.0.0 keg; only the link is left.
		expect(
			Self.upgraded(KEG, (path) => path === "/opt/homebrew/bin/kabane", none),
		).toBe("/opt/homebrew/bin/kabane");
		expect(Self.upgraded(MISE, () => true, none)).toBe(
			"/home/me/.local/share/mise/installs/kabane/latest/kabane",
		);
	});

	it("is the binary itself, which kabane update replaced in place", () => {
		expect(Self.upgraded(BINARY, () => true, none)).toBe("/opt/kabane/kabane");
	});
});

describe("Self.lasting", () => {
	const MISE: Self.Host = {
		...SCRIPT,
		execPath: "/home/me/.local/share/mise/installs/bun/1.4.4/bin/bun",
	};
	const SHIM = "/home/me/.local/share/mise/shims/bun";

	it("names mise's shim for a mise-installed bun, when the shim is there", () => {
		expect(Self.lasting(MISE, (path) => path === SHIM)).toEqual({
			command: SHIM,
			args: [SCRIPT.main],
		});
	});

	it("keeps the versioned bun when there is no shim to point at", () => {
		expect(Self.lasting(MISE, () => false)).toEqual(Self.launch(MISE));
	});

	it("follows a moved mise data directory", () => {
		const host = {
			...SCRIPT,
			execPath: "/data/mise/installs/bun/latest/bin/bun",
		};
		expect(Self.lasting(host, () => true).command).toBe("/data/mise/shims/bun");
	});

	it("leaves any other bun, and a binary, as launch has them", () => {
		expect(Self.lasting(SCRIPT, () => true)).toEqual(Self.launch(SCRIPT));
		expect(
			Self.lasting(
				{
					...BINARY,
					execPath: "/home/me/.local/share/mise/installs/bun/1/bin/bun",
				},
				() => true,
			),
		).toEqual({
			command: "/home/me/.local/share/mise/installs/bun/1/bin/bun",
			args: [],
		});
	});
});

describe("a binary in Homebrew's keg", () => {
	const KEG = "/opt/homebrew/Cellar/kabane/1.0.0/libexec/kabane";
	const LINK = "/opt/homebrew/bin/kabane";
	const host = { ...BINARY, execPath: KEG };

	it("is named by Homebrew's link to it, which an upgrade keeps", () => {
		const real = (path: string) => (path === LINK ? KEG : undefined);
		expect(Self.executable(host, real)).toBe(LINK);
		expect(Self.lasting(host, () => true, real)).toEqual({
			command: LINK,
			args: [],
		});
	});

	it("keeps its own path when the link is gone or names another kabane", () => {
		expect(Self.executable(host, () => undefined)).toBe(KEG);
		expect(
			Self.executable(
				host,
				() => "/opt/homebrew/Cellar/kabane/1.1.0/libexec/kabane",
			),
		).toBe(KEG);
	});
});

describe("a binary mise installed", () => {
	const INSTALL =
		"/home/me/.local/share/mise/installs/github-davidpp-kabane/1.0.0/kabane";
	const LATEST =
		"/home/me/.local/share/mise/installs/github-davidpp-kabane/latest/kabane";
	const host = { ...BINARY, execPath: INSTALL };

	it("is named by mise's latest link, which an upgrade and its prune keep", () => {
		const real = (path: string) => (path === LATEST ? INSTALL : undefined);
		expect(Self.executable(host, real)).toBe(LATEST);
		expect(Self.lasting(host, () => true, real)).toEqual({
			command: LATEST,
			args: [],
		});
	});

	it("follows a moved data directory and a binary below the version", () => {
		const nested = "/data/mise/installs/kabane/1.0.0/bin/kabane";
		const link = "/data/mise/installs/kabane/latest/bin/kabane";
		expect(
			Self.executable({ ...BINARY, execPath: nested }, (path) =>
				path === link ? nested : undefined,
			),
		).toBe(link);
	});

	it("keeps its own path when latest is a newer kabane or missing", () => {
		expect(
			Self.executable(
				host,
				() =>
					"/home/me/.local/share/mise/installs/github-davidpp-kabane/1.1.0/kabane",
			),
		).toBe(INSTALL);
		expect(Self.executable(host, () => undefined)).toBe(INSTALL);
	});
});

describe("Self.extensions", () => {
	// Each path resolves to itself, or to what `links` says it links to.
	const resolver =
		(present: readonly string[], links: Record<string, string> = {}) =>
		(path: string) =>
			links[path] ?? (present.includes(path) ? path : undefined);

	it("is the directory beside a plain or installer-placed binary", () => {
		expect(Self.extensions(BINARY, resolver(["/opt/kabane/extensions"]))).toBe(
			"/opt/kabane/extensions",
		);
	});

	it("is named through Homebrew's opt link to the keg", () => {
		const keg = "/opt/homebrew/Cellar/kabane/1.0.0/libexec/extensions";
		const host = {
			...BINARY,
			execPath: "/opt/homebrew/Cellar/kabane/1.0.0/libexec/kabane",
		};
		expect(
			Self.extensions(
				host,
				resolver([keg], { "/opt/homebrew/opt/kabane/libexec/extensions": keg }),
			),
		).toBe("/opt/homebrew/opt/kabane/libexec/extensions");
		// opt names a newer keg: this binary's own directory is the honest answer.
		expect(Self.extensions(host, resolver([keg]))).toBe(keg);
	});

	it("is named through mise's latest link", () => {
		const install = "/data/mise/installs/kabane/1.0.0/kabane/extensions";
		const latest = "/data/mise/installs/kabane/latest/kabane/extensions";
		expect(
			Self.extensions(
				{
					...BINARY,
					execPath: "/data/mise/installs/kabane/1.0.0/kabane/kabane",
				},
				resolver([install], { [latest]: install }),
			),
		).toBe(latest);
	});

	it("is undefined for a source run or a binary with nothing beside it", () => {
		expect(Self.extensions(SCRIPT, () => "/anything")).toBeUndefined();
		expect(Self.extensions(BINARY, () => undefined)).toBeUndefined();
	});
});
