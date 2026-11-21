import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "@kabane/extension";
import { version } from "../package.json";
import { type Host, runUpdate } from "./commands/update";
import { UpdateBinary } from "./update-binary";
import { updateSnapshot } from "./update-fixture";
import { runUpdateProcess } from "./update-process";
import { isPrerelease } from "./update-version";

// Real release archives for this machine, built by the release script and served by a real
// server on localhost; only the GitHub releases listed and the paths they hang off are made up.
const ROOT = resolve(import.meta.dir, "../../..");
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "kabane-update-binary-")));
const TARGET = UpdateBinary.target() ?? "";
const FILE = `kabane-${TARGET}.tar.gz`;

/**
 * The next version of the same length on the source's own channel and major: the last digit that
 * is not a 9 goes up, and the digits after it go to 0. The binary's version is patched in place,
 * so its length cannot change.
 */
const next = (from: string): string => {
	const digits = [...from];
	for (let index = digits.length - 1; index >= 0; index--) {
		const digit = digits[index] ?? "";
		if (!/\d/.test(digit)) continue;
		if (digit !== "9") {
			digits[index] = String(Number(digit) + 1);
			return digits.join("");
		}
		digits[index] = "0";
	}
	return from;
};
const NEXT = next(version);
/** The releases API's list, newest first: NEXT, as a prerelease when it is a beta. */
const RELEASES = [
	{ tag_name: `v${NEXT}`, draft: false, prerelease: isPrerelease(NEXT) },
	{ tag_name: "v0.3.0", draft: false, prerelease: false },
];
const LATEST = RELEASES.find((release) => !release.prerelease);
const API = ["/releases/latest", "/releases"];

const sha256 = (file: string): string =>
	new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");
const run = (argv: string[], cwd = WORK) =>
	Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });

let built = "", // the archive the build script made: kabane at `version`
	repacked = "", // the same archive with its executable patched to say NEXT
	nextExecutable = "";

/** `archive` extracted into `dir`, its executable's version literal swapped for `to`. */
const repack = (archive: string, to: string): string => {
	const dir = join(WORK, `repack-${to}`);
	mkdirSync(dir);
	expect(run(["tar", "-xzf", archive, "-C", dir]).exitCode).toBe(0);
	nextExecutable = join(dir, "kabane/kabane");
	const bytes = readFileSync(nextExecutable).toString("latin1");
	const literal = JSON.stringify(version);
	expect(bytes.includes(literal)).toBe(true);
	rmSync(nextExecutable);
	writeFileSync(
		nextExecutable,
		Buffer.from(bytes.replaceAll(literal, JSON.stringify(to)), "latin1"),
		{ mode: 0o755 },
	);
	// Patched bytes break a Mach-O's ad-hoc signature, which arm64 macOS enforces.
	if (process.platform === "darwin")
		expect(
			run(["codesign", "--force", "--sign", "-", nextExecutable]).exitCode,
		).toBe(0);
	expect(run([nextExecutable, "--version"]).stdout.toString().trim()).toBe(to);
	const out = join(WORK, `next-${FILE}`);
	expect(
		run(["tar", "--format=ustar", "-czf", out, "-C", dir, "kabane"]).exitCode,
	).toBe(0);
	return out;
};

beforeAll(() => {
	expect(TARGET).not.toBe("");
	expect(NEXT.length).toBe(version.length);
	const out = join(WORK, "built");
	const result = run(
		[process.execPath, "scripts/build-binary.ts", TARGET, out],
		ROOT,
	);
	expect(result.stderr.toString()).toContain(FILE);
	built = join(out, FILE);
	repacked = repack(built, NEXT);
}, 120_000);

