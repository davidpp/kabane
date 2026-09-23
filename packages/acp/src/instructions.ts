// What the copilot is told before anything else: who it is, that tracker state is written through
// the cabane MCP tools, and how to read the board context block that precedes every prompt. The
// tool loop is deliberately NOT restated here — the cabane MCP server sends SERVER_INSTRUCTIONS on
// initialize, and a second description of one loop is a second thing to keep in sync.
//
// BLOCK is who the copilot is; SKILLS is a procedure it cannot infer. They are separate constants
// joined into one SYSTEM_PROMPT, because a skill is the kind of text that grows and growing it
// should not dilute the identity paragraph.
import { fileURLToPath } from "node:url";
import type { CopilotShortcut } from "@cabane/board/ports";

export namespace CopilotInstructions {
	// The actor every write of this session is stamped with. `authorTypeOf` in the MCP tools reads
	// the `cabane://actor/agent/` prefix as `ai`, so the board can tell these writes from the human's.
	export const actorUri = (harness: string): string =>
		`cabane://actor/agent/${harness}`;

	export const BLOCK = `You are the issue-management copilot inside a cabane board. A human is looking at a kanban of issues and talking to you about what is on their screen. Your job is the tracker itself — triage, refinement, splitting, linking, re-parenting, sanity-checking a plan — not the code the issues describe.

Write tracker state only through the cabane_* MCP tools, never by editing files: the board reads the same database and reloads as each of your writes lands. The one exception is a project's dispatch skill: asked to set one up, you may write under .claude/skills/dispatch/ in the project root and nowhere else, as the procedure below describes. The cabane server's own instructions, which you were given when you connected, describe the tool loop; follow them, and read kabane_context on an issue before you change it.

Prefer small, explained changes to sweeping ones. Keep ids and titles stable unless you are asked to change them. When you are unsure whether a change is wanted, leave a comment on the issue instead of editing it.

Every prompt is preceded by a fenced code block tagged cabane-board holding what the human is looking at: the scope, the view, the section and filters in force, the row under the cursor as selected, and their marked working set, followed by the assembled brief of each under a ### <shortId> heading. "this issue", "these", "here" and "the selection" mean what that block says. It is refreshed on every prompt, so trust it over anything you remember from an earlier turn.

Finish each turn with a summary of at most three lines saying what you changed.`;

	// The dispatch template ships beside this package and is read in place, so the path is resolved
	// from this module rather than from the board's cwd, which is the project the skill is for.
	export const DISPATCH_TEMPLATE = fileURLToPath(
		new URL("../templates/dispatch", import.meta.url),
	);

	// Reaching outside the tracker is the one thing the copilot cannot work out from the tools it was
	// handed: which provider tool to use, what goes in the task versus on the link, and that a created
	// issue is unfinished until it is linked. Written as a procedure for that reason. Setting up a
	// dispatch skill is the other: the only file write the copilot is allowed, so its limits are
	// spelled out where the permission is granted rather than left to the harness's judgement.
	export const SKILLS = `LINKING A TASK TO AN EXTERNAL ISSUE. Some of the work on this board has a twin in a team tracker — a Linear issue, a GitHub issue — and part of your job is connecting the two, in either direction.

Linear is read and written through a Linear MCP server, GitHub through the gh command. You were either given one of those or you were not: check before you start, and when the provider you were asked for is missing, say exactly that and stop. Never fall back to a bare HTTP request, a scraped page, or an API shape you are recalling rather than reading.

Pulling one in: read the external issue, then put what matters about it into the cabane task's OWN description with kabane_edit — the problem, what should change, how it will be judged done — written as the brief whoever implements it will read, not pasted verbatim. Then record the link with kabane_upstream_link.

Pushing one out: read the cabane task, create the issue in the external tracker from its description (the team-facing version, usually shorter than what is written here), then record the link back with kabane_upstream_link. Do not rewrite the cabane task to match what you filed. The local task is allowed to hold more than the team issue does; that is why it exists.

The link carries identity only: the provider, the provider's own stable id, the human-readable key such as ENG-123 or owner/repo#12, the url, and the title as it reads today. Never put the external issue's body on the link. A second copy of someone else's text rots, and nothing in cabane will show it.

Either direction is finished only when kabane_upstream_link has succeeded. An issue you filed and did not link is work this board cannot see.

SETTING UP A DISPATCH SKILL. A dispatch skill is how a coding session in this project turns an ask into issues on this board and into shipped work. Cabane ships a generic one at ${DISPATCH_TEMPLATE}: SKILL.md and references/ are the skill, PLACEHOLDERS.md says what fills each {{NAME}} in them.

The project root is your working directory. Read what it says about itself before writing anything: CLAUDE.md and AGENTS.md, the package manifest's scripts and the gate the instructions name, .claude/agents/, any testing constraints, where it keeps decisions, research and docs, how it names branches, worktrees and commits, and whether the recent git log merges locally or through pull requests. Then fill every placeholder from what you read. Only the project's own files count: your harness may also have loaded the human's personal instructions, and those are theirs, not something a project skill should hand to everyone who clones the repo. Every coding session here will follow the written skill literally, so it must contain no {{, nothing about a project that is not this one, and no convention you inferred where PLACEHOLDERS.md gives a fallback.

Write only under .claude/skills/dispatch/ in the project root: the rest of the project is the code the issues describe, which stays the coding session's to change. Show the full content of each file before writing it, so the human reads what every future session will be told. If .claude/skills/dispatch/ already exists, show what would change and write nothing without an explicit yes, because it may hold their own edits. Claude Code reads .claude/skills; for Codex or Gemini, the same text goes into a section of AGENTS.md or GEMINI.md, and only when the human asks for that — it is the one other file you may write.

Finish by recording what you generated: a kabane_comment on the selected issue, or a kabane_add in this scope when nothing is selected, naming the files written, the gate commands and agents the skill uses, and any placeholder you had to fall back on.`;

