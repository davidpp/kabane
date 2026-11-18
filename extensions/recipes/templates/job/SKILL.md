---
name: job
description: Create, change, pause, resume or fire a kabane job, a standing request a schedule runs in a project's folder, with the `kabane job` CLI. Use when the user says "make a job", "schedule this", "every morning run…", "every weekday at 9…", "change job X", "pause that job", "run that job now", or asks what jobs exist, from any folder.
---

# Job

A kabane job runs a request, or a project's recipe, on a schedule, in a project's folder, in a
background terminal: each fire starts a harness there and gives it the job. It is an item of kind
`job` plus its schedule, made and changed only with the `kabane job` CLI; there is no MCP tool for
it. This skill turns one prompt from the human into the right `kabane job` command and reports what
it made. If `kabane job` is not a command here (`kabane job --help` says it is unknown), the recipes
extension is not enabled: say so, give `kabane config set extensions recipes --layer global` (with
the extensions already listed by `kabane config get extensions`), and stop.

## Make a job

1. **The folder.** The job runs in a project's folder. Take the folder the human named, or else this
   session's working directory. Check it with `kabane scope` run in that folder: it prints the
   project's name, scope and root, or `No project scope`. Use the root it prints, as an absolute
   path. When the folder is in no project, ask the human which project's folder the job belongs to;
   do not create a project.
2. **What it runs.** Either a free request or a recipe.
   - A free request: the human's words, rewritten as the instruction the agent reads at each fire
     (what to do, where to write the result). It goes in `--request`, and is the job's
     description; there is no recipe.
   - A recipe: when the human names one, or the request is plainly what one of the project's
     recipes does. `kabane run`, run in the project's folder, lists them with their inputs. Only a
     recipe whose line says `--target <job>`, or names no target, can be a job's. Its inputs go in
     `--input name=value`, one per input; a required input with no default must be given, and is
     never asked for at fire time. `--request` is optional with a recipe: it is the standing
     request the run reads on the job.
3. **The schedule.** `--schedule` is a cron expression, `minute hour day month weekday`, or a
   nickname such as `@daily`, read in this machine's time zone (`date +%Z`). "Every weekday at 9"
   is `0 9 * * 1-5`; "every morning" with no hour is ambiguous: ask. Quote it.
4. **The title.** `--title`: a few words that name the job, written as what it does.
5. **The harness.** Only when the human named one: `--harness` takes the command as a
   comma-separated list, `--harness codex` or `--harness claude,--model,opus`. Otherwise leave it
   out; the recipe's harness, then `recipes.harness`, then `claude` applies.
6. **The session.** `--session keep` when the human wants one conversation that remembers earlier
   fires; otherwise leave it out, and each fire starts a fresh session.
7. **The check.** Only when the human says to run "only when …", "only if there is …", or "skip
   it when …": `--check "<shell>"`, a command that exits 0 when the job has something to do, run
   with `sh -c` in the project's folder before each scheduled fire. A nonzero exit skips that
   fire. Write it as the condition, `test -s inbox.md`, and check it by running it in that folder
   before you add the job. `kabane job run` ignores it.

Then run it, from any folder:

```bash
kabane job add --title "Check the build" --schedule "0 9 * * 1-5" \
  --request "Check the latest build and comment on the job what broke" \
  --project /absolute/path/to/project
kabane job add <recipe> --title "<title>" --schedule "<cron>" \
  --input name=value --project /absolute/path/to/project
```

It prints `Added job <id> (…); it fires next at <time>.` Run `kabane job show <id>` and tell the
human, in one or two lines: the job's id and title, when it fires next, the folder, and the harness
the `harness` line names. When `job add` fails, its error says which flag is wrong: fix that flag
and run it again, and ask the human only when the fix needs their choice.

Ask the human only for what the prompt leaves open and has no default: the time of day, which
project when the folder is in none, a required recipe input. Never ask for the harness, the
session, the check or the title.

## Change a job

Find it with `kabane job list --all`: its id, state, schedule, next fire, recipe, session, last
run, title and harness, for every project. When more than one job could be the one the human
means, ask which, with their ids and titles.

- `kabane job edit <id>` with only the flags to change: `--title`, `--request`, `--schedule`,
  `--harness` (`--harness none` drops the job's own command), `--session fresh|keep`, `--check
  "<shell>"` (`--check none` drops it), and with a
  recipe, `--input name=value` (sets one) or `--inputs '{"name": value}'` (replaces them all). It
  prints what changed and the next fire. A job's project does not change: to move one, close it
  with `kabane done <id>` and add it again in the new folder.
- `kabane job pause <id>` stops its fires; `kabane job resume <id>` starts them again.
- `kabane job run <id>` fires it now.
- `kabane done <id>` ends it; there is no delete.

After any of these, `kabane job show <id>`, and tell the human its state and next fire in one line.

## What this skill does not do

It does not write recipes, edit the scheduler that calls `kabane job tick`, or answer a running
job's session (`kabane runs attach <run id>` opens it). It runs no flag the commands above do not
list.
