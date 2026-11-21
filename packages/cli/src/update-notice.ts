/**
 * The board's word that a newer kabane is out. The `latest` and `beta` releases on GitHub, where
 * the binaries download from (update-binary.ts), are read at most once a day into
 * `KABANE_HOME/update-check.json`, and the release named is the one the install's channel and
 * version policy take, from update-version.ts. Over `fetch`, so an install without Bun can read it
 * too, which also means Bun's registry and proxy settings do not apply. Every failure says
 * nothing: a notice is never worth an error on screen. The hint is the install's own:
 * `kabane update`, `brew upgrade kabane`, mise's `mise up <tool>`, or a manual update where
 * `kabane update` would refuse.
 *
 * A main build hears of main instead (update-main.ts): how many commits main has past its stamp,
 * cached for an hour in `KABANE_HOME/update-check-main.json`, since main moves more often than
 * releases do and reading it is one `git ls-remote` while it has not moved.
 */

import { realpathSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Announcer } from "@kabane/board";
import { ok, type Result, tryCatch, trySync } from "@kabane/core";
import { z } from "zod";
import { version } from "../package.json";
import { Self } from "./self";
import { UpdateBinary } from "./update-binary";
import { inspectRegistryInstall } from "./update-install";
import { UpdateMain } from "./update-main";
import {
	compareVersions,
	type DistTags,
	DistTagsSchema,
	followedTag,
	onChannel,
	withinVersionPolicy,
} from "./update-version";
import { bundled, mainBuild } from "./version";

export namespace UpdateNotice {
	export const FILE = "update-check.json";
	/** People reopen the board often; once a day is enough to hear of a release. */
	const MAX_AGE_MS = 24 * 60 * 60 * 1000;
	const TIMEOUT_MS = 5000;

	const CacheSchema = DistTagsSchema.extend({
		checkedAt: z.iso.datetime(),
	});
	type Cache = z.infer<typeof CacheSchema>;

	const cachePath = (home: string): string => join(home, FILE);

	// Async, like the write: the board asks after its first frame, and a slow disk must not hold the
	// frames after it either.
	const readCache = async (home: string): Promise<Cache | undefined> => {
		const read = await tryCatch(async (): Promise<unknown> =>
			JSON.parse(await readFile(cachePath(home), "utf8")),
		);
		if (!read.ok) return undefined;
		const parsed = CacheSchema.safeParse(read.value);
		return parsed.success ? parsed.data : undefined;
	};

	// A check dated in the future is a clock that moved, so it is not trusted to be recent.
	const fresh = (
		cache: { checkedAt: string },
		now: number,
		maxAgeMs = MAX_AGE_MS,
	): boolean => {
		const age = now - Date.parse(cache.checkedAt);
		return age >= 0 && age < maxAgeMs;
	};

