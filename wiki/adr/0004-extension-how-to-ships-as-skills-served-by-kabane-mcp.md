# 0004: An extension ships how-to as skills that `kabane mcp` serves through two tools, and the copilot's instructions carry only state, identity and boundaries

- Status: accepted
- Date: 2026-11-19
- Issue: JCAB-586 (slice 1 of JCAB-585)
- Decided by: David, on JCAB-585 (2026-11-19: MCP tools over user-level install and MCP prompts,
  questions 1-4 withdrawn in their favour; question 5: base kabane's own how-to moves last)

## Context

Every copilot session receives every enabled extension's procedures in its instructions, used or
not: with dispatch and loop enabled, 1,615 words of `copilot/procedures/*.md` after base kabane's
1,312-word `SKILLS`, ahead of the per-prompt `kabane-board` block (`systemPrompt` in
`packages/board/src/copilot-instructions.ts`). The rule behind it was `ARCHITECTURE.md`'s
"Procedures and shortcuts are markdown files". David also wants to run the same how-to, such as
the dispatch setup, from a plain Claude Code or Codex session that is not the board's copilot.

Constraints: base kabane text names no extension; kabane adds no permission policy and edits no
harness configuration; a value the host cannot know comes from a command the extension
contributes (`kabane dispatch stamp`, JCAB-327). The full research, with per-harness evidence, is
JCAB-585's Finding.

## Decision

1. **How-to ships as skills in the extension's directory**, in the Agent Skills format:
   `skills/<name>/SKILL.md` plus `references/`. It is a file convention the CLI host implements,
   as `copilot/` is, and adds no field to the extension contract (`packages/extension/contract.ts`).
2. **`kabane mcp` serves them through two tools**, as PostHog's MCP server serves its skills
   store: `kabane_skillList` (name, description, owning extension) and
   `kabane_skillGet { name, file? }` (the file's text and the manifest of the skill's other
   files). The tools are device-only: the hub loads no extensions.
3. **On a get, the host fills two placeholders**: `{{extension}}`, the extension's directory, and
   `{{kabane}}`, the executable and `KABANE_HOME` this server runs. A skill finds its template and
   runs the same kabane as the session's server with no command per value. A value the host cannot
   know still comes from a command the extension contributes.
4. **The copilot's instructions carry only what code alone knows**: the `kabane-board` block,
   `setup()`'s machine context, the copilot's identity and its write boundaries. How to do a task
   is fetched when the task comes up.

## Consequences

- Any session connected to kabane's MCP server (the copilot, Claude Code, Codex, Pi) lists and
  runs the same skills with nothing installed and no copy to go stale.
- Skills lose automatic triggering by description; David accepted it, because setup work runs
  rarely or when asked. The server instructions and the board's `/` shortcuts name the skills.
  `copilot/shortcuts/` stays for that reason.
- A skill states its own write boundary in its text, since it may run outside the board; the
  human's harness permissions apply on top.
- `copilot/procedures/` keeps working until the dispatch and loop procedures have moved, then the
  mechanism goes (JCAB-585's later slices). Base kabane's `SKILLS` moves last, and `BLOCK` keeps
  its write boundaries.
- Undecided: whether Codex and Pi show MCP server instructions to the model, which decides how far
  the one line naming the tools reaches.

## Alternatives rejected

- MCP prompts: Codex lists none (openai/codex#5059), Pi exposes only tools and resources, and a
  prompt is one message, with no progressive disclosure of `references/`.
- User-level install, as recipes installs `job`: one copy per harness skill directory, a doctor
  fix before first use, and stale copies after an upgrade. Recipes' `job` stays installed because
  it must trigger on its own ("schedule this").
- The draft MCP Skills extension's resources (SEP-2640): not settled, and Codex's resource support
  is unchecked; tools reach every harness today.
- Keeping procedures in the copilot's instructions: every session pays for every procedure, and no
  session other than the board's copilot can run one.
