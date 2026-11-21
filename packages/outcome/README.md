# @kabane/outcome

Session outcomes kept on an issue's timeline. The module declares four entry kinds, each
rendered in the brief's Discussion by core:

| Kind | Title | Template |
|---|---|---|
| `outcome.decision` | Decision | The question that was asked, then → and the choice, and who chose. |
| `outcome.finding` | Finding | What was found and where, with its severity (P1, P2 or P3) when it has one. |
| `outcome.verification` | Verification | What was checked, how, and what it showed. |
| `outcome.summary` | Session summary | The session's final message: what it did and where it stopped. |

Register `outcomeModule` with `Runtime.configure`. The CLI and hub register it after
`handoffModule`. It has no tables, migrations, tools or section renderer: outcomes are
ordinary entries in core's replicated timeline. Write one with `kabane_comment`, giving its
`kind`, or with `Planner.addEntry`. Templates guide the body without validating its prose.
The `handoff` kind remains in `@kabane/handoff`.

Exports: `outcomeModule` and `OUTCOME_KINDS`, an object with `decision`, `finding`,
`verification` and `summary` keys containing those kind names.