// What the release server answers, set per test, and every path kabane asked it for.
type Release = { archive: string; sums: string };
let release: Release = { archive: "", sums: "" };
const requests: string[] = [];
const server = Bun.serve({
	port: 0,
	fetch: (request): Response => {
		const path = new URL(request.url).pathname;
		// Only kabane's own: another local tool may probe any open port.
		if (request.headers.get("user-agent")?.startsWith("kabane/"))
			requests.push(path);
		// The same assets one redirect away, at a name http may reach (127.0.0.1) and one it may not
		// (0.0.0.0, still this machine, so a redirect that was followed would be answered), and
		// two away, through 0.0.0.0 and back to 127.0.0.1.
		const hop = /^\/(loopback|elsewhere|through)(\/.*)$/.exec(path);
		if (hop?.[1] === "through")
			return Response.redirect(
				`http://0.0.0.0:${server.port}/loopback${hop[2]}`,
				302,
			);
		if (hop)
			return Response.redirect(
				`http://${hop[1] === "loopback" ? "127.0.0.1" : "0.0.0.0"}:${server.port}/download${hop[2]}`,
				302,
			);
		if (path === "/releases/latest") return Response.json(LATEST);
		if (path === "/releases") return Response.json(RELEASES);
		if (path === `/download/v${NEXT}/SHA256SUMS`)
			return new Response(release.sums);
		if (path === `/download/v${NEXT}/${FILE}`)
			return new Response(Bun.file(release.archive));
		return new Response("not found", { status: 404 });
	},
});
afterAll(async () => {
	await server.stop(true);
	rmSync(WORK, { recursive: true, force: true });
});

const serve = (archive: string, sums = `${sha256(archive)}  ${FILE}\n`) => {
	release = {
		archive,
		// Another target's line beside it, as the release's SHA256SUMS lists all of them.
		sums: `${"0".repeat(64)}  kabane-other-target.tar.gz\n${sums}`,
	};
	requests.length = 0;
};

/**
 * An extracted release at `dir` with a PATH symlink to its executable. The installed bytes are
 * a stand-in: the updater never runs the old executable, only replaces it.
 */
