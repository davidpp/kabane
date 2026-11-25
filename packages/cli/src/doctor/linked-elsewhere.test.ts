// A home whose jobs link points at an older release's copy, as a move from Homebrew 1.x to the
// installer left one, repaired by doctor's bare `--fix`. Real links in a temporary directory; the
// running kabane's own copy is passed as `root`, since a source checkout ships none.
import { afterAll, expect, it } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@kabane/core";
import { Doctor, type Extension, Settings } from "@kabane/extension";
import { linkedElsewhere } from "./linked-elsewhere";

const home = realpathSync(mkdtempSync(join(tmpdir(), "kabane-elsewhere-")));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const ctx: Extension.Ctx = {
	home,
	store: home,
	cwd: home,
	actor: "doctor-test",
	harnessMode: "default",
	settings: Settings.port(async () => ok([])),
};

const release = (dir: string): string => {
	for (const name of ["jobs", "loop"])
		mkdirSync(join(home, dir, "extensions", name), { recursive: true });
	writeFileSync(join(home, dir, "kabane"), "");
	return join(home, dir, "extensions");
};

it("reports an enabled extension linked into another release's copy, and --fix links it to this one's", async () => {
	const root = release("current");
	const older = release("older");
	mkdirSync(join(home, "extensions"));
	symlinkSync(join(older, "jobs"), join(home, "extensions/jobs"));
	// Linked elsewhere too, but not enabled: nothing loads it, so it is no finding.
	symlinkSync(join(older, "loop"), join(home, "extensions/loop"));

	const report = await Doctor.run(linkedElsewhere(home, ["jobs"], root), ctx, {
		fix: true,
	});
	expect(report.findings).toEqual([
		expect.objectContaining({
			source: "jobs",
			id: "extension-elsewhere",
			severity: "auto",
			summary: `${join(home, "extensions/jobs")} links to ${join(older, "jobs")}, another kabane install's copy, so this kabane runs that release's jobs, its migrations included`,
		}),
	]);
	expect(report.fixes).toEqual([
		{
			source: "jobs",
			id: "extension-elsewhere",
			result: ok(`linked jobs to ${join(root, "jobs")}`),
		},
	]);
	expect(realpathSync(join(home, "extensions/jobs"))).toBe(join(root, "jobs"));
	expect(linkedElsewhere(home, ["jobs"], root)).toEqual([]);
});

// Doctor builds this list before any check runs, so a throw here would cost the whole report.
it("finds nothing, and throws nothing, when the home's extensions is a file or unreadable", () => {
	const root = release("current");
	const broken = realpathSync(mkdtempSync(join(tmpdir(), "kabane-broken-")));
	try {
		writeFileSync(join(broken, "extensions"), "");
		expect(linkedElsewhere(broken, ["jobs"], root)).toEqual([]);
		rmSync(join(broken, "extensions"));
		mkdirSync(join(broken, "extensions"));
		chmodSync(join(broken, "extensions"), 0o000);
		expect(linkedElsewhere(broken, ["jobs"], root)).toEqual([]);
	} finally {
		chmodSync(join(broken, "extensions"), 0o700);
		rmSync(broken, { recursive: true, force: true });
	}
});
