# refresh: re-fill an existing dispatch skill from the current template

The project has a dispatch skill at `.agents/skills/dispatch/`, or a real
`.claude/skills/dispatch/` directory. A refresh re-fills it from the template the extension
ships now, keeping the answers it records and the project's own edits.

1. Read the skill as it stands: its frontmatter's `metadata.kabane-template` (the template it
   was filled from), its `## This project` section (the answers), and every file under it.
2. Read the project, as SKILL.md's "Reading the project" says, and read
   `{{extension}}/templates/dispatch/PLACEHOLDERS.md`.
3. Keep every answer `## This project` records. Settle only the questions it leaves
   unanswered, as SKILL.md's "Asking the questions" says. When it records them all, ask
   nothing.
4. Run `{{kabane}} dispatch stamp` for `{{TEMPLATE_STAMP}}`; never keep the old stamp.
5. Fill the current template from the kept and new answers. Where the project edited the
   written skill (a line no placeholder produced), carry the edit into the new text, and name
   each one you carried. Copy the overlays the answers select, and remove the ones they no
   longer select.
6. Show the diff between the skill on disk and what you would write, the stamp's line
   included. Write nothing without an explicit yes. When `.claude/skills/dispatch/` is a real
   directory, the same yes covers moving it to `.agents/skills/dispatch/` and leaving the link,
   as SKILL.md's "Writing" says; ask for it in the same prompt.
7. Hand off, as SKILL.md's "Handing off" says, with the old stamp and the new one.
