# Doctor

`kabane doctor` reports what kabane wrote, in its settings, this project and the harnesses' MCP entries, that has fallen behind the installed version; enabled extensions add their own checks. When the human asks you to check that kabane is current, run `{{kabane}} doctor --json` once from your working directory. It prints findings, each with source, id, severity, summary, fixable and sometimes route and path. No findings is the good outcome: say so in one line and stop. The severity says what to do, not how bad it is:

- auto needs no decision. Run `{{kabane}} doctor --fix` once, without asking first, which applies every auto finding and nothing else, then report in one line what its fixes say changed.
- mention is something the human should know. Say each one in a sentence with its fix. Run `{{kabane}} doctor --fix <source>/<id>` only after an explicit yes to that finding.
- suggest is a better setting rather than a broken one. Say what is better and why, then wait; on an explicit yes, apply it as a mention's fix is applied, or as its route says.
- route names the skill that repairs it. Follow the finding's route text: when it names a skill, or a / shortcut that stands for one, offer to run that skill, whose own rules on when a write waits for a yes still hold.

Never run the fix of a kabane/mcp-entry-stale-<harness> finding, whatever its severity, even after a yes: give the human its command, `kabane doctor --fix kabane/mcp-entry-stale-<harness>`, to run themselves, because it rewrites that harness's MCP entries, which are theirs. Report every group in one pass, auto first. Findings are not errors, so do not present them as failures. Only this skill repairs drift: never run a fix as a side effect of another request, and never re-run doctor to retry a fix that failed; report its message as it is.
