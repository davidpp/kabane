/**
 * Before the board takes the terminal, the offer of a newer release: a plain question on the
 * screen, answered with one key, that runs the upgrade for how kabane was installed (`kabane
 * update`, `brew upgrade kabane`, `mise up <tool>`) and starts the new kabane with the same
 * arguments. The release is the one the board's notice would name (update-notice.ts), read from
 * its daily cache with a shorter timeout, so a slow network delays the board by little and the
 * notice inside the board still catches a release this read missed.
 */

import { trySync } from "@kabane/core";
import { version } from "../package.json";
import { Self } from "./self";
import { UpdateNotice } from "./update-notice";
import { bundled, mainBuild } from "./version";

export namespace UpgradeOffer {
	/** Set on the kabane started after an upgrade, which then never asks: brew can lag a release. */
	export const RELAUNCHED = "KABANE_UPGRADE_OFFERED";
	const TIMEOUT_MS = 1500;

	export type Gate = {
		/** stdin and stdout are both a terminal: the key is read from one and the question shown on the other. */
		tty: boolean;
		env: NodeJS.ProcessEnv;
		/** The published build; a source checkout is ahead of the release it names. */
		bundled: boolean;
		/** A main build follows main, which the board's notice reports. */
		mainBuild: boolean;
		/** `updates.check`, absent is true. */
		checks: boolean;
	};

	/** Whether this start may ask at all, before anything is read. */
	export const applies = ({
		tty,
		env,
		bundled,
		mainBuild,
		checks,
	}: Gate): boolean =>
		tty &&
		bundled &&
		!mainBuild &&
		checks &&
		!(env.CI && env.CI !== "false") &&
		env[RELAUNCHED] === undefined;

	/** The command that takes a release for this install; undefined for a manual one. */
	export const command = (
		install: UpdateNotice.Install,
		launch: { command: string; args: string[] } = Self.launch(),
	): string[] | undefined => {
		if (install === "manual") return undefined;
		if (install === "binary" || install === "bun")
			return [launch.command, ...launch.args, "update"];
		return install.upgrade.split(" ");
	};

	export const question = (
		release: string,
		running: string,
		install: UpdateNotice.Install,
	): string => {
		const out = `kabane ${release} is out (you have ${running}).`;
		if (install === "manual")
			return `${out} Download it from https://github.com/davidpp/kabane/releases/tag/v${release}\n[Enter] continue / [s]kip this version `;
		const shown =
			typeof install === "string" ? "kabane update" : install.upgrade;
		return `${out} Upgrade now with "${shown}"? [Y]es / [n]o, continue / [s]kip this version `;
	};

	export type Answer = "yes" | "no" | "skip" | "quit";

	/** One key as the terminal sent it; undefined for a key that answers nothing. */
	export const answer = (
		key: string,
		install: UpdateNotice.Install,
	): Answer | undefined => {
		if (key === "\x03") return "quit";
		if (key === "" || key === "n" || key === "N") return "no";
		if (key === "s" || key === "S") return "skip";
		if (key === "\r" || key === "\n" || key === "y" || key === "Y")
			return install === "manual" ? "no" : "yes";
		return undefined;
	};

	// One key from a raw-mode stdin, the mode restored and stdin paused before anything else reads
	// it: the upgrade, the new kabane or the board. An ended stdin reads as "".
	const readKey = (stdin: NodeJS.ReadStream): Promise<string> =>
		new Promise((resolve) => {
			const done = (key: string): void => {
				stdin.off("data", onData);
				stdin.off("end", onEnd);
				stdin.setRawMode(false);
				stdin.pause();
				resolve(key);
			};
			const onData = (data: Buffer): void => done(data.toString("utf8"));
			const onEnd = (): void => done("");
			stdin.setRawMode(true);
			stdin.on("data", onData);
			stdin.once("end", onEnd);
			stdin.resume();
		});

	export type Outcome =
		/** The board opens; `offered` is the release it must not name again in this start. */
		| { kind: "board"; offered?: string }
		/** Ctrl-C at the question: no board. */
		| { kind: "quit" };

	// The board takes the whole screen, so what went wrong waits for a key to be read first.
	const stay = async (why: string, release: string): Promise<Outcome> => {
		process.stdout.write(
			`${why}. Press a key to open the board on ${version}.`,
		);
		await readKey(process.stdin);
		process.stdout.write("\n");
		return { kind: "board", offered: release };
	};

	/**
	 * Ask, and act on the answer. On a successful upgrade this process becomes the new kabane and
	 * never returns; everything else returns to open the board on this version.
	 */
	export const offer = async (
		home: string,
		gate: Omit<Gate, "tty" | "env" | "bundled" | "mainBuild">,
		env: NodeJS.ProcessEnv = process.env,
	): Promise<Outcome> => {
		const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
		if (!applies({ ...gate, tty, env, bundled, mainBuild: !!mainBuild }))
			return { kind: "board" };
		const release = await UpdateNotice.check({
			home,
			version,
			timeoutMs: TIMEOUT_MS,
		});
		if (release === undefined) return { kind: "board" };
		const install = await UpdateNotice.install();
		process.stdout.write(question(release, version, install));
		let said: Answer | undefined;
		while (said === undefined)
			said = answer(await readKey(process.stdin), install);
		process.stdout.write("\n");
		if (said === "quit") return { kind: "quit" };
		if (said === "skip") await UpdateNotice.skip(home, release);
		const upgrade = said === "yes" ? command(install) : undefined;
		if (upgrade === undefined) return { kind: "board", offered: release };
		const ran = Bun.spawnSync(upgrade, {
			stdio: ["inherit", "inherit", "inherit"],
			env,
		});
		const next = ran.exitCode === 0 ? Self.upgraded() : null;
		if (next === null)
			return stay(
				ran.exitCode === 0
					? "Upgraded, but no kabane to start was found"
					: `"${upgrade.join(" ")}" exited with ${ran.exitCode ?? ran.signalCode}`,
				release,
			);
		const started = trySync(() => {
			if (!process.execve) throw new Error("this Bun cannot exec");
			process.execve(next, [next, ...process.argv.slice(2)], {
				...env,
				[RELAUNCHED]: release,
			});
		});
		// execve returns only when it failed.
		return stay(
			`Upgraded, but ${next} did not start${started.ok ? "" : ` (${started.error.message})`}`,
			release,
		);
	};
}
