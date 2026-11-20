import "./test-host";
import { describe, expect, it } from "bun:test";
import type { Task } from "@kabane/core";
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
		expect(sections[1]).toContain("P-2");
		expect(sections[1]).toContain("2026-11-04T10:00:00.000Z");
		expect(sections[1]).toContain("interrupted");
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
		const [failure] = prompt.split("\n");
		expect(failure).toContain("kabane_done on P-2");
		expect(failure).toContain("`check`");
		expect(failure).toContain("`grep -q fixed out.txt`");
		expect(failure).toContain("exit 1");
		expect(failure).toContain("open again");
		expect(failure).toContain("same session");
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
		expect(sections[1]).toContain("P-2");
		expect(sections[1]).toContain("reopened");
		expect(sections[1]).toContain("`check`");
		expect(sections[1]).toContain("`grep -q fixed out.txt`");
		expect(sections[1]).toContain("exit 1");
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
		expect(instructions).toContain("implementing session");
		expect(instructions).toContain("r1");
		expect(instructions).toContain("single issue P-9");
		expect(instructions).toContain("lone");
		expect(instructions).toContain("Your issue is P-9.");
		expect(instructions).toContain("verified");
		expect(instructions).toContain("kabane_done on P-9");
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
		expect(lens).toContain("`security` verifier");
		expect(lens).toContain("r1");
		expect(lens).toContain("P-9");
		expect(lens).toContain("lone");
		expect(lens).toContain("work is done");
		expect(fixer).toContain("fixer session");
		expect(fixer).toContain("r1");
		expect(fixer).toContain("P-9");
		expect(fixer).toContain("lone");
		expect(fixer).toContain("work is done");
		for (const brief of [lens, fixer])
			expect(brief).not.toContain("subtasks of");
	});

	it("tells a subtask's session its siblings share the tree only when the run has more than one session at once", () => {
		const SIBLINGS = "sibling subtasks";
		const alone = Brief.opening(subject, "ASSEMBLED");
		expect(alone).toContain(
			'which drives the subtasks of P-1 ("parent") to completion.',
		);
		expect(alone).not.toContain(SIBLINGS);
		expect(
			Brief.opening({ ...subject, concurrent: true }, "ASSEMBLED"),
		).toContain(SIBLINGS);
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
			expect(brief).toContain("kabane_done");
			expect(brief).toContain("`typecheck`, `lint`");
			expect(brief).toContain("in that order");
			expect(brief).toContain("outside your session");
			expect(brief).toContain(`a failing gate reopens the ${noun}`);
			expect(brief).toContain("Run the checks your change needs");
			expect(brief).toContain("environment forbids");
			expect(brief).toContain("denied process");
			expect(brief).toContain("blocked network");
			expect(brief).toContain("kabane_comment");
			expect(brief).toContain("leave it to the gates");
			expect(brief).toContain(`without parking the ${noun}`);
			expect(brief).not.toContain("No gates are configured");
		});

		it(`requires the project's checks for a ${noun} without gates`, () => {
			const brief = Brief.opening(target, "ASSEMBLED");
			expect(brief).toContain("No gates are configured");
			expect(brief).toContain("run the project's checks yourself");
			expect(brief).toContain("before you call kabane_done");
			expect(brief).not.toContain("leave it to the gates");
			expect(brief).not.toContain("the runner runs the gates");
		});
	}
});

