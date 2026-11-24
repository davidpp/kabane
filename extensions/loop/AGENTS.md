# @kabane/loop (extensions/loop)

The first extension: `kabane loop` drives an issue, or a parent's subtasks, through coding
harnesses from a detached runner, runs the project's gates and verifier lenses, and lands the
branch. `docs/loop.md` is what a user reads; read the part your change touches.

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

## Mistakes that are easy to make here

- Writing `run.json`, `events.jsonl` or `questions.jsonl` from outside the runner while a run is
  live. The runner owns them; anyone else appends a request to `inbox.jsonl`. The rename that
  replaces `run.json` keeps a reader from seeing half a file, not two writers apart.
- Answering a harness's permission request, or adding an allow list, a settings file or a
  model the run did not name. A request becomes a question for the human
  (`src/permission.ts`).
- Base kabane text that names the loop (the copilot's instructions, the board's setup, help).
  What the loop needs said goes in the loop.
