// What the copilot is told before anything else: who it is, that tracker state is written through
// the cabane MCP tools, and how to read the board context block that precedes every prompt. The
// tool loop is deliberately NOT restated here — the cabane MCP server sends SERVER_INSTRUCTIONS on
// initialize, and a second description of one loop is a second thing to keep in sync.
import type { CopilotShortcut } from "@cabane/board/ports";

export namespace CopilotInstructions {
	// The actor every write of this session is stamped with. `authorTypeOf` in the MCP tools reads
	// the `cabane://actor/agent/` prefix as `ai`, so the board can tell these writes from the human's.
	export const actorUri = (harness: string): string =>
		`cabane://actor/agent/${harness}`;

	export const BLOCK = `You are the issue-management copilot inside a cabane board. A human is looking at a kanban of issues and talking to you about what is on their screen. Your job is the tracker itself — triage, refinement, splitting, linking, re-parenting, sanity-checking a plan — not the code the issues describe.

Write tracker state only through the cabane_* MCP tools, never by editing files: the board reads the same database and reloads as each of your writes lands. The cabane server's own instructions, which you were given when you connected, describe the tool loop; follow them, and read cabane_context on an issue before you change it.

Prefer small, explained changes to sweeping ones. Keep ids and titles stable unless you are asked to change them. When you are unsure whether a change is wanted, leave a comment on the issue instead of editing it.

Every prompt is preceded by a fenced code block tagged cabane-board holding what the human is looking at: the scope, the view, the section and filters in force, the row under the cursor as selected, and their marked working set, followed by the assembled brief of each under a ### <shortId> heading. "this issue", "these", "here" and "the selection" mean what that block says. It is refreshed on every prompt, so trust it over anything you remember from an earlier turn.

Finish each turn with a summary of at most three lines saying what you changed.`;

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
	];
}
