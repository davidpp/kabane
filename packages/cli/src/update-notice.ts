/**
 * The board's word that a newer kabane is out. npm's `latest` and `beta` dist-tags are read at
 * most once a day into `KABANE_HOME/update-check.json`, and the release named is the one
 * `kabane update` would take: the install's channel and version policy, from update-version.ts.
 * Over `fetch` rather than `bun info`, so an install without Bun can read it too, which also means
 * Bun's registry and proxy settings do not apply. Every failure says nothing: a notice is never
 * worth an error on screen.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Announcer } from "@cabane/board";
import { ok, type Result, tryCatch } from "@cabane/core";
import { z } from "zod";
import { version } from "../package.json";
import { UpdateBinary } from "./update-binary";
import {
	compareVersions,
	type DistTags,
	DistTagsSchema,
	followedTag,
	onChannel,
	withinVersionPolicy,
} from "./update-version";
import { bundled } from "./version";

export namespace UpdateNotice {
	export const FILE = "update-check.json";
	/** People reopen the board often; once a day is enough to hear of a release. */
	const MAX_AGE_MS = 24 * 60 * 60 * 1000;
	const TIMEOUT_MS = 5000;

	const CacheSchema = DistTagsSchema.extend({
		checkedAt: z.string().datetime(),
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
	const fresh = (cache: Cache, now: number): boolean => {
		const age = now - Date.parse(cache.checkedAt);
		return age >= 0 && age < MAX_AGE_MS;
	};

	// Through a temporary file, so a second board writing at the same moment never leaves half a file.
	const writeCache = (home: string, cache: Cache): Promise<Result<void>> =>
		tryCatch(async () => {
			await mkdir(home, { recursive: true });
			const temporary = `${cachePath(home)}.${process.pid}.tmp`;
			await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`);
			await rename(temporary, cachePath(home));
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
		registry?: string;
		timeoutMs?: number;
	};

	/**
	 * The release to tell the human about, read from the cache while it is under a day old, else
	 * from the registry and written back. A registry that cannot be read leaves the cache as it was
	 * and falls back on it; with nothing usable either way, undefined.
	 */
	export const check = async ({
		home,
		version,
		now = Date.now(),
		registry = UpdateBinary.source(process.env).registry,
		timeoutMs = TIMEOUT_MS,
	}: Options): Promise<string | undefined> => {
		const cached = await readCache(home);
		if (cached && fresh(cached, now)) return candidate(version, cached);
		const fetched = await UpdateBinary.fetchTags(registry, version, timeoutMs);
		if (!fetched.ok) return cached && candidate(version, cached);
		await writeCache(home, {
			...fetched.value,
			checkedAt: new Date(now).toISOString(),
		});
		return candidate(version, fetched.value);
	};

	const line = (release: string): string =>
		`kabane ${release} is out · run kabane update`;

	/**
	 * The board's announcer for this device. Only the published bundle hears of a release: a run
	 * from source is ahead of the release its package.json names, and `kabane update` does not
	 * replace it. That is the build's flag, not a look at git, so nothing here spawns a process.
	 */
	export const announcer = (home: string): Announcer => ({
		announce: async () => {
			if (!bundled) return ok(null);
			const release = await check({ home, version });
			return ok(release === undefined ? null : line(release));
		},
	});
}
