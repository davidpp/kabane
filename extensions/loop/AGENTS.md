# @cabane/loop (extensions/loop)

The first extension: `kabane loop` drives an issue, or a parent's subtasks, through coding
harnesses from a detached runner, runs the project's gates and verifier lenses, and lands the
branch. `docs/loop.md` is what a user reads; read the part your change touches.

| Where | What it holds |
|---|---|
| `src/extension.ts` | the `Extension` object: the one `loop` command, its settings and the board ports |
| `src/commands.ts` | `Loop`, every entry point (`start`, `run`, `status`, `stop`, `advise`, `land`, ...) |
| `src/runner.ts`, `src/scheduler.ts`, `src/claims.ts`, `src/dispatch.ts` | the detached runner, what it claims, one ACP session per claim |
| `src/store.ts` | run state as files under `$KABANE_HOME/loops/<runId>/`, never in the tracker |
| `src/gates.ts`, `src/lenses.ts`, `src/review.ts`, `src/fixer.ts` | the closing checks, review and the fixer |
| `src/land.ts`, `src/worktree.ts`, `src/trees.ts` | branches, worktrees and landing |
| `src/doctor.ts` | the loop's `kabane doctor` checks: legacy and shadowed lenses, `loop.model` and `loop.tiers` |
| `src/activity.ts`, `src/dispatcher.ts`, `src/header.ts` | what the board shows of a run; the header returns toned lines, with no React or OpenTUI |

## It takes types from kabane, and values only from the harness client it bundles

Its layer is `extension`; its entry in `scripts/layers.ts` (`"@cabane/loop"`) allows one
runtime dependency, `@cabane/acp`. Its other `@cabane/*` dependencies are named exceptions
that JCAB-326 removes by porting the loop onto extension API v1 (`ARCHITECTURE.md`, "Extension
API v1"). Until then, every value newly used from `@cabane/core`, `checklist` or
`extension` is new dependence on kabane's internals that JCAB-326 must then undo, whichever
import line it sits on. Use one only when the brief asks for it, and name it in the handoff.
Activity, dispatch and header types come from `@cabane/extension`; forms and `FormField`
come from `@cabane/acp`. The loop has no dependency on the board.

The activity port reads questions with `Planner.getNeedsInput` and `parseQuestionBody` from
`@cabane/core`, assigning each its run card id and claim lane. These new core uses are a
JCAB-329 stopgap removed by JCAB-340. Answers go through `Loop.answer`, which records the
answer and the answering actor's inbox note; the board no longer writes the answer itself.

Several issues change this package; check main before you edit:

- JCAB-326 ports the loop: values arrive on `host`, and the loop leaves the CLI's bundle. Plan
  lint now lives in `src/lint/` (JCAB-338); `src/advice.ts` and `src/commands.ts` use it.
- JCAB-324 moves the copilot's loop procedure and shortcut into files in this extension.

Read before writing: `src/extension.ts`, `src/store.ts`, and the entry point you are changing
in `src/commands.ts` with its test.

## Verify

```bash
bun test extensions/loop                  # runner tests drive packages/acp/scripts/scripted-agent.ts
bun run sandbox init                      # once per fresh sandbox
bun run sandbox config set extensions loop --layer global
bun run sandbox add "try the loop" --kind issue
bun run sandbox loop advise <id>          # the plan, the advice and the routing; changes no issue, run or setting
bun run sandbox loop status
```

`loop advise --dir <checkout>` reads that checkout's lenses and gates. A real `loop start`
opens sessions on the harness the human is logged in to and spends its quota, so run one only
when the brief allows it; otherwise list it as a manual check.

To drive a whole run with no quota spent, start it with `--scripted` on every sandbox call.
The flag writes `loop.harnesses.<id>` for every harness into the sandbox's global layer, so
each session launches `packages/acp/scripts/scripted-agent.ts`: an implementer commits one
file and calls `kabane_done` through the run's MCP server, the triage groups the lenses, and
a lens files nothing. A sandbox call without the flag takes the setting out again, so a
`loop start` without it is a real run.

```bash
bun run sandbox --fresh --scripted config set extensions loop --layer global
bun run sandbox --scripted add "parent" --kind issue                     # say JGIT-1
bun run sandbox --scripted add "one" --kind issue --state next --parent JGIT-1
bun run sandbox --scripted add "two" --kind issue --state next --parent JGIT-1
bun run sandbox --scripted loop advise JGIT-1     # each harness "launches .../scripted-agent.ts"
bun run sandbox --scripted loop start JGIT-1 --lens functional --lens quality --gate ok=true
bun run sandbox --scripted loop status <runId>    # until completed; events.jsonl's launch events name the command
bun run sandbox show JGIT-1                       # the run's comment and its loop: work-log ref
```

Commit the sandbox repo's seed files first, before adding the issues (the scope id, and so the
issue prefix, changes with the first commit): `seedRepo` leaves them untracked, and `loop start`
fails on git in a repository with no commit to cut the run's worktree from. The repo is the
path the sandbox prints on every call: `git -C <repo> add -A && git -C <repo> commit -m seed`.

## Mistakes that are easy to make here

- Writing `run.json` or `events.jsonl` from outside the runner while a run is live. The runner
  owns both; anyone else appends a request to `inbox.jsonl` (`src/store.ts:8`). The rename that
  replaces `run.json` keeps a reader from seeing half a file, not two writers apart.
- Answering a harness's permission request, or adding an allow list, a settings file or a
  model the run did not name. A request becomes a question for the human
  (`src/permission.ts`).
- Base kabane text that names the loop (the copilot's instructions, the board's setup, help).
  What the loop needs said goes in the loop.
