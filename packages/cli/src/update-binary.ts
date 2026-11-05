/**
 * Where a release is read from, and how a standalone binary replaces itself with one. npm's
 * `latest` and `beta` dist-tags name the release, read over `fetch` because a binary has no Bun to
 * run `bun info` with; the GitHub release of that tag carries `kabane-<os>-<arch>.tar.gz` and the
 * `SHA256SUMS` that covers it. `KABANE_UPDATE_REGISTRY` and `KABANE_UPDATE_RELEASES` point both
 * somewhere else, such as a mirror.
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

	export const fetchTags = async (
		registry: string,
		version: string,
		timeoutMs: number,
	): Promise<Result<DistTags>> => {
		const response = await tryCatch(() =>
			fetch(`${registry}/-/package/kabane/dist-tags`, {
				headers: { "user-agent": `kabane/${version}` },
				signal: AbortSignal.timeout(timeoutMs),
			}),
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
		/** The running release, for the user agent. */
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
		const response = await tryCatch(() =>
			fetch(url, {
				headers: { "user-agent": `kabane/${runningVersion}` },
				signal: AbortSignal.timeout(timeoutMs),
			}),
		);
		if (!response.ok) return err(`Could not download ${url}`);
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

	const rename = (from: string, to: string): boolean =>
		trySync(() => renameSync(from, to)).ok;

	/**
	 * `templates/` and then the executable renamed into place, each swap undone if the next one
	 * fails. Every rename stays inside the install directory, so each one is atomic; only the
	 * moment between moving the old `templates/` aside and the new one in has neither.
	 */
	const swap = (
		executable: string,
		staged: string,
		aside: string,
	): Result<void, Failure> => {
		const templates = join(dirname(executable), "templates");
		const stagedTemplates = join(staged, "templates");
		const nothing = `Could not rename the new release into ${dirname(executable)}; nothing was replaced.`;
		if (!rename(templates, aside)) return err({ text: nothing });
		if (!rename(stagedTemplates, templates))
			return rename(aside, templates)
				? err({ text: nothing })
				: err({
						text: `Could not rename the new templates into place, nor the old ones back from ${aside}; move them back to ${templates} by hand.`,
						partial: true,
					});
		if (rename(join(staged, "kabane"), executable)) return ok(undefined);
		return rename(templates, stagedTemplates) && rename(aside, templates)
			? err({ text: nothing })
			: err({
					text: `Could not replace ${executable}, nor restore the old templates from ${aside}; move them back to ${templates} by hand.`,
					partial: true,
				});
	};

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
		// A swap that failed halfway leaves the old templates in the work directory; keep it then.
		let keep = false;
		try {
			const staged = await stage(work.value, replacement);
			if (!staged.ok) return staged;
			const swapped = swap(
				executable,
				staged.value,
				join(work.value, "templates-old"),
			);
			keep = !swapped.ok && swapped.error.partial === true;
			return swapped;
		} finally {
			if (!keep)
				trySync(() => rmSync(work.value, { recursive: true, force: true }));
		}
	};
}
