import { describe, expect, it } from "bun:test";
import type { Task } from "@cabane/core";
import { Brief } from "./brief";

const task = (id: string, title: string): Task => ({
	id,
	shortId: id,
	title,
	kind: "issue",
	state: "next",
	priority: "normal",
	provenance: { source: "human", discoveredAt: "2026-11-04T00:00:00.000Z" },
	needsReview: false,
	tags: [],
	createdAt: "2026-11-04T00:00:00.000Z",
	updatedAt: "2026-11-04T00:00:00.000Z",
});

const attempt: Brief.Interrupted = {
	lane: "P-2",
	startedAt: "2026-11-04T10:00:00.000Z",
	acpSessionId: "acp-1",
	logged: ["file:hello.txt (wip)"],
	commits: "",
	status: "?? hello.txt",
};

const subject = {
	runId: "r1",
	gates: [],
	parent: task("P-1", "parent"),
	task: task("P-2", "child"),
};

describe("Brief, after an interrupted attempt", () => {
	it("tells a new session what the attempt left, before the issue's own brief", () => {
		const sections = Brief.opening(
			{ ...subject, interrupted: attempt },
			"ASSEMBLED",
		).split("\n\n---\n\n");
		expect(sections).toHaveLength(3);
		expect(sections[1]).toStartWith(
			"This work was started before, by attempt P-2 (from 2026-11-04T10:00:00.000Z), which was interrupted",
		);
		expect(sections[1]).toContain("- file:hello.txt (wip)");
		expect(sections[1]).toContain("It made no commit.");
		expect(sections[1]).toContain("```\n?? hello.txt\n```");
		expect(sections[2]).toBe("ASSEMBLED");
	});

	it("says nothing of it to a first attempt", () => {
		expect(
			Brief.opening(subject, "ASSEMBLED").split("\n\n---\n\n"),
		).toHaveLength(2);
	});

	it("puts the takeover in a lens's and the fixer's brief too", () => {
		const lens = Brief.lens(
			{
				...subject,
				lens: "security",
				prompt: "LENS",
				gates: [],
				interrupted: attempt,
			},
			"ASSEMBLED",
		);
		const fixer = Brief.fixer(
			{ ...subject, findings: [], gates: [], interrupted: attempt },
			"ASSEMBLED",
		);
		for (const brief of [lens, fixer])
			expect(brief).toContain(
				"by attempt P-2 (from 2026-11-04T10:00:00.000Z), which was interrupted",
			);
	});

	it("tells the resumed session only that its last turn was cut, with what the tree shows", () => {
		const prompt = Brief.resumed(attempt);
		expect(prompt).toStartWith(
			"The kabane loop runner exited while your last turn was running",
		);
		expect(prompt).toContain("?? hello.txt");
		expect(prompt).not.toContain("You are one implementing session");
	});
});

describe("Brief after a red gate", () => {
	const gate = {
		name: "check",
		command: "grep -q fixed out.txt",
		ok: false,
		exit: 1,
		ms: 3,
		tail: "no match",
	};

	it("tells the resumed session only which gate failed, how, and to close again", () => {
		const prompt = Brief.retriedInSession(subject.task, gate);
		expect(prompt.split("\n")[0]).toBe(
			"After you called kabane_done on P-2, the runner ran the gates and the `check` gate (`grep -q fixed out.txt`) failed with exit 1, so P-2 is open again. This is the same session, resumed, so your instructions, the brief and what you did so far still hold. The end of the gate's output:",
		);
		expect(prompt).toContain("```\nno match\n```");
		expect(prompt).toEndWith(
			"Make it pass, then call kabane_done on P-2 again.",
		);
		expect(prompt).not.toContain("You are one implementing session");
	});

	it("gives a new session the failure inside the full brief", () => {
		const sections = Brief.opening(
			{ ...subject, retry: gate },
			"ASSEMBLED",
		).split("\n\n---\n\n");
		expect(sections[0]).toStartWith("You are one implementing session");
		expect(sections[1]).toStartWith(
			"P-2 was closed before, then reopened: the `check` gate (`grep -q fixed out.txt`) failed with exit 1 on that work.",
		);
		expect(sections[2]).toBe("ASSEMBLED");
	});
});

describe("Brief on a single issue", () => {
	const lone = task("P-9", "lone");
	const single = { runId: "r1", parent: lone, task: lone, gates: [] };

	it("tells the implementing session the issue is the whole run, with no subtasks or siblings", () => {
		const [instructions] = Brief.opening(single, "ASSEMBLED").split(
			"\n\n---\n\n",
		);
		expect(instructions).toStartWith(
			'You are the implementing session of kabane loop run r1, which drives the single issue P-9 ("lone") to completion.',
		);
		expect(instructions).toContain("Your issue is P-9.");
		expect(instructions).toContain(
			"When the issue is implemented and you have verified it, call kabane_done on P-9.",
		);
		expect(instructions).toContain("Do not make it a child of P-9");
		expect(instructions).not.toMatch(/subtask|sibling/);
	});

	it("speaks of the run's target, not its subtasks, to a lens and the fixer", () => {
		const lens = Brief.lens(
			{ ...single, lens: "security", prompt: "LENS", gates: [] },
			"ASSEMBLED",
		);
		const fixer = Brief.fixer(
			{ ...single, findings: [], gates: [] },
			"ASSEMBLED",
		);
		expect(lens).toStartWith(
			'You are the `security` verifier of kabane loop run r1 on P-9 ("lone"). Its work is done.',
		);
		expect(fixer).toStartWith(
			'You are the fixer session of kabane loop run r1 on P-9 ("lone"), whose work is done.',
		);
		for (const brief of [lens, fixer])
			expect(brief).not.toContain("subtasks of");
	});

	it("still tells a subtask's session it is one of several", () => {
		expect(Brief.opening(subject, "ASSEMBLED")).toContain(
			'which drives the subtasks of P-1 ("parent") to completion',
		);
	});
});

