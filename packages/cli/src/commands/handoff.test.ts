import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Planner, type Result, type TaskEntry } from "@cabane/core";
import { HANDOFF_TEMPLATE } from "@cabane/handoff";
import { run } from "../main";

const HUMAN = "cabane://actor/human/test";
const unwrap = <T>(result: Result<T>): T => {
	if (!result.ok) throw result.error;
	return result.value;
};
const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0))
		rmSync(home, { recursive: true, force: true });
});

const device = async () => {
	const home = mkdtempSync(join(tmpdir(), "kabane-handoff-"));
	homes.push(home);
	const env = { KABANE_HOME: home, KABANE_HARNESSES: "" };
	const init = await run(
		["init", "--actor", HUMAN, "--device", "test"],
		env,
		home,
	);
	expect(init.exitCode).toBe(0);
	return { home, kabane: (argv: string[]) => run(argv, env, home) };
};

it("records handoffs from markdown files and prints the latest as the brief does, every one, or the entries", async () => {
	const { home, kabane } = await device();
	const task = unwrap(
		await Planner.addTask(home, {
			title: "Read the vendor docs",
			kind: "issue",
		}),
	);
	const label = task.shortId ?? task.id;
	expect((await kabane(["handoff", label])).text).toBe(
		`No handoff on ${label}.`,
	);

	writeFileSync(join(home, "first.md"), "### Summary\n\nFirst findings.\n");
	writeFileSync(
		join(home, "second.md"),
		'### Summary\n\nThree findings.\n\n### Evidence\n\n"100 requests per minute" (url:https://example.com/limits)\n',
	);
	expect((await kabane(["handoff", label, "--from", "first.md"])).text).toBe(
		`${label} handed off · 0 earlier on record`,
	);
	expect((await kabane(["handoff", label, "--from", "second.md"])).text).toBe(
		`${label} handed off · 1 earlier on record`,
	);

	const latest = (await kabane(["handoff", label])).text;
	const brief = await kabane([
		"context",
		label,
		"--format",
		"concise",
		"--sections",
		"handoff.latest",
	]);
	expect(latest).toBe((brief.json as { markdown: string }).markdown);
	expect(latest).toStartWith(`## Handoff from ${HUMAN} · `);
	expect(latest).toContain("Three findings.");
	expect(latest).toEndWith("1 earlier handoff entry on record.");
	expect(latest).not.toContain("First findings.");

	const all = await kabane(["handoff", label, "--all"]);
	expect(all.text.indexOf("First findings.")).toBeLessThan(
		all.text.indexOf("Three findings."),
	);
	const { handoffs } = all.json as { handoffs: TaskEntry[] };
	expect(handoffs.map((h) => [h.kind, h.author, h.content])).toEqual([
		["handoff", HUMAN, "### Summary\n\nFirst findings."],
		[
			"handoff",
			HUMAN,
			'### Summary\n\nThree findings.\n\n### Evidence\n\n"100 requests per minute" (url:https://example.com/limits)',
		],
	]);
	expect(
		((await kabane(["handoff", label])).json as { handoffs: TaskEntry[] })
			.handoffs,
	).toEqual(handoffs.slice(1));
	expect(unwrap(await Planner.getTask(home, task.id))).toEqual(task);
});

it("puts the latest handoff after the description and before the checklist", async () => {
	const { home, kabane } = await device();
	const task = unwrap(
		await Planner.addTask(home, {
			title: "Sketch the screen",
			description: "One screen for onboarding.",
			kind: "issue",
		}),
	);
	const label = task.shortId ?? task.id;
	await kabane(["checklist", "add", label, "Draw", "the", "empty", "state"]);
	writeFileSync(join(home, "design.md"), "### Summary\n\nThree states.");
	await kabane(["handoff", label, "--from", "design.md"]);
	const { markdown } = (await kabane(["context", label])).json as {
		markdown: string;
	};
	const description = markdown.indexOf("One screen for onboarding.");
	const handoff = markdown.indexOf("## Handoff from");
	const checklist = markdown.indexOf("## Checklist");
	expect(description).toBeGreaterThan(-1);
	expect(handoff).toBeGreaterThan(description);
	expect(checklist).toBeGreaterThan(handoff);
});