const install = (dir: string) => {
	const base = mkdtempSync(join(WORK, "case-"));
	const home = join(base, "home");
	const directory = join(base, dir);
	mkdirSync(join(directory, "templates/dispatch"), { recursive: true });
	mkdirSync(join(directory, "extensions/dispatch"), { recursive: true });
	writeFileSync(join(directory, "extensions/dispatch/retired.js"), "old\n");
	mkdirSync(join(base, "bin"));
	mkdirSync(home);
	const executable = join(directory, "kabane");
	writeFileSync(executable, `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
	writeFileSync(join(directory, "templates/dispatch/retired.md"), "old\n");
	writeFileSync(join(directory, "README.md"), "kept\n");
	const link = join(base, "bin/kabane");
	symlinkSync(executable, link);
	return { base, home, directory, executable, link };
};

const update = (
	argv: string[],
	link: string,
	env: NodeJS.ProcessEnv,
	over: Partial<Host> = {},
) =>
	runUpdate(
		parseArgs(argv),
		{
			bin: link,
			bun: process.execPath,
			env: { PATH: "/usr/bin:/bin", ...env },
			compiled: true,
			mainBuild: undefined,
			target: TARGET,
			source: {
				api: `${server.url.origin}/releases`,
				releases: `${server.url.origin}/download`,
			},
			...over,
		},
		version,
	);

const leftovers = (directory: string): string[] =>
	readdirSync(directory).filter(
		(name) =>
			name.startsWith(".kabane-update-") ||
			name.startsWith("templates.") ||
			name.startsWith("extensions."),
	);

test("--check reads the releases API alone and changes nothing", async () => {
	serve(repacked);
	const installed = install("opt/kabane");
	const before = updateSnapshot(installed.base);
	const checked = await update(["--check"], installed.link, {
		HOME: installed.home,
	});
	expect(checked).toMatchObject({
		exitCode: 0,
		json: {
			status: "candidate",
			install: "binary",
			installedVersion: version,
			candidateVersion: NEXT,
		},
	});
	expect(requests).toEqual(API);
	expect(updateSnapshot(installed.base)).toEqual(before);
}, 30_000);

test("update replaces the real executable behind a symlink, and its templates and extensions, with the verified release", async () => {
	serve(repacked);
	const installed = install("opt/kabane");
	// An extension enabled from this install, linked through the install's path.
	const linked = join(installed.home, ".kabane/extensions/dispatch");
	mkdirSync(dirname(linked), { recursive: true });
	symlinkSync(join(installed.directory, "extensions/dispatch"), linked);
	const updated = await update([], installed.link, { HOME: installed.home });
	expect(updated).toMatchObject({
		exitCode: 0,
		json: {
			status: "updated",
			install: "binary",
			eligibility: "checksum_verified",
			candidateVersion: NEXT,
			restartRequired: true,
		},
	});
	// The link is untouched and the file behind it is the release's executable.
	expect(readlinkSync(installed.link)).toBe(installed.executable);
	expect(sha256(installed.executable)).toBe(sha256(nextExecutable));
	const printed = await runUpdateProcess(
		[installed.link, "--version"],
		installed.base,
		{ HOME: installed.home },
	);
	expect(printed.ok && printed.value.stdout.trim()).toBe(NEXT);
	const templates = join(installed.directory, "templates");
	expect(existsSync(join(templates, "dispatch/retired.md"))).toBe(false);
	expect(readdirSync(templates).sort()).toEqual(
		readdirSync(join(WORK, `repack-${NEXT}/kabane/templates`)).sort(),
	);
	const extensions = join(installed.directory, "extensions");
	expect(readdirSync(extensions).sort()).toEqual([
		"dispatch",
		"loop",
		"recipes",
	]);
	expect(existsSync(join(linked, "retired.js"))).toBe(false);
	expect(readFileSync(join(linked, "package.json"), "utf8")).toBe(
		readFileSync(
			join(WORK, `repack-${NEXT}/kabane/extensions/dispatch/package.json`),
			"utf8",
		),
	);
	expect(readFileSync(join(installed.directory, "README.md"), "utf8")).toBe(
		"kept\n",
	);
	expect(leftovers(installed.directory)).toEqual([]);
	expect(readdirSync(installed.directory).sort()).toEqual([
		"README.md",
		"extensions",
		"kabane",
		"templates",
	]);
}, 60_000);

test("an archive that does not match SHA256SUMS is refused and the install stays as it was", async () => {
	serve(repacked, `${sha256(built)}  ${FILE}\n`);
	const installed = install("opt/kabane");
	const before = updateSnapshot(installed.base);
	const refused = await update([], installed.link, { HOME: installed.home });
	expect(refused).toMatchObject({ exitCode: 1, json: { status: "error" } });
	expect(refused.text).toContain("Checksum mismatch");
	expect(updateSnapshot(installed.base)).toEqual(before);
	expect(leftovers(installed.directory)).toEqual([]);
}, 60_000);

test("a SHA256SUMS without the archive's line is refused", async () => {
	serve(repacked, "");
	const installed = install("opt/kabane");
	const before = updateSnapshot(installed.base);
	const refused = await update([], installed.link, { HOME: installed.home });
	expect(refused).toMatchObject({ exitCode: 1, json: { status: "error" } });
	expect(refused.text).toContain(`no single checksum for ${FILE}`);
	expect(updateSnapshot(installed.base)).toEqual(before);
}, 60_000);

test("a verified archive whose executable reports another version is refused and the install stays as it was", async () => {
	serve(built);
	const installed = install("opt/kabane");
	const before = updateSnapshot(installed.base);
	const refused = await update([], installed.link, { HOME: installed.home });
	expect(refused).toMatchObject({ exitCode: 1, json: { status: "error" } });
	expect(refused.text).toContain(
		`reports ${JSON.stringify(version)}, not ${NEXT}`,
	);
	expect(updateSnapshot(installed.base)).toEqual(before);
	expect(leftovers(installed.directory)).toEqual([]);
}, 60_000);

test("a binary mise installed is reported with mise up kabane and never downloaded", async () => {
	serve(repacked);
	const installed = install("mise/installs/kabane/1.0.0/kabane");
	const before = updateSnapshot(installed.base);
	const env = {
		HOME: installed.home,
		MISE_DATA_DIR: join(installed.base, "mise"),
	};
	const checked = await update(["--check"], installed.link, env);
	expect(checked).toMatchObject({
		exitCode: 0,
		json: { status: "candidate", install: "mise", candidateVersion: NEXT },
	});
	const refused = await update([], installed.link, env);
	expect(refused).toMatchObject({
		exitCode: 1,
		json: { status: "manual_only", install: "mise", candidateVersion: NEXT },
	});
	expect(refused.text).toContain("run mise up kabane");
	expect(requests.every((path) => API.includes(path))).toBe(true);
	expect(updateSnapshot(installed.base)).toEqual(before);
}, 30_000);

test("mise's github backend is named as mise names it, from the backend file beside the versions", async () => {
	serve(repacked);
	const installed = install("mise/installs/github-davidpp-kabane/1.0.0/kabane");
	writeFileSync(
		join(
			installed.base,
			"mise/installs/github-davidpp-kabane/.mise.backend.toml",
		),
		'short = "github:davidpp/kabane"\nfull = "github:davidpp/kabane"\n',
	);
	const refused = await update([], installed.link, {
		HOME: installed.home,
		MISE_DATA_DIR: join(installed.base, "mise"),
	});
	expect(refused).toMatchObject({
		exitCode: 1,
		json: { status: "manual_only", install: "mise" },
	});
	expect(refused.text).toContain("run mise up github:davidpp/kabane.");
}, 30_000);

test("a binary in Homebrew's keg is reported with brew upgrade kabane and never downloaded", async () => {
	serve(repacked);
	const installed = install("homebrew/Cellar/kabane/1.0.0/libexec");
	const before = updateSnapshot(installed.base);
	const env = { HOME: installed.home };
	const checked = await update(["--check"], installed.link, env);
	expect(checked).toMatchObject({
		exitCode: 0,
		json: { status: "candidate", install: "brew", candidateVersion: NEXT },
	});
	const refused = await update([], installed.link, env);
	expect(refused).toMatchObject({
		exitCode: 1,
		json: { status: "manual_only", install: "brew", candidateVersion: NEXT },
	});
	expect(refused.text).toContain(
		"Homebrew owns this install, so kabane update does not replace it: run brew upgrade kabane.",
	);
	expect(requests.every((path) => API.includes(path))).toBe(true);
	expect(updateSnapshot(installed.base)).toEqual(before);
}, 30_000);

test("an executable without templates/ beside it is not an extracted release and is left alone", async () => {
	serve(repacked);
	const installed = install("opt/kabane");
	rmSync(join(installed.directory, "templates"), { recursive: true });
	const before = updateSnapshot(installed.base);
	const refused = await update([], installed.link, { HOME: installed.home });
	expect(refused).toMatchObject({ exitCode: 1, json: { status: "error" } });
	expect(refused.text).toContain("no templates/");
	expect(requests).toEqual(API);
	expect(updateSnapshot(installed.base)).toEqual(before);
}, 30_000);

test("a target with no published binary reports the candidate and replaces nothing", async () => {
	serve(repacked);
	const installed = install("opt/kabane");
	const refused = await update(
		[],
		installed.link,
		{ HOME: installed.home },
		{
			target: undefined,
		},
	);
	expect(refused).toMatchObject({
		exitCode: 1,
		json: { status: "unsupported", candidateVersion: NEXT },
	});
	expect(UpdateBinary.target("win32", "x64")).toBeUndefined();
	expect(UpdateBinary.target("linux", "arm64")).toBe("linux-arm64");
}, 30_000);

test("releases are read over https, or http from loopback, wherever the redirects lead", async () => {
	const { secure } = UpdateBinary;
	for (const url of [
		"https://api.github.com/repos/davidpp/kabane/releases",
		"https://mirror.example/kabane",
		"http://127.0.0.1:8080",
		"http://[::1]:8080/download",
		"http://localhost:8080",
	])
		expect(secure(url)).toBe(true);
	for (const url of [
		"http://api.github.com/repos/davidpp/kabane/releases",
		"http://0.0.0.0:8080",
		"http://127.0.0.2:8080",
		"http://localhost.example",
		"ftp://mirror.example",
		"file:///tmp/kabane",
		"not a url",
	])
		expect(secure(url)).toBe(false);

	serve(repacked);
	const installed = install("opt/kabane");
	const before = updateSnapshot(installed.base);
	const plain = await update(
		[],
		installed.link,
		{ HOME: installed.home },
		{
			source: {
				api: "http://api.github.com/repos/davidpp/kabane/releases",
				releases: `${server.url.origin}/download`,
			},
		},
	);
	expect(plain).toMatchObject({ exitCode: 1, json: { status: "error" } });
	expect(plain.text).toContain("https only");
	const elsewhere = await update(
		[],
		installed.link,
		{ HOME: installed.home },
		{
			source: {
				api: `${server.url.origin}/releases`,
				releases: `${server.url.origin}/elsewhere`,
			},
		},
	);
	expect(elsewhere).toMatchObject({ exitCode: 1, json: { status: "error" } });
	expect(elsewhere.text).toContain(`refusing http://0.0.0.0:${server.port}/`);
	// A chain that ends on loopback is refused at its insecure middle hop, never requested.
	const through = await update(
		[],
		installed.link,
		{ HOME: installed.home },
		{
			source: {
				api: `${server.url.origin}/releases`,
				releases: `${server.url.origin}/through`,
			},
		},
	);
	expect(through).toMatchObject({ exitCode: 1, json: { status: "error" } });
	expect(through.text).toContain(`refusing http://0.0.0.0:${server.port}/`);
	expect(requests.some((path) => path.startsWith("/loopback/"))).toBe(false);
	expect(updateSnapshot(installed.base)).toEqual(before);
	expect(leftovers(installed.directory)).toEqual([]);

	const loopback = await update(
		[],
		installed.link,
		{ HOME: installed.home },
		{
			source: {
				api: `${server.url.origin}/releases`,
				releases: `${server.url.origin}/loopback`,
			},
		},
	);
	expect(loopback).toMatchObject({ exitCode: 0, json: { status: "updated" } });
	expect(sha256(installed.executable)).toBe(sha256(nextExecutable));
}, 60_000);

