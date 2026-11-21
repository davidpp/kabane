/**
 * The main channel: a kabane built from a commit of main rather than a release
 * (`bun run main-build` in a clone). Its stamp is compiled in, and names the commit, that commit's
 * date and the source it came from. Today the one source is the clone that built it, whose
 * `origin` it reads; a rolling release built by CI would be a second kind of source on this same
 * channel.
 *
 * "Newer" on this channel is main having commits after the stamped one. The check reads the
 * source's main with `git ls-remote`, and only when that differs fetches main's commits (no
 * blobs) into a temporary repository of its own to count them: nobody's checkout is fetched into.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, type Result } from "@kabane/core";
import { z } from "zod";
import { runUpdateProcess } from "./update-process";

export namespace UpdateMain {
	const CloneSourceSchema = z.object({
		kind: z.literal("clone"),
		/** The clone the build ran in, which rebuilds it. */
		clone: z.string().min(1),
		/** That clone's `origin`, whose main the check reads. */
		remote: z.string().min(1),
	});

	const StampSchema = z.object({
		channel: z.literal("main"),
		commit: z.string().regex(/^[0-9a-f]{40}$/),
		/** The commit's committer date, ISO 8601. */
		date: z.string().min(10),
		source: CloneSourceSchema,
	});
	export type Stamp = z.infer<typeof StampSchema>;

	/** The stamp a build was compiled with, or undefined for a release or a run from source. */
	export const parse = (raw: string | undefined): Stamp | undefined => {
		if (!raw) return undefined;
		try {
			const parsed = StampSchema.safeParse(JSON.parse(raw));
			return parsed.success ? parsed.data : undefined;
		} catch {
			return undefined;
		}
	};

	/** How `kabane --version` names a main build: `main abc1234, 2026-11-17`. */
	export const label = (stamp: Stamp): string =>
		`main ${stamp.commit.slice(0, 7)}, ${stamp.date.slice(0, 10)}`;

	export type Status =
		| { kind: "level" }
		/** Main has `commits` commits after the stamped one and is at `head`. */
		| { kind: "behind"; head: string; commits: number }
		/** Main at `head` no longer contains the stamped commit: it was rewritten. */
		| { kind: "gone"; head: string };

	const GIT_ENV = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
		...env,
		// A check runs unattended, under the board too: a remote that wants a password fails.
		GIT_TERMINAL_PROMPT: "0",
	});

	const git = async (
		args: string[],
		cwd: string,
		env: NodeJS.ProcessEnv,
		timeoutMs = 15_000,
	): Promise<Result<string, string>> => {
		const ran = await runUpdateProcess(
			["git", ...args],
			cwd,
			GIT_ENV(env),
			timeoutMs,
		);
		if (!ran.ok) return err(`git ${args[0]} failed: ${ran.error.message}`);
		return ran.value.code === 0
			? ok(ran.value.stdout.trim())
			: err(`git ${args[0]} exited ${ran.value.code}`);
	};

	/** Where the stamped commit stands against the source's main now. */
	export const status = async (
		stamp: Stamp,
		env: NodeJS.ProcessEnv,
	): Promise<Result<Status, string>> => {
		const { remote } = stamp.source;
		const listed = await git(
			["ls-remote", remote, "refs/heads/main"],
			tmpdir(),
			env,
		);
		if (!listed.ok)
			return err(`Could not read main from ${remote} (${listed.error}).`);
		const head = listed.value.split(/\s/)[0] ?? "";
		if (!/^[0-9a-f]{40}$/.test(head))
			return err(`${remote} has no main branch.`);
		if (head === stamp.commit) return ok({ kind: "level" });
		const work = mkdtempSync(join(tmpdir(), "kabane-main-check-"));
		try {
			const repo = join(work, "main.git");
			const cloned = await git(
				[
					"clone",
					"--quiet",
					"--bare",
					"--filter=blob:none",
					"--single-branch",
					"--branch",
					"main",
					remote,
					repo,
				],
				work,
				env,
				120_000,
			);
			if (!cloned.ok)
				return err(`Could not read main's history from ${remote}.`);
			const now = await git(["rev-parse", "main"], repo, env);
			if (!now.ok) return err(`Could not read main's history from ${remote}.`);
			const contained = await git(
				["merge-base", "--is-ancestor", stamp.commit, now.value],
				repo,
				env,
			);
			if (!contained.ok) return ok({ kind: "gone", head: now.value });
			const counted = await git(
				["rev-list", "--count", `${stamp.commit}..${now.value}`],
				repo,
				env,
			);
			if (!counted.ok)
				return err(`Could not count main's commits at ${remote}.`);
			const commits = Number(counted.value);
			return ok(
				commits === 0
					? { kind: "level" }
					: { kind: "behind", head: now.value, commits },
			);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	};

	const plural = (count: number): string =>
		`${count} commit${count === 1 ? "" : "s"}`;

	/** What the status says, in a sentence without the remedy. */
	export const describe = (stamp: Stamp, moved: Status): string => {
		const short = stamp.commit.slice(0, 7);
		switch (moved.kind) {
			case "level":
				return `This main build (${short}) is level with main at ${stamp.source.remote}.`;
			case "behind":
				return `Main at ${stamp.source.remote} is ${plural(moved.commits)} past this build (${short} → ${moved.head.slice(0, 7)}).`;
			case "gone":
				return `Main at ${stamp.source.remote} no longer has this build's commit ${short}; it is at ${moved.head.slice(0, 7)}.`;
		}
	};

	/** The command that builds and installs main from a clone, as a person types it. */
	export const COMMAND = "bun run main-build";

	/** Whether the clone that built `stamp` is still there to rebuild it. */
	export const cloneExists = (stamp: Stamp): boolean =>
		existsSync(join(stamp.source.clone, "scripts/main-build.ts"));
}
