import { describe, expect, it } from "bun:test";
import type { Task } from "@cabane/core";
import { Brief } from "./brief";
import type { Gates } from "./gates";

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

const tree: Brief.Tree = {
	worktree: true,
	isolation: "shared",
	land: "none",
	dir: "/run/project",
	branch: "run-branch",
	runBranch: "run-branch",
};

const subject = {
	tree,
	runId: "r1",
	gates: [],
	concurrent: false,
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
				lenses: [{ name: "security", prompt: "LENS" }],
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
		expect(prompt).toContain(
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
	// Concurrent or not, a single issue has no siblings.
	const single = {
		tree,
		runId: "r1",
		parent: lone,
		task: lone,
		gates: [],
		concurrent: true,
	};

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
			{
				...single,
				lenses: [{ name: "security", prompt: "LENS" }],
				gates: [],
			},
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

	it("tells a subtask's session its siblings share the tree only when the run has more than one session at once", () => {
		const SIBLINGS =
			"Other sessions may be working on sibling subtasks in the same repository at the same time.";
		const alone = Brief.opening(subject, "ASSEMBLED");
		expect(alone).toContain(
			'which drives the subtasks of P-1 ("parent") to completion.',
		);
		expect(alone).not.toContain(SIBLINGS);
		expect(
			Brief.opening({ ...subject, concurrent: true }, "ASSEMBLED"),
		).toContain(`("parent") to completion. ${SIBLINGS}`);
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
			{
				...subject,
				lenses: [{ name: "security", prompt: "LENS" }],
				gates: [],
			},
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
			'If a finding is wrong, already fixed, or outside P-1\'s scope, do not change code for it and do not close it: say why with kabane_comment on it, then call kabane_edit on it with state "waiting", so it stays open with the reason and next step recorded.',
		);
		expect(fixer).toContain(
			`If fixing a finding needs a call that is the human's (two reasonable fixes, or a change to what P-1 asked for), do not change code for it either: file the decision on it ${asked}. ${parked}`,
		);
		expect(Brief.fixerContinuation([subject.task])).toContain(
			"or file the decision it needs with kabane_ask.",
		);
	});
});

describe("Brief on the gates a review can trust", () => {
	const passed: Gates.Result[] = [
		{
			name: "check",
			command: "bun run check",
			ok: true,
			exit: 0,
			ms: 41_200,
			tail: "",
		},
		{
			name: "test",
			command: "bun run test",
			ok: true,
			exit: 0,
			ms: 192_000,
			tail: "",
		},
	];
	const named =
		"These gates passed on this exact tree: `check` (`bun run check`, 41s), `test` (`bun run test`, 3m12s).";
	const rule =
		"Do not rerun them or any part of them (a package's tests, one test file, lint) to confirm they pass. Run something only when it checks what they cannot";
	const lens = (extra: { gates: string[]; passed?: Gates.Result[] }) =>
		Brief.lens(
			{
				...subject,
				lenses: [{ name: "functional", prompt: "LENS" }],
				...extra,
			},
			"ASSEMBLED",
		);
	const recheck = (extra: { gates: string[]; passed?: Gates.Result[] }) =>
		Brief.recheck(
			{
				...subject,
				lens: "functional",
				prompt: "LENS",
				findings: [],
				base: "abc123",
				diff: "",
				...extra,
			},
			"ASSEMBLED",
		);

	it("names each gate of a green pass with its command and duration, and says not to rerun them", () => {
		for (const brief of [
			lens({ gates: ["check", "test"], passed }),
			recheck({ gates: ["check", "test"], passed }),
		]) {
			expect(brief).toContain(`${named} ${rule}`);
			expect(brief).not.toContain("Its gates (");
		}
	});

	it("says no pass is verified when no green pass is on hand, and claims nothing without gates", () => {
		for (const brief of [
			lens({ gates: ["check", "test"] }),
			recheck({ gates: ["check", "test"] }),
		]) {
			expect(brief).toContain(
				"The run's gates (`check`, `test`) have no green pass on record for this exact tree: do not assume they pass, and run the checks you need.",
			);
			expect(brief).not.toContain("pass on the tree you are reviewing");
			expect(brief).not.toContain("Do not rerun");
		}
		for (const brief of [lens({ gates: [] }), recheck({ gates: [] })]) {
			expect(brief).toContain(
				"No gates are configured for this run, so nothing has run the project's checks on the result: do not assume they pass.",
			);
			expect(brief).not.toContain("Do not rerun");
		}
	});
});

