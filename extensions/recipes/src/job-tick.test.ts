// The tick's launchd agent and crontab line, and the doctor finding that offers them, over a
// throwaway home. Nothing here loads the agent: launchctl acts on the user's real session.
import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { err, ok, tryCatch, trySync } from "@kabane/core";
import { JobTick } from "./job-tick";
import { Kabane } from "./result";

Kabane.bind({ result: { ok, err, tryCatch, trySync } });

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});
const home = (): string => {
	const made = mkdtempSync(join(tmpdir(), "job-tick-"));
	homes.push(made);
	return made;
};

const TARGET: JobTick.Target = {
	kabane: "/opt/homebrew/bin/kabane",
	kabaneHome: "/Users/me/.kabane",
	path: "/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
};

it("writes a launchd agent that runs this kabane's tick every minute with its PATH and KABANE_HOME", () => {
	const user = home();
	const file = JobTick.write(
		{ ...TARGET, kabane: "/Users/me/R&D <kabane>/kabane" },
		user,
	);
	if (!file.ok) throw file.error;
	expect(file.value).toBe(
		join(user, "Library/LaunchAgents/com.kabane.job-tick.plist"),
	);
	const written = readFileSync(file.value, "utf8");
	expect(written).toContain(
		"<string>/Users/me/R&amp;D &lt;kabane&gt;/kabane</string>\n\t\t<string>job</string>\n\t\t<string>tick</string>",
	);
	expect(written).toContain(
		"<key>StartInterval</key>\n\t<integer>60</integer>",
	);
	expect(written).toContain(`<string>${TARGET.path}</string>`);
	expect(written).toContain("<string>/Users/me/.kabane</string>");
	expect(written).toContain("<string>/Users/me/.kabane/job-tick.log</string>");
	if (process.platform === "darwin")
		expect(Bun.spawnSync(["plutil", "-lint", file.value]).exitCode).toBe(0);
	expect(JobTick.found("darwin", user).state).not.toBe("none");
});

it("writes a crontab line quoted for sh, with cron's % escaped", () => {
	expect(
		JobTick.cronLine({ ...TARGET, kabane: "/home/it's/100%/kabane" }),
	).toBe(
		"* * * * * PATH='/Users/me/.local/bin:/opt/homebrew/bin:/usr/bin:/bin' KABANE_HOME='/Users/me/.kabane' '/home/it'\\''s/100\\%/kabane' job tick >> '/Users/me/.kabane/job-tick.log' 2>> '/Users/me/.kabane/job-tick.error.log'",
	);
	expect(JobTick.inCrontab(`${JobTick.cronLine(TARGET)}\n`)).toBe(true);
	expect(JobTick.inCrontab("# * * * * * kabane job tick\n")).toBe(false);
	expect(JobTick.inCrontab("")).toBe(false);
});

it("offers the tick only while there are jobs and nothing ticks them", () => {
	const user = home();
	expect(JobTick.check(0, TARGET, { platform: "darwin", home: user })).toEqual(
		[],
	);
	expect(JobTick.check(2, TARGET, { platform: undefined, home: user })).toEqual(
		[],
	);
	const [finding] = JobTick.check(2, TARGET, {
		platform: "darwin",
		home: user,
	});
	expect(finding).toMatchObject({
		id: "job-tick-missing",
		severity: "suggest",
		path: join(user, "Library/LaunchAgents/com.kabane.job-tick.plist"),
		summary:
			"Nothing runs kabane job tick on this machine, so its 2 jobs never fire. --fix recipes/job-tick-missing installs a launchd agent that runs `kabane job tick` every minute.",
	});
	expect(finding?.fix).toBeDefined();
	JobTick.write({ ...TARGET, kabane: process.execPath }, user);
	expect(JobTick.check(2, TARGET, { platform: "darwin", home: user })).toEqual(
		[],
	);
});

it("counts a tick whose program is gone as missing, and offers to install it again", () => {
	const user = home();
	JobTick.write({ ...TARGET, kabane: join(user, "gone/kabane") }, user);
	const darwin = { platform: "darwin" as const, home: user };
	if (process.platform === "darwin") {
		const [finding] = JobTick.check(1, TARGET, darwin);
		expect(finding).toMatchObject({
			id: "job-tick-missing",
			summary: `The tick at ${JobTick.agentPath(user)} runs ${join(user, "gone/kabane")}, which is gone, so this machine's job never fires. --fix recipes/job-tick-missing installs a launchd agent that runs \`kabane job tick\` every minute.`,
		});
		JobTick.write({ ...TARGET, kabane: process.execPath }, user);
		expect(JobTick.check(1, TARGET, darwin)).toEqual([]);
	}
	// The crontab line's program, quoted as kabane writes it or bare as a hand-written one is.
	expect(
		JobTick.cronProgram(
			`MAILTO=""\n${JobTick.cronLine({ ...TARGET, kabane: "/home/it's/100%/kabane" })}\n`,
			"/home/me",
		),
	).toBe("/home/it's/100%/kabane");
	expect(
		JobTick.cronProgram(
			"* * * * * KABANE_HOME=$HOME/.kabane $HOME/.bun/bin/kabane job tick >> log\n",
			"/home/me",
		),
	).toBe("/home/me/.bun/bin/kabane");
	expect(
		JobTick.cronProgram("# kabane job tick\n", "/home/me"),
	).toBeUndefined();
});