test("every hop of an https redirect chain is checked, the middle ones included", async () => {
	// No https server runs here, so each hop is answered from this map, as GitHub's would be.
	const chain = (hops: Record<string, string>) => {
		const asked: string[] = [];
		const hop: UpdateBinary.Hop = async (url) => {
			asked.push(url);
			const location = hops[url];
			return location === undefined
				? new Response("asset")
				: new Response(null, { status: 302, headers: { location } });
		};
		return { asked, hop };
	};
	const download = "https://github.com/davidpp/kabane/releases/download/v1.0.0";
	const secure = chain({
		[download]: "https://objects.githubusercontent.com/asset?sig=1",
	});
	const fetched = await UpdateBinary.get(download, version, 5000, secure.hop);
	expect(fetched.ok && (await fetched.value.text())).toBe("asset");
	expect(secure.asked).toEqual([
		download,
		"https://objects.githubusercontent.com/asset?sig=1",
	]);

	const insecure = chain({
		[download]: "http://mirror.example/asset",
		"http://mirror.example/asset":
			"https://objects.githubusercontent.com/asset",
	});
	const refused = await UpdateBinary.get(download, version, 5000, insecure.hop);
	expect(!refused.ok && refused.error.message).toStartWith(
		"refusing http://mirror.example/asset",
	);
	expect(insecure.asked).toEqual([download]);

	const relative = chain({ [download]: "/elsewhere/asset" });
	const resolved = await UpdateBinary.get(
		download,
		version,
		5000,
		relative.hop,
	);
	expect(resolved.ok).toBe(true);
	expect(relative.asked[1]).toBe("https://github.com/elsewhere/asset");

	const loop = chain({ [download]: download });
	const endless = await UpdateBinary.get(download, version, 5000, loop.hop);
	expect(!endless.ok && endless.error.message).toContain(
		"redirected more than 5 times",
	);
});

