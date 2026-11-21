import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// packaging/install.sh run by the real sh against releases served from this machine. A release
// is the real archive layout; its executable is a script that prints the release's version,
// which is all the installer runs.
const INSTALLER = join(import.meta.dir, "../packaging/install.sh");
const WORK = realpathSync(mkdtempSync(join(tmpdir(), "kabane-install-sh-")));
const ARCHIVE = `kabane-${process.platform}-${process.arch}.tar.gz`;

const assets = new Map<string, Uint8Array>();
const requested: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch: (request) => {
		const path = new URL(request.url).pathname;
		requested.push(path);
		// The same assets one plain-http redirect away, on this machine where http is allowed.
		if (path.startsWith("/redirect/"))
			return Response.redirect(
				`http://127.0.0.1:${server.port}/download/${path.slice("/redirect/".length)}`,
				302,
			);
		const asset = assets.get(path);
		return asset ? new Response(asset) : new Response("none", { status: 404 });
	},
});
afterAll(async () => {
	await server.stop(true);
	rmSync(WORK, { recursive: true, force: true });
});

/** Publish release `version` at `/download/v<version>/`, with its SHA256SUMS. */
const publish = (version: string) => {
	const tree = join(WORK, `tree-${version}`);
	mkdirSync(join(tree, "kabane/templates"), { recursive: true });
	writeFileSync(join(tree, "kabane/kabane"), `#!/bin/sh\necho ${version}\n`, {
		mode: 0o755,
	});
	writeFileSync(join(tree, "kabane/templates/notes.md"), `${version}\n`);
	const tar = Bun.spawnSync(["tar", "-czf", "-", "-C", tree, "kabane"]);
	expect(tar.exitCode).toBe(0);
	const archive = new Uint8Array(tar.stdout);
	const digest = new Bun.CryptoHasher("sha256").update(archive).digest("hex");
	assets.set(`/download/v${version}/${ARCHIVE}`, archive);
	assets.set(
		`/download/v${version}/SHA256SUMS`,
		new TextEncoder().encode(`${digest}  ${ARCHIVE}\n`),
	);
};
publish("1.0.0");
publish("1.0.1");

/** A home and a working directory of its own for each case. */
const place = () => {
	const base = mkdtempSync(join(WORK, "case-"));
	mkdirSync(join(base, "home"));
	return base;
};

const install = async (
	base: string,
	args: string[],
	releases = `${server.url.origin}/download`,
) => {
	requested.length = 0;
	const child = Bun.spawn(["sh", INSTALLER, ...args], {
		cwd: base,
		env: {
			HOME: join(base, "home"),
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			KABANE_UPDATE_API: `${server.url.origin}/releases`,
			KABANE_UPDATE_RELEASES: releases,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([
		child.exited,
		new Response(child.stderr).text(),
	]);
	return { exitCode, stderr };
};

const runs = (executable: string): string =>
	Bun.spawnSync([executable, "--version"], { cwd: WORK })
		.stdout.toString()
		.trim();

/** What the installer leaves beside the prefix: its staging directory and the previous install. */
const leftovers = (prefix: string): string[] =>
	readdirSync(dirname(prefix)).filter((name) =>
		name.startsWith(".kabane-install."),
	);

test("a relative --prefix and --bin install a link that runs from anywhere", async () => {
	const base = place();
	const result = await install(base, [
		"--version",
		"1.0.0",
		"--prefix",
		"opt/kabane",
		"--bin",
		"bin",
	]);
	expect(result).toMatchObject({ exitCode: 0 });
	const link = join(base, "bin/kabane");
	expect(readlinkSync(link)).toBe(join(base, "opt/kabane/kabane"));
	expect(runs(link)).toBe("1.0.0");
	expect(leftovers(join(base, "opt/kabane"))).toEqual([]);
});

test("a download redirected to plain http is refused, even on this machine", async () => {
	const base = place();
	const prefix = join(base, "opt/kabane");
	const result = await install(
		base,
		["--version", "1.0.0", "--prefix", prefix, "--bin", join(base, "bin")],
		`${server.url.origin}/redirect`,
	);
	expect(result.exitCode).not.toBe(0);
	expect(result.stderr).toContain(
		`download failed: ${server.url.origin}/redirect/`,
	);
	expect(requested.some((path) => path.startsWith("/download/"))).toBe(false);
	expect(existsSync(prefix)).toBe(false);
	expect(leftovers(prefix)).toEqual([]);
});

test("a reinstall whose link step fails leaves the previous install in place and runnable", async () => {
	const base = place();
	const prefix = join(base, "opt/kabane");
	const bin = join(base, "bin");
	const first = await install(base, [
		"--version",
		"1.0.0",
		"--prefix",
		prefix,
		"--bin",
		bin,
	]);
	expect(first.exitCode).toBe(0);
	// The link already exists, so the installer gets as far as moving the previous install
	// aside and the new one in, then cannot replace the link in a directory it may not write.
	chmodSync(bin, 0o555);
	try {
		const second = await install(base, [
			"--version",
			"1.0.1",
			"--prefix",
			prefix,
			"--bin",
			bin,
		]);
		expect(second.exitCode).not.toBe(0);
	} finally {
		chmodSync(bin, 0o755);
	}
	expect(runs(join(bin, "kabane"))).toBe("1.0.0");
	expect(readFileSync(join(prefix, "templates/notes.md"), "utf8")).toBe(
		"1.0.0\n",
	);
	expect(leftovers(prefix)).toEqual([]);
});

test("a bin path that is not a symlink is refused before anything is downloaded", async () => {
	const base = place();
	const bin = join(base, "bin");
	mkdirSync(bin);
	writeFileSync(join(bin, "kabane"), "someone else's kabane\n");
	const result = await install(base, [
		"--version",
		"1.0.0",
		"--prefix",
		join(base, "opt/kabane"),
		"--bin",
		bin,
	]);
	expect(result.exitCode).not.toBe(0);
	expect(result.stderr).toContain(
		`${join(bin, "kabane")} exists and is not a symlink`,
	);
	expect(requested).toEqual([]);
	expect(readFileSync(join(bin, "kabane"), "utf8")).toBe(
		"someone else's kabane\n",
	);
	expect(existsSync(join(base, "opt/kabane"))).toBe(false);
});
