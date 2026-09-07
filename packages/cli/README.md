# cabane

The command line for one device of the tracker. Every command is a thin
argument parser over `@cabane/core` with the `bun:sqlite` adapter; the database
is authoritative on this machine and `cabane sync` converges it with the others.

```bash
bun link            # from packages/cli, once; then `cabane` is on PATH
cabane init
cabane add "Write the deploy runbook" --kind issue --assignee claude --scope cabane
cabane list
```

## Home and config

`CABANE_HOME` (default `~/.cabane`) holds `config.json` and `cabane.db`, with
plain table names.

```json
{
  "actor": "cabane://actor/human/david",
  "deviceId": "mbp",
  "sync": {
    "enabled": true, "url": "https://cabane.3pew.ca", "token": "…", "deviceId": "mbp", "batchBytes": 262144,
    "headers": { "CF-Access-Client-Id": "…", "CF-Access-Client-Secret": "…" }
  }
}
```

- **actor** is stamped on what this device writes: task provenance, comment
  author, work-log author. Override per call with `--as <actor-uri>`. Actors
  under `cabane://actor/agent/` comment as `ai`, everything else as `human`.
- **deviceId** seeds the sync identity on the first push and is write-once
  after that.
- **sync** is the block `@cabane/core`'s `SyncDevice.connect` reads. Sync is
  enabled when `init` is given both `--sync-url` and `--sync-token`. `headers`
  are sent on every push and pull: the hub sits behind Cloudflare Access, so a
  device carries its Access service-token credentials here, separate from the
  log's bearer `token`. `init --access-client-id <id> --access-client-secret
  <secret>` writes them as `CF-Access-Client-Id` / `CF-Access-Client-Secret`;
  both or neither.
- **db** (optional) points the CLI at another SQLite file and table prefix
  instead of `CABANE_HOME/cabane.db` with plain names. `path` is absolute or
  `~`-expanded; `tablePrefix` defaults to empty. This is how a Jake user opens
  the tracker Jake already keeps, with zero migration and no sync between the
  two hosts, because it is the same file:

  ```json
  { "actor": "cabane://actor/human/david", "deviceId": "mbp",
    "sync": { "enabled": false, "batchBytes": 262144 },
    "db": { "path": "~/.jake/jake.db", "tablePrefix": "planner_" } }
  ```

  `cabane init --db-path ~/.jake/jake.db --table-prefix planner_` writes that
  block. Both hosts run the same `@cabane/core`, so the schema apply on open is
  the same idempotent one Jake runs at boot. Leave `sync` disabled in this
  shape: Jake already syncs that file as its own device, and `cabane sync`
  warns when `db.path` and sync are both set.

## Scope

`scopeUri` is a string the tracker never resolves. It comes from `--scope`,
else from `./.cabane/scope` in the current directory (one line, e.g. `cabane`),
else nothing. `cabane init --scope <uri>` writes that file for you. Bare ids normalize to `jake://scope/<id>`. Git resolution is a
host concern (Jake does it); the CLI does not.

## Output and exit codes

Human text by default, `--json` on any command for the structured value. Exit
codes: `0` ok, `1` error, `2` usage. Errors go to stderr.

## Commands

| Command | Flags |
|---|---|
| `init` | `--actor <uri>` `--device <id>` `--sync-url <url>` `--sync-token <token>` `--access-client-id <id>` `--access-client-secret <secret>` (together; Access service token sent as headers on every push and pull) `--db-path <file>` `--table-prefix <prefix>` (open another database, e.g. Jake's `~/.jake/jake.db` with `planner_`) `--scope <uri>` (writes `./.cabane/scope`) `--force` |
| `add "<title>"` | `--kind task\|issue` `--state <s>` `--priority urgent\|high\|normal\|low` `--scope <uri>` `--assignee <who>` `--parent <id>` `--description <text>` `--tags a,b` `--due YYYY-MM-DD` |
| `list` | `--state <s>` `--kind` `--priority` `--assignee` `--scope` `--tag` `--all` (include done and cancelled) `--limit <n>` |
| `show <id>` | task, links, comments, work log; `--json` also carries `updatedBy` (actor URI of the last writer) and `version` |
| `edit <id>` | `--title` `--description` `--state` `--priority` `--kind` `--assignee <who>\|none` `--scope` `--parent <id>\|none` `--tags` `--due` |
| `done <id>` | |
| `search <query>` | `--state` `--scope` `--limit` |
| `link <src> <dst>` | `--type blocks\|blocked_by\|parent\|child\|related\|duplicate\|follows` `--note` |
| `comment <id> "<text>"` | `--as <actor>` |
| `log <id>` | `--ref <type:value>` (repeatable) `--commit <sha>` `--branch <name>` `--pr <owner/repo#n>` `--url` `--session` `--file` `--note` |
| `context <id>` | `--no-deref` `--no-subtasks` — the assembled brief, the read entrypoint for agents |
| `sync [status\|push\|pull\|backfill]` | `backfill` seeds the log with rows that existed before sync was armed, then pushes |
| `board` | `--scope <uri>` — the terminal kanban (`@cabane/board`) on this device, no activity feed or dispatcher; those are host ports |
| `mcp` | `--as <actor>` — serve this device over MCP on stdio; the hub's tool list (`cabane_*`), with `./.cabane/scope` as the default scope so writes may omit `scopeUri` |

Ids are short ids (`JCAB-12`) or ULIDs. Short ids are labels, not identities:
two devices can mint the same one offline, and `sync pull` relabels the later
one (`sync status` counts `renamed ids`).

## MCP on this device

```bash
claude mcp add cabane -- cabane mcp --as cabane://actor/agent/claude
```

Same tools as the hub at `https://cabane.3pew.ca/mcp`: `cabane_scopeList`,
`cabane_add`, `cabane_get`, `cabane_list`, `cabane_search`, `cabane_today`,
`cabane_context`, `cabane_edit`, `cabane_done`, `cabane_link`,
`cabane_comment`, `cabane_log`, `cabane_contextAdd`, `cabane_contextList`,
`cabane_contextRemove`. The one difference: here a write may omit `scopeUri`
and take the directory default; at the hub it is required. Stdout is the wire,
so the command prints nothing of its own.

## Layout

```
index.ts            bin shim
src/main.ts         command table, help, exit codes
src/args.ts         pure argv parser
src/config.ts       CABANE_HOME, config.json, directory scope
src/context.ts      Runtime.configure + Planner.init, the Ctx commands receive
src/output.ts       --json vs human rendering, icons
src/commands/*.ts   one file per command
cli.test.ts         scripted session against the real binary
```

## Verified

`cli.test.ts` drives every command through the binary. Two devices were
converged by hand through a local `wrangler dev` of the sync log: concurrent
offline creates on both devices, the short-id rename on pull, and `backfill`
from a device that had rows before sync was enabled.