describe("Brief.recheck", () => {
	const recheck = (diff: string) =>
		Brief.recheck(
			{
				tree,
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
		expect(instructions).toContain(
			"The run's gates (`test`) have no green pass on record",
		);
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

describe("Brief on a task with a checklist", () => {
	const items = [
		{ handle: "P-2.1", text: "Parse", done: true },
		{ handle: "P-2.2", text: "Validate", done: false },
		{ handle: "P-2.3", text: "Write", done: false },
	];

	it("tells a subtask's session to start at the first open item and tick each as it lands", () => {
		const [instructions] = Brief.opening(
			{ ...subject, checklist: items },
			"ASSEMBLED",
		).split("\n\n---\n\n");
		expect(instructions).toContain(
			'P-2 has a checklist of 3 items, 1 ticked, in its brief below: the steps of this one change, worked in this tree one after another. Start at P-2.2 ("Validate").',
		);
		expect(instructions).toContain(
			'(kabane_checklistTick with items: ["P-2.2"] for this one)',
		);
		expect(instructions).toContain(
			"Call kabane_done on P-2 only once every item is ticked",
		);
	});

	it("says nothing of a checklist to a task without one", () => {
		expect(Brief.opening(subject, "ASSEMBLED")).not.toContain("checklist");
	});

	it("points a resumed session at the first open item", () => {
		expect(Brief.resumed(attempt, items)).toContain(
			'Its checklist has 1 of 3 items ticked. Continue at P-2.2 ("Validate")',
		);
		expect(
			Brief.resumed(
				attempt,
				items.map((item) => ({ ...item, done: true })),
			),
		).not.toContain("Its checklist");
	});

	it("names the open items in the nudge, and in the one after a refused kabane_done", () => {
		const [, ...open] = items;
		expect(Brief.continuation(subject.task, open)).toStartWith(
			'P-2 is still open, with 2 checklist items not ticked: P-2.2, P-2.3. Continue at P-2.2 ("Validate")',
		);
		const [first, ...rest] = open;
		if (!first) throw new Error("no open item");
		expect(Brief.reopened(subject.task, [first, ...rest])).toStartWith(
			"You called kabane_done on P-2 with 2 checklist items not ticked (P-2.2, P-2.3), so the run reopened it",
		);
	});
});

describe("Brief working copy", () => {
	for (const worktree of [true, false])
		for (const isolation of ["worktree", "shared"] as const)
			for (const single of [true, false])
				for (const land of ["none", "pr", "merge"] as const)
					it(`${worktree ? "worktree" : "checkout"}, ${isolation}, ${single ? "single" : "subtask"}, ${land}`, () => {
						const isolated = worktree && isolation === "worktree" && !single;
						const place = {
							...tree,
							worktree,
							isolation,
							land,
							dir: isolated ? "/run/trees/1/project" : "/run/project",
							branch: isolated ? "claim-branch" : "run-branch",
						};
						const prompt = Brief.opening(
							{
								...subject,
								tree: place,
								task: single ? subject.parent : subject.task,
								concurrent: !single && !isolated,
							},
							"Branch foo in its own worktree",
						);
						expect(prompt).toContain(`You are in \`${place.dir}\``);
						expect(prompt).toContain(
							"Do not create a branch or a worktree and do not switch branches.",
						);
						expect(prompt).toContain(
							"Where the issue's brief names a branch, a worktree, a merge order or who pushes, opens a PR or runs landing automation, this paragraph replaces it.",
						);
						expect(prompt.indexOf("this paragraph replaces it")).toBeLessThan(
							prompt.indexOf("Branch foo"),
						);
						expect(prompt.includes("Sibling sessions edit the same tree")).toBe(
							!single && !isolated,
						);
						expect(prompt.includes("nothing needs to reach main")).toBe(
							!single,
						);
						expect(
							prompt.includes(
								"a green pass merges this branch into the run's branch `run-branch`",
							),
						).toBe(isolated);
						if (!worktree) {
							expect(prompt).toContain(
								"The run commits nothing: commit your own work.",
							);
							expect(prompt).not.toContain("opens the pull request");
						} else {
							expect(prompt).toContain(`on branch \`${place.branch}\``);
							expect(prompt).toContain(
								land === "pr"
									? "opens the pull request; push nothing"
									: land === "merge"
										? "merges it into its base in the project checkout"
										: "stays in its worktree with no automatic landing",
							);
						}
					});

	it("keeps reviews and fixes in the run's tree even with isolated subtasks", () => {
		const target = {
			...subject,
			tree: { ...tree, isolation: "worktree" as const },
			lens: "functional",
			prompt: "LENS",
			lenses: [{ name: "functional", prompt: "LENS" }],
			findings: [],
			base: "base",
			diff: "",
		};
		for (const prompt of [
			Brief.lens(target, "BRIEF"),
			Brief.recheck(target, "BRIEF"),
			Brief.fixer(target, "BRIEF"),
		]) {
			expect(prompt).toContain(
				"You are in `/run/project`, a git worktree on branch `run-branch`",
			);
			expect(prompt).toContain("This is the run's one tree and branch.");
			expect(prompt).not.toContain("a green pass merges this branch");
		}
		const review = Brief.lens(
			{ ...target, tree: { ...tree, worktree: false } },
			"BRIEF",
		);
		expect(review).toContain("Review here without changing files.");
		expect(review).not.toContain("commit your own work");
	});

	it("describes post-landing automation without exposing its command or promising CI completion", () => {
		const target = {
			...subject,
			tree: {
				...tree,
				land: "pr" as const,
				onLanded: "TOKEN=private gh pr merge --auto",
			},
			lenses: [{ name: "functional", prompt: "LENS" }],
			lens: "functional",
			prompt: "LENS",
			findings: [],
			base: "base",
			diff: "",
		};
		for (const prompt of [
			Brief.opening(target, "BRIEF"),
			Brief.lens(target, "BRIEF"),
			Brief.recheck(target, "BRIEF"),
			Brief.fixer(target, "BRIEF"),
			Brief.reviewing(target.tree),
		]) {
			expect(prompt).toContain("After successful landing, the runner executes");
			expect(prompt).not.toContain(target.tree.onLanded);
			expect(prompt).toContain("do not run them early or wait in this session");
			expect(prompt).toContain("as pending automation");
			expect(prompt).toContain("kabane loop status <runId>");
			expect(prompt).toContain("gh pr checks <pr-url>");
			expect(prompt).toContain(
				"does not monitor later CI or automatically close findings",
			);
		}
		const fixer = Brief.fixer(target, "BRIEF");
		expect(fixer).toContain(
			"If verification must wait for landing or later CI",
		);
		expect(fixer).toContain('then kabane_edit with state "waiting"');
		expect(fixer).toContain(
			"who pushes, opens a PR or runs landing automation, this paragraph replaces it",
		);
		for (const place of [
			{ ...target.tree, land: "none" as const },
			{ ...target.tree, worktree: false },
		]) {
			const prompt = Brief.opening({ ...subject, tree: place }, "BRIEF");
			expect(prompt).toContain("so it will not run automatically");
			expect(prompt).not.toContain("After successful landing");
		}
		expect(Brief.opening(subject, "BRIEF")).toContain(
			"No onLanded command is configured",
		);
	});

	it("repeats the working-copy constraint on nudges, retries and resumes", () => {
		const item = { handle: "P-2.1", text: "finish", done: false };
		for (const prompt of [
			Brief.continuation(subject.task),
			Brief.continuation(subject.task, [item]),
			Brief.reopened(subject.task, [item]),
			Brief.resumed(attempt),
			Brief.fixerContinuation([subject.task]),
			Brief.retriedInSession(subject.task, {
				name: "test",
				command: "bun test",
				ok: false,
				exit: 1,
				ms: 1,
				tail: "failed",
			}),
		])
			expect(prompt).toContain(
				"Continue in the directory and on the branch assigned by this run",
			);
	});
});
