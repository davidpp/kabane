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
import { join, resolve } from "node:path";
import { parseArgs } from "@cabane/extension";
import { version } from "../package.json";
import { type Host, runUpdate } from "./commands/update";
import { UpdateBinary } from "./update-binary";
import { updateSnapshot } from "./update-fixture";
import { runUpdateProcess } from "./update-process";
import { isPrerelease } from "./update-version";

// Real release archives for this machine, built by the release script and served by a real
// server on localhost; only the versions on the dist-tags and the paths they hang off are made up.
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
const TAGS = isPrerelease(NEXT)
	? { latest: "0.3.0", beta: NEXT }
	: { latest: NEXT };

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
type Release = { tags: unknown; archive: string; sums: string };
let release: Release = { tags: TAGS, archive: "", sums: "" };
const requests: string[] = [];
const server = Bun.serve({
	port: 0,
	fetch: (request): Response => {
		const path = new URL(request.url).pathname;
		// Only kabane's own: another local tool may probe any open port.
		if (request.headers.get("user-agent")?.startsWith("kabane/"))
			requests.push(path);
		if (path === "/-/package/kabane/dist-tags")
			return Response.json(release.tags);
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
		tags: TAGS,
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
			target: TARGET,
			source: {
				registry: server.url.origin,
				releases: `${server.url.origin}/download`,
			},
			...over,
		},
		version,
	);

const leftovers = (directory: string): string[] =>
	readdirSync(directory).filter(
		(name) =>
			name.startsWith(".kabane-update-") || name.startsWith("templates."),
	);

test("--check reads the dist-tags alone and changes nothing", async () => {
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
	expect(requests).toEqual(["/-/package/kabane/dist-tags"]);
	expect(updateSnapshot(installed.base)).toEqual(before);
}, 30_000);

test("update replaces the real executable behind a symlink, and its templates, with the verified release", async () => {
	serve(repacked);
	const installed = install("opt/kabane");
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
	expect(readFileSync(join(installed.directory, "README.md"), "utf8")).toBe(
		"kept\n",
	);
	expect(leftovers(installed.directory)).toEqual([]);
	expect(readdirSync(installed.directory).sort()).toEqual([
		"README.md",
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
	expect(requests.every((path) => path === "/-/package/kabane/dist-tags")).toBe(
		true,
	);
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
	expect(requests).toEqual(["/-/package/kabane/dist-tags"]);
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

/** An install directory and a staged release beside it, for the swap alone. */
const staging = () => {
	const base = mkdtempSync(join(WORK, "swap-"));
	const directory = join(base, "kabane");
	const staged = join(base, "staged");
	for (const [root, label] of [
		[directory, "old"],
		[staged, "new"],
	] as const) {
		mkdirSync(join(root, "templates"), { recursive: true });
		writeFileSync(join(root, "templates/which.md"), label);
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