	// Through a temporary file, so a second board writing at the same moment never leaves half a file.
	const writeCache = (path: string, cache: unknown): Promise<Result<void>> =>
		tryCatch(async () => {
			await mkdir(dirname(path), { recursive: true });
			const temporary = `${path}.${process.pid}.tmp`;
			await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`);
			await rename(temporary, path);
		});

	/** The release newer than `runningVersion` that its channel and version policy take, if any. */
	export const candidate = (
		runningVersion: string,
		tags: DistTags,
	): string | undefined => {
		const target = tags[followedTag(runningVersion, tags)];
		return target !== undefined &&
			onChannel(target, runningVersion) &&
			withinVersionPolicy(target, runningVersion) &&
			compareVersions(target, runningVersion) > 0
			? target
			: undefined;
	};

	type Options = {
		home: string;
		/** The running release. */
		version: string;
		now?: number;
		/** The releases API, as `UpdateBinary.Source` names it. */
		api?: string;
		timeoutMs?: number;
	};

	/**
	 * The release to tell the human about, read from the cache while it is under a day old, else
	 * from the releases API and written back. An API that cannot be read leaves the cache as it was
	 * and falls back on it; with nothing usable either way, undefined.
	 */
	export const check = async ({
		home,
		version,
		now = Date.now(),
		api = UpdateBinary.source(process.env).api,
		timeoutMs = TIMEOUT_MS,
	}: Options): Promise<string | undefined> => {
		const cached = await readCache(home);
		if (cached && fresh(cached, now)) return candidate(version, cached);
		const fetched = await UpdateBinary.fetchReleases(api, version, timeoutMs);
		if (!fetched.ok) return cached && candidate(version, cached);
		await writeCache(cachePath(home), {
			...fetched.value,
			checkedAt: new Date(now).toISOString(),
		});
		return candidate(version, fetched.value);
	};

	/** How this install takes a release, as `kabane update` would judge it. */
	type Install = "binary" | "bun" | "manual" | UpdateBinary.Manager;

	/** What the process says about itself; tests pass their own. */
	type Host = {
		compiled: boolean;
		/** The running kabane: the binary, or the entry script. */
		executable: string;
		bun: string;
		env: NodeJS.ProcessEnv;
	};

	const HOST: Host = {
		compiled: Self.compiled(),
		executable: Self.executable(),
		bun: process.execPath,
		env: process.env,
	};

	/**
	 * A binary replaces itself unless mise or Homebrew owns it; a Bun install updates when `kabane update`
	 * verifies its layout, which spawns `bun pm bin -g`, so it is asked only once a release is out.
	 */
	export const install = async (host: Host = HOST): Promise<Install> => {
		if (host.compiled) {
			const real = trySync(() => realpathSync(host.executable));
			return (
				(real.ok && UpdateBinary.manager(real.value, host.env)) || "binary"
			);
		}
		const registry = await inspectRegistryInstall({
			bin: host.executable,
			bun: host.bun,
			env: host.env,
		});
		return registry.ok ? "bun" : "manual";
	};

	const HINTS = {
		binary: "run kabane update",
		// Releases stopped going to npm; kabane update names the GitHub-release installs.
		bun: "releases moved to GitHub, run kabane update",
		manual: "update it the way you installed it",
	};

	export const line = (release: string, from: Install): string =>
		`kabane ${release} is out · ${typeof from === "string" ? HINTS[from] : `run ${from.upgrade}`}`;

	const MAIN_FILE = "update-check-main.json";
	const MAIN_MAX_AGE_MS = 60 * 60 * 1000;

	const MainCacheSchema = z.object({
		/** The stamped commit the status was read for; another build reads again. */
		commit: z.string(),
		status: z.discriminatedUnion("kind", [
			z.object({ kind: z.literal("level") }),
			z.object({
				kind: z.literal("behind"),
				head: z.string(),
				commits: z.number().int().positive(),
			}),
			z.object({ kind: z.literal("gone"), head: z.string() }),
		]),
		checkedAt: z.iso.datetime(),
	});

	/**
	 * Where main stands against a main build's stamp: from the cache while it is under an hour old
	 * and was read for this stamp, else from the source and written back. A source that cannot be
	 * read falls back on the cache for this stamp, else undefined.
	 */
	export const checkMain = async ({
		home,
		stamp,
		now = Date.now(),
		env = process.env,
	}: {
		home: string;
		stamp: UpdateMain.Stamp;
		now?: number;
		env?: NodeJS.ProcessEnv;
	}): Promise<UpdateMain.Status | undefined> => {
		const path = join(home, MAIN_FILE);
		const read = await tryCatch(async (): Promise<unknown> =>
			JSON.parse(await readFile(path, "utf8")),
		);
		const parsed = read.ok ? MainCacheSchema.safeParse(read.value) : undefined;
		const cached =
			parsed?.success && parsed.data.commit === stamp.commit
				? parsed.data
				: undefined;
		if (cached && fresh(cached, now, MAIN_MAX_AGE_MS)) return cached.status;
		const moved = await UpdateMain.status(stamp, env);
		if (!moved.ok) return cached?.status;
		await writeCache(path, {
			commit: stamp.commit,
			status: moved.value,
			checkedAt: new Date(now).toISOString(),
		});
		return moved.value;
	};

	/** The notice for a main build that main has moved past, with what rebuilds it. */
	export const mainLine = (
		moved: UpdateMain.Status,
		cloneExists: boolean,
	): string | null => {
		if (moved.kind === "level") return null;
		const said =
			moved.kind === "behind"
				? `main is ${moved.commits} commit${moved.commits === 1 ? "" : "s"} past this build`
				: "main no longer has this build's commit";
		return `${said} · ${cloneExists ? "run kabane update" : `run ${UpdateMain.COMMAND} in a kabane clone`}`;
	};

	/**
	 * The board's announcer for this device. Only the published bundle hears of a release: a run
	 * from source is ahead of the release its package.json names, and `kabane update` does not
	 * replace it. That is the build's flag, not a look at git. The line ends with what this install
	 * runs to take the release (`install`).
	 */
	export const announcer = (home: string): Announcer => ({
		announce: async () => {
			if (!bundled) return ok(null);
			if (mainBuild) {
				const moved = await checkMain({ home, stamp: mainBuild });
				return ok(
					moved ? mainLine(moved, UpdateMain.cloneExists(mainBuild)) : null,
				);
			}
			const release = await check({ home, version });
			return ok(release === undefined ? null : line(release, await install()));
		},
	});
}
