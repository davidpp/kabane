// A lock held by one process on this device: a file whose whole content, the owner's pid, its
// start time and what it holds the lock for, is there the moment the file exists, because it is
// written to a file of its own first and then linked into place, which fails when the lock exists.
// A contender therefore never reads a half-written lock.
//
// A lock whose owner is gone is taken over, one taker at a time: under a guard (itself such a
// file), the taker removes the lock only if it still holds the very record whose owner it saw
// gone, then contends again like anyone. Only a dead owner's lock is ever removed by another
// process, so an owner releasing its own (only while it still names it) races with nobody.
// What this cannot rule out: two takers both clearing a guard whose own holder died inside it,
// which needs a process killed within that handful of syscalls.
import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { err, ok, type Result, trySync } from "@cabane/core";
import { z } from "zod";
import { RunStore } from "./store";

export namespace FileLock {
	const OwnerSchema = z.object({
		pid: z.number().int(),
		start: z.string().optional(),
		/** What holds it, for the refusal: `kabane loop land <runId>`, a start, a prune. */
		for: z.string(),
		/** Tells two records of the same process apart, so a release removes only its own. */
		token: z.string(),
	});
	type Owner = z.infer<typeof OwnerSchema>;

	const ATTEMPTS = 50;
	const WAIT_MS = 2;

	const nap = (ms: number): void => {
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
	};

	const record = (what: string): string => {
		const started = RunStore.processStart(process.pid);
		return JSON.stringify({
			pid: process.pid,
			...(started.ok && started.value ? { start: started.value } : {}),
			for: what,
			token: randomUUID(),
		});
	};

	const read = (file: string): string | undefined => {
		const text = trySync(() => readFileSync(file, "utf8"));
		return text.ok ? text.value : undefined;
	};

	// The owner a lock's text names while that process lives; a gone or unreadable one is none.
	const live = (text: string | undefined): Owner | undefined => {
		const json =
			text === undefined ? undefined : trySync((): unknown => JSON.parse(text));
		const owner = OwnerSchema.safeParse(json?.ok ? json.value : undefined);
		return owner.success &&
			RunStore.runnerAlive(owner.data.pid, owner.data.start)
			? owner.data
			: undefined;
	};

	// Make `file` holding `text`, complete, or fail because it exists.
	const create = (file: string, text: string): boolean => {
		const own = `${file}.${process.pid}.${randomUUID()}`;
		if (!trySync(() => writeFileSync(own, text, { flag: "wx" })).ok)
			return false;
		const linked = trySync(() => linkSync(own, file)).ok;
		trySync(() => unlinkSync(own));
		return linked;
	};

	// Remove `file` when it still holds `text`.
	const removeIf = (file: string, text: string): void => {
		if (read(file) === text) trySync(() => unlinkSync(file));
	};

	// Remove the lock `stale`, whose owner is gone, unless it changed meanwhile: under the guard.
	const takeOver = (file: string, stale: string): void => {
		const guard = `${file}.takeover`;
		const mine = record("a takeover");
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			if (create(guard, mine)) {
				try {
					removeIf(file, stale);
				} finally {
					removeIf(guard, mine);
				}
				return;
			}
			const held = read(guard);
			// A taker that died in there leaves the guard to whoever comes next.
			if (held !== undefined && live(held) === undefined) removeIf(guard, held);
			else nap(WAIT_MS);
		}
	};

	/** What holds the lock at `file`, while its owner lives. */
	export const heldFor = (file: string): string | undefined =>
		live(read(file))?.for;

	/**
	 * Take the lock at `file` for `what`: refused while a live process holds it, taken over from a
	 * gone one. Returns its release, which removes the lock only while it is still this one.
	 */
	export const take = (file: string, what: string): Result<() => void> => {
		const mine = record(what);
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			if (create(file, mine)) return ok(() => removeIf(file, mine));
			const seen = read(file);
			// Released between the two: contend again.
			if (seen === undefined) continue;
			const owner = live(seen);
			if (owner)
				return err(
					new Error(
						`in use by ${owner.for} (pid ${owner.pid}): try again once it is done`,
					),
				);
			takeOver(file, seen);
		}
		return err(new Error(`${file} could not be taken`));
	};
}