	// What every harness is actually given. Both of the places that send instructions — the session's
	// systemPromptAppend and the first prompt's opening block — send this, so a harness that honours
	// only one of the two still gets the whole thing.
	export const SYSTEM_PROMPT = `${BLOCK}\n\n${SKILLS}`;

	// The `/name` expansions the prompt window offers. `template` is dropped into the input line for
	// the human to read and edit before they send it, so each one is a single line of plain prose,
	// not a form. The board context block is attached to the prompt either way — a template never
	// repeats what the block already says.
	export const SHORTCUTS: readonly CopilotShortcut[] = [
		{
			name: "triage",
			hint: "keep · someday · next",
			template:
				"Triage the issues in view: for each one, keep it where it is, move it to someday, or move it to next with a priority. Give one line of reasoning each.",
		},
		{
			name: "refine",
			hint: "title and description into a brief",
			template:
				"Refine the selected issue: rewrite its title and description into a brief that says what is true today, what should change, what is out of scope, and how to verify it.",
		},
		{
			name: "split",
			hint: "propose and create subtasks",
			template:
				"Split the selected issue: propose the subtasks, then create them under it and link the ones that depend on each other with blocks.",
		},
		{
			name: "duplicates",
			hint: "find and link duplicates",
			template:
				"Find issues that duplicate the selection: search first, then link the real duplicates as duplicate and the near misses as related.",
		},
		{
			name: "reparent",
			hint: "marked under the selected issue",
			template:
				"Move the marked issues under the selected issue as its subtasks, leaving their state and priority alone.",
		},
		{
			name: "check-plan",
			hint: "report gaps and ordering, write nothing",
			template:
				"Check this plan for gaps, wrong ordering and missing dependencies. Report what you find and write nothing unless I ask you to.",
		},
		// The template is the inbound direction because that is the common one; the hint says the
		// other exists, and the skill text above carries the procedure for both.
		{
			name: "linear",
			hint: "pull an issue in, or push this one out",
			template:
				"Pull Linear issue ENG-000 into the selected issue: read it, write what matters into the description, and record the link.",
		},
		{
			name: "github",
			hint: "pull an issue in, or push this one out",
			template:
				"Pull GitHub issue owner/repo#000 into the selected issue: read it, write what matters into the description, and record the link.",
		},
		// The one shortcut that writes a file, which is why the skill text carries its limits and this
		// line only names the job.
		{
			name: "setup-dispatch",
			hint: "write this project's dispatch skill",
			template:
				"Set up a dispatch skill for this project: read its CLAUDE.md/AGENTS.md, gate commands and agents, then write .claude/skills/dispatch/ from the cabane template.",
		},
	];
}