/** A ustar header for `name`, as tar writes one; `type` is its typeflag. */
const header = (name: string, type: string, size = 0, link = ""): Buffer => {
	const block = Buffer.alloc(512);
	block.write(name, 0, 100, "latin1");
	block.write("0000755\0", 100);
	block.write("0000000\0", 108);
	block.write("0000000\0", 116);
	block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
	block.write("00000000000\0", 136);
	block.write("        ", 148);
	block.write(type, 156);
	block.write(link, 157, 100, "latin1");
	block.write("ustar\0", 257);
	block.write("00", 263);
	const sum = block.reduce((total, byte) => total + byte, 0);
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
	return block;
};
type Member = {
	name: string;
	type?: string;
	data?: string;
	size?: number;
	link?: string;
};
const RELEASE: Member[] = [
	{ name: "kabane/", type: "5" },
	{ name: "kabane/kabane", data: "#!/bin/sh\n" },
	{ name: "kabane/templates/", type: "5" },
];
/** A gzipped tarball of `members`, written by hand so it can hold what no release would. */
const tarball = (label: string, members: Member[]): string => {
	const blocks = members.flatMap(
		({ name, type = "0", data = "", size, link }) => {
			const bytes = Buffer.from(data);
			const padded = Buffer.alloc(Math.ceil(bytes.length / 512) * 512);
			bytes.copy(padded);
			return [header(name, type, size ?? bytes.length, link), padded];
		},
	);
	const file = join(WORK, `hostile-${label}.tar.gz`);
	writeFileSync(
		file,
		Bun.gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])),
	);
	return file;
};

