# @cabane/loop (extensions/loop)

The first extension: `kabane loop` drives an issue, or a parent's subtasks, through coding
harnesses from a detached runner, runs the project's gates and verifier lenses, and lands the
branch. `docs/loop.md` is what a user reads; read the part your change touches.

| Where | What it holds |
|---|---|
| `src/extension.ts` | the `(host) => Extension` factory: the one `loop` command, its settings and the board ports |
| `src/commands.ts` | `Loop`, every entry point (`start`, `run`, `status`, `stop`, `advise`, `land`, ...) |
| `src/runner.ts`, `src/scheduler.ts`, `src/claims.ts`, `src/dispatch.ts` | the detached runner, what it claims, one ACP session per claim |
| `src/store.ts` | run state as files under `$KABANE_HOME/loops/<runId>/`, never in the tracker |
| `src/gates.ts`, `src/lenses.ts`, `src/review.ts`, `src/fixer.ts` | the closing checks, review and the fixer |
| `src/land.ts`, `src/worktree.ts`, `src/trees.ts` | branches, worktrees and landing |
| `src/doctor.ts` | the loop's `kabane doctor` checks: legacy and shadowed lenses, `loop.model` and `loop.tiers` |
| `src/activity.ts`, `src/dispatcher.ts`, `src/header.ts` | what the board shows of a run; the header returns toned lines, with no React or OpenTUI |

## It takes types from kabane, and values only from the harness client it bundles

Its layer is `extension`; its entry in `scripts/layers.ts` (`"@cabane/loop"`) allows one
runtime dependency, `@cabane/acp`. Record calls, scope detection, the executable, settings
schemas and tool definitions arrive through `host`; the factory binds its stateless result
helpers through `src/result.ts` before constructing anything else. Thread the host or its
record through dependencies, never create a home or a global host. The loop parses checklist
results from `host.record.call("kabane_checklist", ...)` with `host.z`.
Production imports from `@cabane/core` are type-only; `src/test-host.ts` binds real host
values for tests. Core and contract are development dependencies: the layer check allows
only type imports from them in production files.
Command entry points resolve case-insensitive short ids and unique ULID prefixes through
`host.record.get`; an ambiguous prefix is an error, while an absent task is `null`.
Activity, dispatch and header types come from `@cabane/extension`; forms and `FormField`
come from `@cabane/acp/form-field`. Runtime imports use ACP capability subpaths, never
its root barrel: the bundle includes the harness client and core's `result.ts` helpers,
but no other core source, ACP instructions or templates. The build test checks emitted
metafile inputs. The loop has no dependency on the board.

The activity port reads the run store's `questions.jsonl`, assigning each question its run card
id and claim lane. `Loop.answer` submits the human's answer and actor through `inbox.jsonl`;
the runner records the answer in the question journal before returning it to the harness.
Question-body parsing belongs to the loop. Claims in `run.json` hold session lifecycle, and
`events.jsonl` holds the session stream. The runner writes summaries and non-permission
decisions through `host.record.comment` as `outcome.summary` and `outcome.decision`; session
URIs reach the issue through `host.record.log`. Old run stores with no question journal still
load; questions held in core's old session tables are not read (migration is JCAB-343).

Several issues change this package; check main before you edit:

- The loop builds independently with `bun run --cwd extensions/loop build`. Its `dist/` is a
  directory extension with its harness client, copilot procedures and lenses included. Plan
  lint lives in `src/lint/` (JCAB-338); `src/advice.ts` and `src/commands.ts` use it.
- The copilot's loop procedures are files in `copilot/procedures/`, which the host reads only
  when the loop loads from a directory (`packages/board/README.md`, the copilot's instructions).

Read before writing: `src/extension.ts`, `src/store.ts`, and the entry point you are changing
in `src/commands.ts` with its test.

## Verify

```bash
bun test extensions/loop                  # runner tests drive packages/acp/scripts/scripted-agent.ts
bun run --cwd extensions/loop build        # dist/ is installed as a directory extension
bun run sandbox init                      # once per fresh sandbox
bun run sandbox config set extensions loop --layer global
bun run sandbox add "try the loop" --kind issue
bun run sandbox loop advise <id>          # the plan, the advice and the routing; changes no issue, run or setting
bun run sandbox loop status
```

`bun run sandbox` links this source extension into its disposable home when no loop directory
is installed there. The sandbox prints its repository path; its home is the adjacent `.kabane`.

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

- Writing `run.json`, `events.jsonl` or `questions.jsonl` from outside the runner while a run is
  live. The runner owns them; anyone else appends a request to `inbox.jsonl`. The rename that
  replaces `run.json` keeps a reader from seeing half a file, not two writers apart.
- Answering a harness's permission request, or adding an allow list, a settings file or a
  model the run did not name. A request becomes a question for the human
  (`src/permission.ts`).
- Base kabane text that names the loop (the copilot's instructions, the board's setup, help).
  What the loop needs said goes in the loop.
