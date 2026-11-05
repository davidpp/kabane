/**
 * Where a release is read from, and how a standalone binary replaces itself with one. npm's
 * `latest` and `beta` dist-tags name the release, read over `fetch` because a binary has no Bun to
 * run `bun info` with; the GitHub release of that tag carries `kabane-<os>-<arch>.tar.gz` and the
 * `SHA256SUMS` that covers it. `KABANE_UPDATE_REGISTRY` and `KABANE_UPDATE_RELEASES` point both
 * somewhere else, such as a mirror, over https; plain http only reaches this machine's loopback.
 */

import { createHash } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { err, ok, type Result, tryCatch, trySync } from "@cabane/core";
import { runUpdateProcess } from "./update-process";
import { type DistTags, DistTagsSchema } from "./update-version";

export namespace UpdateBinary {
	export type Source = {
		/** The npm registry whose dist-tags name the release. */
		registry: string;
		/** The base the release assets hang off: `<releases>/v<version>/<asset>`. */
		releases: string;
	};

	export const source = (env: NodeJS.ProcessEnv): Source => ({
		registry: env.KABANE_UPDATE_REGISTRY ?? "https://registry.npmjs.org",
		releases:
			env.KABANE_UPDATE_RELEASES ??
			"https://github.com/davidpp/kabane/releases/download",
	});

	/** The release targets that ship a binary, as `${process.platform}-${process.arch}`. */
	const TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"];

	/** This machine's release target, or undefined where no binary is published. */
	export const target = (
		platform: string = process.platform,
		arch: string = process.arch,
	): string | undefined => {
		const name = `${platform}-${arch}`;
		return TARGETS.includes(name) ? name : undefined;
	};