test("an archive is listed before extraction and refused for any member a release would not carry", async () => {
	const { inspectArchive } = UpdateBinary;
	expect(await inspectArchive(tarball("release", RELEASE))).toEqual({
		ok: true,
		value: undefined,
	});
	expect((await inspectArchive(built)).ok).toBe(true);
	const refused = async (label: string, extra: Member[], reason: string) => {
		const inspected = await inspectArchive(
			tarball(label, [...RELEASE, ...extra]),
		);
		expect(inspected.ok ? "accepted" : inspected.error).toContain(reason);
	};
	await refused(
		"symlink",
		[{ name: "kabane/templates/x", type: "2", link: "/etc" }],
		'type "2"',
	);
	await refused(
		"hardlink",
		[{ name: "kabane/templates/x", type: "1", link: "kabane/kabane" }],
		'type "1"',
	);
	await refused(
		"character-device",
		[{ name: "kabane/tty", type: "3" }],
		'type "3"',
	);
	await refused(
		"block-device",
		[{ name: "kabane/disk", type: "4" }],
		'type "4"',
	);
	await refused("fifo", [{ name: "kabane/pipe", type: "6" }], 'type "6"');
	await refused("pax", [{ name: "kabane/PaxHeader", type: "x" }], 'type "x"');
	await refused("absolute", [{ name: "/kabane/kabane" }], "outside kabane/");
	await refused("parent", [{ name: "kabane/../escaped" }], "outside kabane/");
	await refused("dot", [{ name: "./kabane/kabane" }], "outside kabane/");
	await refused("outside", [{ name: "elsewhere/kabane" }], "outside kabane/");
	await refused(
		"members",
		Array.from({ length: 2000 }, (_, index) => ({
			name: `kabane/templates/${index}`,
		})),
		"more than 2000 members",
	);
	// A size declared past the cap is refused from its header, before any of it is expanded.
	await refused(
		"expanded",
		[{ name: "kabane/huge", size: 600 * 1024 * 1024 }],
		"expands to more than",
	);
	writeFileSync(join(WORK, "not-gzip.tar.gz"), "plain text");
	const garbage = await inspectArchive(join(WORK, "not-gzip.tar.gz"));
	expect(garbage.ok ? "accepted" : garbage.error).toContain(
		"not a readable gzipped tar",
	);
});

test("a hash-verified archive with a symlink in it is refused before extraction", async () => {
	const hostile = tarball("served-symlink", [
		...RELEASE,
		{ name: "kabane/templates/dispatch", type: "2", link: "/" },
	]);
	serve(hostile);
	const installed = install("opt/kabane");
	const before = updateSnapshot(installed.base);
	const refused = await update([], installed.link, { HOME: installed.home });
	expect(refused).toMatchObject({ exitCode: 1, json: { status: "error" } });
	expect(refused.text).toContain(
		`Refusing ${FILE}: kabane/templates/dispatch is not a regular file`,
	);
	expect(updateSnapshot(installed.base)).toEqual(before);
	expect(leftovers(installed.directory)).toEqual([]);
}, 30_000);

/**
 * An install directory and a staged release beside it, for the swap alone. `extensions` says which
 * of the two has an `extensions/`: neither, as before releases shipped them, by default.
 */