describe("Brief on a decision that is the human's", () => {
	it("has an implementing session ask a design fork on its own issue instead of guessing", () => {
		for (const target of [subject.task, subject.parent]) {
			const [instructions] = Brief.opening(
				{ ...subject, task: target },
				"ASSEMBLED",
			).split("\n\n---\n\n");
			const decision = instructions
				?.split("\n")
				.find((paragraph) =>
					paragraph.startsWith("If the work reaches a design choice"),
				);
			const ask = decision?.split(". ")[0];
			expect(ask).toContain(
				`file the decision on ${target.id} with kabane_ask`,
			);
			expect(ask).toContain("the choices, your recommendation and why");
			expect(ask).toContain(
				"one question per decision and all of them in one call",
			);
			expect(decision).toContain("parks it as waiting until the human answers");
			expect(decision).toContain("Then end your turn.");
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
		expect(lens).toContain("trade-off");
		expect(lens).toContain("file the finding");
		expect(lens).toContain("kabane_ask");
		expect(lens).toContain(
			"with kabane_ask: the choices, your recommendation and why",
		);
		expect(lens).toContain("waiting finding");
	});

	it("has the fixer ask a finding that needs the human's call, and only comment one that is wrong", () => {
		const fixer = Brief.fixer(
			{ ...subject, findings: [], gates: [] },
			"ASSEMBLED",
		);
		expect(fixer).toContain("finding is wrong");
		expect(fixer).toContain("already fixed");
		expect(fixer).toContain("outside P-1's scope");
		expect(fixer).toContain("do not close it");
		expect(fixer).toContain("kabane_comment");
		expect(fixer).toContain("kabane_edit");
		expect(fixer).toContain('state "waiting"');
		expect(fixer).toContain("needs a call that is the human's");
		expect(fixer).toContain("do not change code");
		expect(fixer).toContain("kabane_ask");
		expect(fixer).toContain(
			"with kabane_ask: the choices, your recommendation and why",
		);
		expect(fixer).toContain("parks it as waiting until the human answers");
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
			expect(brief).toContain("exact tree");
			expect(brief).toContain("`check` (`bun run check`, 41s)");
			expect(brief).toContain("`test` (`bun run test`, 3m12s)");
			expect(brief).toContain("Do not rerun");
			expect(brief).toContain("checks what they cannot");
			expect(brief).not.toContain("Its gates (");
		}
	});

	it("says no pass is verified when no green pass is on hand, and claims nothing without gates", () => {
		for (const brief of [
			lens({ gates: ["check", "test"] }),
			recheck({ gates: ["check", "test"] }),
		]) {
			expect(brief).toContain("`check`, `test`");
			expect(brief).toContain("no green pass");
			expect(brief).toContain("exact tree");
			expect(brief).toContain("do not assume they pass");
			expect(brief).not.toContain("pass on the tree you are reviewing");
			expect(brief).not.toContain("Do not rerun");
		}
		for (const brief of [lens({ gates: [] }), recheck({ gates: [] })]) {
			expect(brief).toContain("No gates are configured");
			expect(brief).toContain("do not assume they pass");
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
		expect(instructions).toContain("P-2");
		expect(instructions).toContain("3 items, 1 ticked");
		expect(instructions).toContain("Start at P-2.2");
		expect(instructions).toContain("Validate");
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
		const continuation = Brief.continuation(subject.task, open);
		expect(continuation).toContain("P-2 is still open");
		expect(continuation).toContain("2 checklist items not ticked");
		expect(continuation).toContain("P-2.2, P-2.3");
		expect(continuation).toContain("Continue at P-2.2");
		expect(continuation).toContain("Validate");
		const [first, ...rest] = open;
		if (!first) throw new Error("no open item");
		const reopened = Brief.reopened(subject.task, [first, ...rest]);
		expect(reopened).toContain("kabane_done on P-2");
		expect(reopened).toContain("2 checklist items not ticked");
		expect(reopened).toContain("P-2.2, P-2.3");
		expect(reopened).toContain("reopened");
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
						expect(prompt).toContain("issue's brief");
						expect(prompt).toContain("branch");
						expect(prompt).toContain("worktree");
						expect(prompt).toContain("merge order");
						expect(prompt).toContain("who pushes");
						expect(prompt).toContain("landing automation");
						expect(prompt).toContain("this paragraph replaces it");
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
		expect(fixer).toContain("who pushes");
		expect(fixer).toContain("opens a PR");
		expect(fixer).toContain("landing automation");
		expect(fixer).toContain("this paragraph replaces it");
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