	const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);

	/** Whether `url` is https, or http to this machine's loopback, where nobody else is on the path. */
	export const secure = (url: string): boolean => {
		const parsed = trySync(() => new URL(url));
		return (
			parsed.ok &&
			(parsed.value.protocol === "https:" ||
				(parsed.value.protocol === "http:" &&
					LOOPBACK.has(parsed.value.hostname)))
		);
	};

	const insecure = (url: string): Error =>
		new Error(
			`refusing ${url}: releases are read over https only (http only from 127.0.0.1, ::1 or localhost); check KABANE_UPDATE_REGISTRY and KABANE_UPDATE_RELEASES`,
		);

	/**
	 * A GET of `url` that only `secure` URLs answer: the one asked for and the one its redirects
	 * end at, refused before any of the body is read.
	 */
	const get = async (
		url: string,
		runningVersion: string,
		timeoutMs: number,
	): Promise<Result<Response>> => {
		if (!secure(url)) return err(insecure(url));
		const response = await tryCatch(() =>
			fetch(url, {
				headers: { "user-agent": `kabane/${runningVersion}` },
				signal: AbortSignal.timeout(timeoutMs),
			}),
		);
		if (!response.ok || secure(response.value.url)) return response;
		await response.value.body?.cancel().catch(() => {});
		return err(insecure(response.value.url));
	};

	export const fetchTags = async (
		registry: string,
		version: string,
		timeoutMs: number,
	): Promise<Result<DistTags>> => {
		const response = await get(
			`${registry}/-/package/kabane/dist-tags`,
			version,
			timeoutMs,
		);
		if (!response.ok) return response;
		if (!response.value.ok)
			return err(new Error(`registry answered ${response.value.status}`));
		const body = await tryCatch((): Promise<unknown> => response.value.json());
		if (!body.ok) return body;
		const parsed = DistTagsSchema.safeParse(body.value);
		return parsed.success
			? ok(parsed.data)
			: err(new Error("registry dist-tags are not kabane's"));
	};

	/**
	 * Whether mise installed the executable at real path `executable`: it sits under a mise
	 * installs directory, which `mise up kabane` owns and this updater must not replace.
	 */
	export const miseOwned = (
		executable: string,
		env: NodeJS.ProcessEnv,
	): boolean => {
		const home = env.HOME ?? homedir();
		const roots = [
			env.MISE_DATA_DIR,
			env.XDG_DATA_HOME && join(env.XDG_DATA_HOME, "mise"),
			join(home, ".local/share/mise"),
		].flatMap((root) => (root ? [join(root, "installs")] : []));
		return roots.some((root) => {
			const real = trySync(() => realpathSync(root));
			return executable.startsWith(`${real.ok ? real.value : root}${sep}`);
		});
	};

	/** Why a replacement stopped; `partial` when the install may no longer be the one it found. */
	type Failure = { text: string; partial?: true };

	type Replacement = {
		/** The real path of the running executable, symlinks followed. */
		executable: string;
		/** The release to install; its executable must print exactly this. */
		version: string;
		/** The running release: the user agent, and the name the old templates wait under. */
		runningVersion: string;
		target: string;
		source: Source;
		env: NodeJS.ProcessEnv;
	};

	const ARCHIVE_LIMIT = 268_435_456;
	const SUMS_LIMIT = 65_536;

	/** `url` streamed into `file`, at most `limit` bytes; its SHA-256 in hex. */
	const download = async (
		url: string,
		file: string,
		limit: number,
		timeoutMs: number,
		runningVersion: string,
	): Promise<Result<string, string>> => {
		const response = await get(url, runningVersion, timeoutMs);
		if (!response.ok)
			return err(`Could not download ${url}: ${response.error.message}`);
		const { body, status } = response.value;
		if (!response.value.ok || !body)
			return err(`Could not download ${url} (HTTP ${status})`);
		const hash = createHash("sha256");
		const saved = await tryCatch(async () => {
			const reader = body.getReader();
			const writer = Bun.file(file).writer();
			let bytes = 0;
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) return true;
					bytes += chunk.value.byteLength;
					if (bytes > limit) return false;
					hash.update(chunk.value);
					await writer.write(chunk.value);
				}
			} finally {
				await reader.cancel().catch(() => {});
				await writer.end();
			}
		});
		if (!saved.ok) return err(`Could not download ${url}`);
		if (!saved.value) return err(`${url} is larger than ${limit} bytes`);
		return ok(hash.digest("hex"));
	};

	/** The one SHA-256 that `sha256sum`-format `sums` gives `filename`. */
	const listedHash = (sums: string, filename: string): string | undefined => {
		const listed = sums.split("\n").flatMap((line) => {
			const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line);
			return match?.[2] === filename && match[1] ? [match[1]] : [];
		});
		return listed.length === 1 ? listed[0] : undefined;
	};

	const isDirectory = (path: string): boolean => {
		const stat = trySync(() => lstatSync(path));
		return stat.ok && stat.value.isDirectory();
	};
	const isFile = (path: string): boolean => {
		const stat = trySync(() => lstatSync(path));
		return stat.ok && stat.value.isFile();
	};

	/** At most this many members, expanding to at most this many bytes: a release is ~600 files, ~80 MB. */
	const MEMBER_LIMIT = 2000;
	const EXPANDED_LIMIT = 536_870_912;
	const BLOCK = 512;

	/** A NUL-terminated ustar header field. */
	const field = (block: Uint8Array, start: number, length: number): string => {
		const raw = block.subarray(start, start + length);
		const end = raw.indexOf(0);
		return Buffer.from(raw.subarray(0, end === -1 ? length : end)).toString(
			"latin1",
		);
	};

	/** The size a ustar header declares, or undefined when it is not plain octal. */
	const declaredSize = (block: Uint8Array): number | undefined => {
		const octal = field(block, 124, 12).trim();
		return /^[0-7]{1,11}$/.test(octal) ? Number.parseInt(octal, 8) : undefined;
	};

	/**
	 * Why ustar header `block` is not a member a release may carry: only regular files and
	 * directories, by a relative path under `kabane/` with no `.` or `..` segment.
	 */
	const memberProblem = (block: Uint8Array): string | undefined => {
		const prefix = field(block, 345, 155);
		const name = prefix
			? `${prefix}/${field(block, 0, 100)}`
			: field(block, 0, 100);
		if (!field(block, 257, 6).startsWith("ustar"))
			return `${name} is not a ustar member`;
		const type = field(block, 156, 1);
		if (type !== "" && type !== "0" && type !== "5")
			return `${name} is not a regular file or directory (type ${JSON.stringify(type)})`;
		const segments = name.replace(/\/$/, "").split("/");
		if (
			name.startsWith("/") ||
			segments[0] !== "kabane" ||
			segments.some(
				(segment) => segment === "" || segment === "." || segment === "..",
			)
		)
			return `${name} is outside kabane/`;
		return declaredSize(block) === undefined
			? `${name} has no plain size`
			: undefined;
	};

	/**
	 * Every member of gzipped tar `archive` checked by its header before anything is extracted
	 * (`memberProblem`), with the member count and the expanded bytes capped. Read here rather
	 * than from `tar -tv`, whose listing differs between bsdtar and GNU tar.
	 */
	export const inspectArchive = async (
		archive: string,
	): Promise<Result<void, string>> => {
		const reader = Bun.file(archive)
			.stream()
			.pipeThrough(new DecompressionStream("gzip"))
			.getReader();
		let pending = new Uint8Array(0);
		let skip = 0,
			members = 0,
			expanded = 0,
			ended = false;
		/** The next problem in `pending`, consuming whole headers and the data they declare. */
		const consume = (): string | undefined => {
			for (;;) {
				if (skip > 0) {
					const skipped = Math.min(skip, pending.length);
					pending = pending.subarray(skipped);
					skip -= skipped;
					if (skip > 0) return undefined;
				}
				if (ended || pending.length < BLOCK) return undefined;
				const block = pending.subarray(0, BLOCK);
				pending = pending.subarray(BLOCK);
				if (block.every((byte) => byte === 0)) {
					ended = true;
					return undefined;
				}
				const problem = memberProblem(block);
				if (problem) return problem;
				if (++members > MEMBER_LIMIT)
					return `more than ${MEMBER_LIMIT} members`;
				const size = declaredSize(block) ?? 0;
				skip = Math.ceil(size / BLOCK) * BLOCK;
				expanded += BLOCK + skip;
				if (expanded > EXPANDED_LIMIT)
					return `it expands to more than ${EXPANDED_LIMIT} bytes`;
			}
		};
		const read = await tryCatch(async () => {
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) return undefined;
					// Past the end marker nothing is extracted, but it still has to be decompressed.
					if (ended) {
						expanded += chunk.value.byteLength;
						if (expanded > EXPANDED_LIMIT)
							return `it expands to more than ${EXPANDED_LIMIT} bytes`;
						continue;
					}
					const joined = new Uint8Array(
						pending.length + chunk.value.byteLength,
					);
					joined.set(pending);
					joined.set(chunk.value, pending.length);
					pending = joined;
					const problem = consume();
					if (problem) return problem;
				}
			} finally {
				await reader.cancel().catch(() => {});
			}
		});
		if (!read.ok) return err("it is not a readable gzipped tar");
		return read.value === undefined ? ok(undefined) : err(read.value);
	};

	const rename = (from: string, to: string): boolean =>
		trySync(() => renameSync(from, to)).ok;

	type Swap = {
		/** The real path of the executable being replaced. */
		executable: string;
		/** The staged release: its `kabane` executable and `templates/`. */
		staged: string;
		installedVersion: string;
		version: string;
	};

	/**
	 * Templates first and the executable last, so every step leaves a runnable executable: at
	 * worst the old one beside the new templates, which are text. The old `templates/` waits in
	 * `templates.prev-<installed>` until the executable's rename, which is atomic and leaves the
	 * old executable in place when it fails, has succeeded; only then is it removed. A failure
	 * puts the old templates back, and a failure to do that names the `mv`s that would. The new
	 * templates go back to the staging directory, which is removed afterwards.
	 * `move` is the filesystem's rename unless a test passes one that fails.
	 */
	export const swap = (
		{ executable, staged, installedVersion, version }: Swap,
		move: (from: string, to: string) => boolean = rename,
	): Result<void, Failure> => {
		const directory = dirname(executable);
		const templates = join(directory, "templates");
		const previous = join(directory, `templates.prev-${installedVersion}`);
		const stagedTemplates = join(staged, "templates");
		const nothing = `Could not rename the new release into ${directory}; nothing was replaced.`;
		if (trySync(() => lstatSync(previous)).ok)
			return err({
				text: `${previous} is left from an earlier update; remove it once ${templates} is complete. Nothing was replaced.`,
			});
		/** The old templates back where they were, or the commands that would put them back. */
		const restore = (failure: string): Result<void, Failure> => {
			const failed = join(directory, `templates.failed-${version}`);
			const placed = trySync(() => lstatSync(templates)).ok;
			if (placed && !move(templates, stagedTemplates))
				return err({
					text: `${failure}, nor move the new templates out. ${executable} is still ${installedVersion}; restore its templates with: mv ${quote(templates)} ${quote(failed)} && mv ${quote(previous)} ${quote(templates)}`,
					partial: true,
				});
			if (!move(previous, templates))
				return err({
					text: `${failure}, nor put the old templates back. ${executable} is still ${installedVersion}; restore its templates with: mv ${quote(previous)} ${quote(templates)}`,
					partial: true,
				});
			return err({ text: nothing });
		};
		if (!move(templates, previous)) return err({ text: nothing });
		if (!move(stagedTemplates, templates))
			return restore("Could not rename the new templates into place");
		if (!move(join(staged, "kabane"), executable))
			return restore(`Could not replace ${executable}`);
		trySync(() => rmSync(previous, { recursive: true, force: true }));
		return ok(undefined);
	};

	/** A path quoted for a POSIX shell. */
	const quote = (path: string): string => `'${path.replaceAll("'", "'\\''")}'`;

	/** Download, checksum, extraction and version check, all inside `work`; nothing outside it changes. */
	const stage = async (
		work: string,
		{ version, runningVersion, target, source, env }: Replacement,
	): Promise<Result<string, Failure>> => {
		const filename = `kabane-${target}.tar.gz`;
		const release = `${source.releases}/v${version}`;
		const unchanged = "Nothing was replaced.";
		const sums = await download(
			`${release}/SHA256SUMS`,
			join(work, "SHA256SUMS"),
			SUMS_LIMIT,
			30_000,
			runningVersion,
		);
		if (!sums.ok) return err({ text: `${sums.error}. ${unchanged}` });
		const archive = join(work, filename);
		const actual = await download(
			`${release}/${filename}`,
			archive,
			ARCHIVE_LIMIT,
			300_000,
			runningVersion,
		);
		if (!actual.ok) return err({ text: `${actual.error}. ${unchanged}` });
		const expected = listedHash(
			readFileSync(join(work, "SHA256SUMS"), "utf8"),
			filename,
		);
		if (expected === undefined)
			return err({
				text: `${release}/SHA256SUMS lists no single checksum for ${filename}. ${unchanged}`,
			});
		if (expected !== actual.value)
			return err({
				text: `Checksum mismatch: ${filename} hashes to ${actual.value}, SHA256SUMS says ${expected}. ${unchanged}`,
			});
		const inspected = await inspectArchive(archive);
		if (!inspected.ok)
			return err({
				text: `Refusing ${filename}: ${inspected.error}. ${unchanged}`,
			});
		const unpacked = join(work, "archive");
		const made = trySync(() => mkdirSync(unpacked));
		const extracted =
			made.ok &&
			(await runUpdateProcess(
				["tar", "-xzf", archive, "-C", unpacked],
				work,
				env,
				60_000,
			));
		const staged = join(unpacked, "kabane");
		if (
			!extracted ||
			!extracted.ok ||
			extracted.value.code !== 0 ||
			!isDirectory(staged) ||
			!isFile(join(staged, "kabane")) ||
			!isDirectory(join(staged, "templates"))
		)
			return err({
				text: `${filename} did not extract to kabane/kabane and kabane/templates/. ${unchanged}`,
			});
		const printed = await runUpdateProcess(
			[join(staged, "kabane"), "--version"],
			work,
			env,
		);
		const reported = printed.ok ? printed.value.stdout.trim() : "";
		if (!printed.ok || printed.value.code !== 0 || reported !== version)
			return err({
				text: `The downloaded kabane reports ${JSON.stringify(reported)}, not ${version}. ${unchanged}`,
			});
		return ok(staged);
	};

	/**
	 * Replace the binary at `executable` and the `templates/` beside it with release `version`.
	 * Everything is staged in a directory beside the executable, so the final renames stay on its
	 * filesystem, and any failure before them leaves the old install as it was.
	 */
	export const replace = async (
		replacement: Replacement,
	): Promise<Result<void, Failure>> => {
		const { executable } = replacement;
		const directory = dirname(executable);
		if (!isDirectory(join(directory, "templates")))
			return err({
				text: `${directory} has no templates/ beside ${basename(executable)}, so it is not an extracted release directory. Replace it with a verified download by hand; nothing was replaced.`,
			});
		const work = trySync(() => mkdtempSync(join(directory, ".kabane-update-")));
		if (!work.ok)
			return err({
				text: `Cannot write in ${directory}, so kabane update cannot replace ${executable}. Nothing was replaced.`,
			});
		try {
			const staged = await stage(work.value, replacement);
			if (!staged.ok) return staged;
			return swap({
				executable,
				staged: staged.value,
				installedVersion: replacement.runningVersion,
				version: replacement.version,
			});
		} finally {
			trySync(() => rmSync(work.value, { recursive: true, force: true }));
		}
	};
}