const staging = (extensions: { installed?: true; shipped?: true } = {}) => {
	const base = mkdtempSync(join(WORK, "swap-"));
	const directory = join(base, "kabane");
	const staged = join(base, "staged");
	for (const [root, label, ships] of [
		[directory, "old", extensions.installed],
		[staged, "new", extensions.shipped],
	] as const) {
		mkdirSync(join(root, "templates"), { recursive: true });
		writeFileSync(join(root, "templates/which.md"), label);
		if (!ships) continue;
		mkdirSync(join(root, "extensions/dispatch"), { recursive: true });
		writeFileSync(join(root, "extensions/dispatch/which.md"), label);
	}
	const executable = join(directory, "kabane");
	writeFileSync(executable, "old executable");
	writeFileSync(join(staged, "kabane"), "new executable");
	const swap = {
		executable,
		staged,
		installedVersion: "1.0.0",
		version: "1.0.1",
	};
	/** The filesystem's rename, except into the paths `failing` names. */
	const move =
		(...failing: string[]) =>
		(from: string, to: string): boolean => {
			if (failing.includes(to)) return false;
			renameSync(from, to);
			return true;
		};
	const read = (path: string): string =>
		existsSync(path) ? readFileSync(path, "utf8") : "(missing)";
	const state = () => ({
		executable: read(executable),
		templates: read(join(directory, "templates/which.md")),
		...(existsSync(join(directory, "extensions")) ||
		existsSync(join(directory, `extensions.prev-1.0.0`))
			? { extensions: read(join(directory, "extensions/dispatch/which.md")) }
			: {}),
		entries: readdirSync(directory).sort(),
	});
	/** The `mv` commands a failure names, run in a shell as the human would. */
	const follow = (text: string) => {
		const commands = text.slice(text.indexOf("with: ") + "with: ".length);
		expect(run(["sh", "-c", commands]).exitCode).toBe(0);
	};
	return { swap, directory, staged, move, state, follow };
};

test("a swap that succeeds removes the previous templates; one that fails at the executable puts them back", () => {
	const ok = staging();
	expect(UpdateBinary.swap(ok.swap).ok).toBe(true);
	expect(ok.state()).toEqual({
		executable: "new executable",
		templates: "new",
		entries: ["kabane", "templates"],
	});

	const failing = staging();
	const failed = UpdateBinary.swap(
		failing.swap,
		failing.move(failing.swap.executable),
	);
	expect(failed).toEqual({
		ok: false,
		error: {
			text: `Could not rename the new release into ${failing.directory}; nothing was replaced.`,
		},
	});
	expect(failing.state()).toEqual({
		executable: "old executable",
		templates: "old",
		entries: ["kabane", "templates"],
	});
});

test("a rollback that fails names the mv commands that restore the previous install", () => {
	// The executable's rename fails, then moving the new templates back out does too.
	const stuck = staging();
	const templates = join(stuck.directory, "templates");
	const previous = join(stuck.directory, "templates.prev-1.0.0");
	const failedDir = join(stuck.directory, "templates.failed-1.0.1");
	const stuckResult = UpdateBinary.swap(
		stuck.swap,
		stuck.move(stuck.swap.executable, join(stuck.staged, "templates")),
	);
	expect(stuckResult.ok).toBe(false);
	if (stuckResult.ok) return;
	expect(stuckResult.error.partial).toBe(true);
	expect(stuckResult.error.text).toBe(
		`Could not replace ${stuck.swap.executable}, nor move the new templates out. ${stuck.swap.executable} is still 1.0.0; restore its templates with: mv '${templates}' '${failedDir}' && mv '${previous}' '${templates}'`,
	);
	expect(stuck.state()).toEqual({
		executable: "old executable",
		templates: "new",
		entries: ["kabane", "templates", "templates.prev-1.0.0"],
	});
	stuck.follow(stuckResult.error.text);
	expect(stuck.state()).toMatchObject({
		executable: "old executable",
		templates: "old",
	});

	// The executable's rename fails, the new templates move out, the old ones do not move back.
	const halfway = staging();
	const halfwayTemplates = join(halfway.directory, "templates");
	const halfwayPrevious = join(halfway.directory, "templates.prev-1.0.0");
	let tries = 0;
	const halfwayResult = UpdateBinary.swap(halfway.swap, (from, to) => {
		if (to === halfway.swap.executable) return false;
		if (to === halfwayTemplates && ++tries > 1) return false;
		renameSync(from, to);
		return true;
	});
	expect(halfwayResult.ok).toBe(false);
	if (halfwayResult.ok) return;
	expect(halfwayResult.error).toEqual({
		text: `Could not replace ${halfway.swap.executable}, nor put the old templates back. ${halfway.swap.executable} is still 1.0.0; restore its templates with: mv '${halfwayPrevious}' '${halfwayTemplates}'`,
		partial: true,
	});
	expect(halfway.state()).toEqual({
		executable: "old executable",
		templates: "(missing)",
		entries: ["kabane", "templates.prev-1.0.0"],
	});
	halfway.follow(halfwayResult.error.text);
	expect(halfway.state()).toMatchObject({
		executable: "old executable",
		templates: "old",
	});

	// The new templates never move in, and the old ones do not move back.
	const early = staging();
	const earlyTemplates = join(early.directory, "templates");
	const earlyResult = UpdateBinary.swap(early.swap, (from, to) => {
		if (to === earlyTemplates) return false;
		renameSync(from, to);
		return true;
	});
	expect(earlyResult.ok).toBe(false);
	if (earlyResult.ok) return;
	expect(earlyResult.error.partial).toBe(true);
	expect(earlyResult.error.text).toContain(
		"Could not rename the new templates into place, nor put the old templates back.",
	);
	early.follow(earlyResult.error.text);
	expect(early.state()).toEqual({
		executable: "old executable",
		templates: "old",
		entries: ["kabane", "templates"],
	});
});

