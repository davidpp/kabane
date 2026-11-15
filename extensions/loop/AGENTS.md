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
| `src/activity.ts`, `src/dispatcher.ts`, `src/header.tsx` | what the board shows of a run |

## It is an extension, so it takes types from kabane and values only from its harness client

Its layer is `extension`; its entry in `scripts/layers.ts` (`"@cabane/loop"`) allows one
runtime dependency, `@cabane/acp`, the harness client it bundles. It also lists
`@cabane/board`, `checklist`, `core` and `extension`, and imports values from them in about
thirty files; each is a named exception that JCAB-326 removes by porting the loop onto
extension API v1 (`ARCHITECTURE.md`, "Extension API v1"). Until then, every new value import
from one of those four adds to JCAB-326's work: take what you need through an existing import
of the same module, or say in your handoff why it could not wait.

Several issues change this package; check main before you edit:

- In flight now: JCAB-275 (MCP tools and instructions through an `mcp` field), JCAB-263
  (a `doctor` check, on its own branch).
- JCAB-326 ports the loop: values arrive on `host`, `src/header.tsx` becomes header data the
  board lays out, core's `lint/` moves in (`src/advice.ts`, `src/commands.ts` use it), and the
  loop leaves the CLI's bundle.
- JCAB-324 moves the copilot's loop procedure and shortcut into files in this extension.

Read before writing: `src/extension.ts`, `src/store.ts`, and the entry point you are changing
in `src/commands.ts` with its test.

## Verify

```bash
bun test extensions/loop                  # runner tests drive packages/acp/scripts/scripted-agent.ts
bun run sandbox config set extensions loop --layer global
bun run sandbox add "try the loop" --kind issue
bun run sandbox loop advise <id>          # the plan, the advice and the routing; changes nothing
bun run sandbox loop status
```

`loop advise` with `--dir` pointing at a checkout reads that checkout's lenses and gates. A
real `loop start` opens sessions on the harness the human is logged in to and spends its quota,
so run one only when the brief allows it; otherwise list it as a manual check. The run's tab on
the board is checked under tmux with `bun run sandbox board`.

## Mistakes that are easy to make here

- Answering a harness's permission request, or adding an allow list, a settings file or a
  model the run did not name. The loop is a thin wrapper: a request becomes a question for the
  human (`src/permission.ts`).
- Keeping run state in the tracker. Runs live in files; the tracker gets work-log refs,
  comments and child issues for findings.
- Writing `run.json` in place. The runner replaces it by rename so a reader never sees half a
  file (`src/store.ts`).
- Base kabane text that names the loop (the copilot's instructions, the board's setup, help).
  What the loop needs said goes in the loop.