it("prints the template, and refuses a blank body, a file it cannot read and a missing issue", async () => {
	const { home, kabane } = await device();
	const task = unwrap(
		await Planner.addTask(home, { title: "Design", kind: "issue" }),
	);
	const label = task.shortId ?? task.id;
	expect((await kabane(["handoff", "--template"])).text).toBe(HANDOFF_TEMPLATE);
	writeFileSync(join(home, "blank.md"), "\n  \n");
	expect((await kabane(["handoff", label, "--from", "blank.md"])).text).toBe(
		`Error: A handoff on "${label}" needs a body: markdown under Summary, Evidence, Not verified and Risk, or the headings the work needs.`,
	);
	const missing = await kabane(["handoff", label, "--from", "nope.md"]);
	expect(missing.exitCode).toBe(1);
	expect(missing.text).toBe(
		'Error: Cannot read the handoff file "nope.md" (ENOENT): give the path of a markdown file, or - to read stdin.',
	);
	const ghost = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
	for (const absent of ["NOPE-1", ghost]) {
		expect((await kabane(["handoff", absent])).exitCode).toBe(1);
		writeFileSync(join(home, "body.md"), "### Summary\n\nDone.");
		expect(
			(await kabane(["handoff", absent, "--from", "body.md"])).exitCode,
		).toBe(1);
	}
	expect((await kabane(["handoff", ghost])).text).toBe(
		`Error: Cannot find the issue "${ghost}" ("no task has this ULID"): give its short id (JCAB-12) or its ULID, as list and search show them.`,
	);
	// Two issues filed together share their ULID's time part: a prefix of it names both.
	const other = unwrap(
		await Planner.addTask(home, { title: "Research", kind: "issue" }),
	);
	let shared = 0;
	while (task.id[shared] === other.id[shared]) shared++;
	const ambiguous = task.id.slice(0, shared);
	for (const argv of [
		["handoff", ambiguous],
		["handoff", ambiguous, "--from", "body.md"],
	]) {
		const refused = await kabane(argv);
		expect(refused.exitCode).toBe(1);
		expect(refused.text).toStartWith(
			`Error: Cannot find the issue "${ambiguous}" ("Ambiguous ID prefix`,
		);
		expect(refused.text).not.toContain("\n");
	}
	expect((await kabane(["handoff", task.id.slice(0, shared + 1)])).text).toBe(
		`No handoff on ${label}.`,
	);
	expect(
		(
			await kabane([
				"handoff",
				other.id.slice(0, shared + 1),
				"--from",
				"body.md",
			])
		).text,
	).toBe(`${other.shortId} handed off · 0 earlier on record`);
	// Case and padding do not matter: a lowercase ULID or prefix, a padded short id.
	for (const id of [
		task.id.toLowerCase(),
		task.id.slice(0, shared + 1).toLowerCase(),
		` ${label} `,
		label.toLowerCase(),
	])
		expect([id, (await kabane(["handoff", id])).text]).toEqual([
			id,
			`No handoff on ${label}.`,
		]);
	for (const id of [other.id.toLowerCase(), ` ${other.shortId} `])
		expect([
			id,
			(await kabane(["handoff", id, "--from", "body.md"])).exitCode,
		]).toEqual([id, 0]);
	expect(
		unwrap(await Planner.getEntries(home, other.id, { kind: "handoff" })),
	).toHaveLength(3);
	for (const conflict of [
		["handoff", label, "--from"],
		["handoff", label, "--from", "body.md", "--from", "blank.md"],
		["handoff", label, "--from", "body.md", "--template"],
		["handoff", label, "--template"],
		["handoff", "--template", "--all"],
		["handoff", label, "--from", "body.md", "--all"],
		["handoff", label, "--all", "--from", "body.md"],
		["handoff", label, "extra"],
		["handoff", label, "extra", "--from", "body.md"],
	]) {
		const refused = await kabane(conflict);
		expect([conflict, refused.exitCode]).toEqual([conflict, 2]);
		expect(refused.text).toContain("Usage: kabane handoff <id>");
	}
	expect((await kabane(["handoff", label, "extra"])).text).toStartWith(
		'Error: Unexpected "extra" after the issue: handoff takes one issue\n',
	);
	expect((await kabane(["handoff", label, "--all"])).text).toBe(
		`No handoff on ${label}.`,
	);
	expect((await kabane(["handoff", "--all", label])).exitCode).toBe(2);
	expect((await kabane(["handoff"])).exitCode).toBe(2);
	expect((await kabane(["handoff", label])).text).toBe(
		`No handoff on ${label}.`,
	);
});