test("a release's extensions replace the installed ones beside its templates, and a failure at the executable puts both back", () => {
	const both = staging({ installed: true, shipped: true });
	// An extension enabled from this install, linked through its path.
	const link = join(both.directory, "..", "dispatch-link");
	symlinkSync(join(both.directory, "extensions/dispatch"), link);
	expect(UpdateBinary.swap(both.swap).ok).toBe(true);
	expect(both.state()).toEqual({
		executable: "new executable",
		templates: "new",
		extensions: "new",
		entries: ["extensions", "kabane", "templates"],
	});
	expect(readFileSync(join(link, "which.md"), "utf8")).toBe("new");

	const failing = staging({ installed: true, shipped: true });
	expect(
		UpdateBinary.swap(failing.swap, failing.move(failing.swap.executable)),
	).toEqual({
		ok: false,
		error: {
			text: `Could not rename the new release into ${failing.directory}; nothing was replaced.`,
		},
	});
	expect(failing.state()).toEqual({
		executable: "old executable",
		templates: "old",
		extensions: "old",
		entries: ["extensions", "kabane", "templates"],
	});

	// The first release that ships them, over an install that has none.
	const fresh = staging({ shipped: true });
	expect(
		UpdateBinary.swap(fresh.swap, fresh.move(fresh.swap.executable)).ok,
	).toBe(false);
	expect(fresh.state()).toEqual({
		executable: "old executable",
		templates: "old",
		entries: ["kabane", "templates"],
	});
	expect(UpdateBinary.swap(fresh.swap).ok).toBe(true);
	expect(fresh.state()).toMatchObject({ extensions: "new" });
});

test("a release from before extensions shipped leaves the installed extensions alone", () => {
	const older = staging({ installed: true });
	expect(UpdateBinary.swap(older.swap).ok).toBe(true);
	expect(older.state()).toEqual({
		executable: "new executable",
		templates: "new",
		extensions: "old",
		entries: ["extensions", "kabane", "templates"],
	});
});

test("a rollback that fails for both directories names the mv commands for each", () => {
	const stuck = staging({ installed: true, shipped: true });
	const at = (name: string) => join(stuck.directory, name);
	const result = UpdateBinary.swap(
		stuck.swap,
		stuck.move(
			stuck.swap.executable,
			join(stuck.staged, "templates"),
			join(stuck.staged, "extensions"),
		),
	);
	expect(result.ok).toBe(false);
	if (result.ok) return;
	expect(result.error).toEqual({
		text: `Could not replace ${stuck.swap.executable}, nor move the new extensions out. ${stuck.swap.executable} is still 1.0.0; restore its templates and extensions with: mv '${at("extensions")}' '${at("extensions.failed-1.0.1")}' && mv '${at("extensions.prev-1.0.0")}' '${at("extensions")}' && mv '${at("templates")}' '${at("templates.failed-1.0.1")}' && mv '${at("templates.prev-1.0.0")}' '${at("templates")}'`,
		partial: true,
	});
	stuck.follow(result.error.text);
	expect(stuck.state()).toMatchObject({
		executable: "old executable",
		templates: "old",
		extensions: "old",
	});
});

test("templates left from an earlier update stop the swap before anything moves", () => {
	const left = staging();
	mkdirSync(join(left.directory, "templates.prev-1.0.0"));
	const refused = UpdateBinary.swap(left.swap);
	expect(refused.ok ? "" : refused.error.text).toContain(
		"is left from an earlier update",
	);
	expect(left.state()).toEqual({
		executable: "old executable",
		templates: "old",
		entries: ["kabane", "templates", "templates.prev-1.0.0"],
	});
});