describe("Brief implementing checks", () => {
	for (const noun of ["issue", "subtask"]) {
		const target = {
			...subject,
			task: noun === "issue" ? subject.parent : subject.task,
		};

		it(`names the runner's ordered gates for a ${noun}`, () => {
			const brief = Brief.opening(
				{ ...target, gates: ["typecheck", "lint"] },
				"ASSEMBLED",
			);
			expect(brief).toContain(
				`When you call kabane_done, the runner runs the gates (\`typecheck\`, \`lint\`) in that order on the tree outside your session; a failing gate reopens the ${noun} with its output.`,
			);
			expect(brief).toContain("Run the checks your change needs");
			expect(brief).toContain(
				"if a check fails only because the environment forbids something (a denied process or a blocked network call)",
			);
			expect(brief).toContain(
				`explain it with kabane_comment and leave it to the gates without parking the ${noun}`,
			);
			expect(brief).not.toContain("No gates are configured");
		});

		it(`requires the project's checks for a ${noun} without gates`, () => {
			const brief = Brief.opening(target, "ASSEMBLED");
			expect(brief).toContain(
				"No gates are configured for this run, so nothing runs the project's checks on your result after your session: run the project's checks yourself before you call kabane_done.",
			);
			expect(brief).not.toContain("leave it to the gates");
			expect(brief).not.toContain("the runner runs the gates");
		});
	}
});

describe("Brief on a decision that is the human's", () => {
	const asked =
		"with kabane_ask: the choices, your recommendation and why, one question per decision and all of them in one call";
	const parked =
		"That parks it as waiting until the human answers. Comment only what the questions do not carry, such as evidence or a link.";

	it("has an implementing session ask a design fork on its own issue instead of guessing", () => {
		for (const target of [subject.task, subject.parent]) {
			const [instructions] = Brief.opening(
				{ ...subject, task: target },
				"ASSEMBLED",
			).split("\n\n---\n\n");
			expect(instructions).toContain(
				`If the work reaches a design choice the brief does not settle, do not guess: file the decision on ${target.id} ${asked}. ${parked} Then end your turn.`,
			);
		}
	});

	it("has a lens file a trade-off finding, then ask its options on it", () => {
		const lens = Brief.lens(
			{ ...subject, lens: "security", prompt: "LENS", gates: [] },
			"ASSEMBLED",
		);
		expect(lens).toContain(
			`When the fix is a trade-off the human must choose, file the finding all the same, then file the decision on it ${asked}. ${parked} The fixer leaves a waiting finding to the human.`,
		);
	});

	it("has the fixer ask a finding that needs the human's call, and only comment one that is wrong", () => {
		const fixer = Brief.fixer(
			{ ...subject, findings: [], gates: [] },
			"ASSEMBLED",
		);
		expect(fixer).toContain(
			'If a finding is wrong, already fixed, or outside P-1\'s scope, do not change code for it and do not close it: say why with kabane_comment on it, then call kabane_edit on it with state "waiting", so it stays open for a human.',
		);
		expect(fixer).toContain(
			`If fixing a finding needs a call that is the human's (two reasonable fixes, or a change to what P-1 asked for), do not change code for it either: file the decision on it ${asked}. ${parked}`,
		);
		expect(Brief.fixerContinuation([subject.task])).toEndWith(
			"or file the decision it needs with kabane_ask.",
		);
	});
});

describe("Brief.recheck", () => {
	const recheck = (diff: string) =>
		Brief.recheck(
			{
				runId: "r1",
				parent: task("P-1", "parent"),
				lens: "functional",
				prompt: "# Functional lens\n",
				findings: [
					{ ...task("P-7", "empty input crashes"), tags: ["finding", "p1"] },
				],
				base: "abc123",
				diff,
				gates: ["test"],
			},
			"ASSEMBLED",
		).split("\n\n---\n\n");

	it("hands the lens its closed findings, the fixer's diff, its prompt and the parent's brief, to report on", () => {
		const [instructions, diff, prompt, assembled, ...rest] = recheck(
			"diff --git a/x b/x\n+fixed\n",
		);
		expect(rest).toEqual([]);
		expect(instructions).toContain("- P-7 · p1 · ");
		expect(instructions).toContain("Do not change files");
		expect(instructions).toContain('kabane_edit (state "next")');
		expect(instructions).toContain("Its gates (`test`) pass");
		expect(diff).toContain("`git diff abc123`");
		expect(diff).toContain("```diff\ndiff --git a/x b/x\n+fixed\n```");
		expect(prompt).toBe("# Functional lens");
		expect(assembled).toBe("ASSEMBLED");
	});

	it("fences a diff that holds fences of its own, cuts a long one, and says when it is empty", () => {
		const [, fenced] = recheck("+```ts\n+code\n+```\n");
		expect(fenced).toContain("````diff\n+```ts");
		const [, cut] = recheck(`+${"x".repeat(70_000)}\n`);
		expect(cut).toContain("The diff is cut at 60000 characters");
		expect(cut?.length).toBeLessThan(61_000);
		const [, empty] = recheck("");
		expect(empty).toContain("shows no change");
	});
});
