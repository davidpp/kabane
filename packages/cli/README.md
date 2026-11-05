# kabane

The command line for one device of the tracker. Every command is a thin
argument parser over `@cabane/core` with the `bun:sqlite` adapter; the database
is authoritative on this machine and `kabane sync` converges it with the others.

```bash
bun link            # from packages/cli, once; then `kabane` is on PATH
kabane              # first run: the setup screen, then the board
```

Bare `kabane` in a terminal opens the board. On a device with no
`config.json` it first shows a setup screen: your name (the actor slug,
`cabane://actor/human/<name>`), the device id, the detected coding harnesses
to register `kabane mcp` in, and, inside a git repo, whether to pin its scope.
It writes the same config `kabane init` would, local SQLite and no sync, and
never replaces one that exists. Piped or run by an agent, bare `kabane` prints
help as before. The flag form stays for scripts and for sync:

```bash
kabane init --actor cabane://actor/human/<you> --device <machine> [--sync-url … --sync-token …]
kabane add "Write the deploy runbook" --kind issue --assignee claude --scope myapp
kabane list
```

## Home and config

`KABANE_HOME` (default `~/.kabane`) holds `config.json` and `kabane.db`, with
plain table names.

```json
{
  "actor": "cabane://actor/human/alex",
  "deviceId": "mbp",
  "sync": {
    "enabled": true, "url": "https://hub.example.com", "token": "…", "deviceId": "mbp", "batchBytes": 262144,
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
  instead of `KABANE_HOME/kabane.db` with plain names. `path` is absolute or
  `~`-expanded; `tablePrefix` defaults to empty. This is how a host app that
  embeds `@cabane/core` shares its database with the CLI, with zero migration
  and no sync between the two hosts, because it is the same file. Jake, the
  planner the CLI was extracted from, is one such host:

  ```json
  { "actor": "cabane://actor/human/alex", "deviceId": "mbp",
    "sync": { "enabled": false, "batchBytes": 262144 },
    "db": { "path": "~/.jake/jake.db", "tablePrefix": "planner_" } }
  ```

  `kabane init --db-path ~/.jake/jake.db --table-prefix planner_` writes that
  block. Both hosts run the same `@cabane/core`, so the schema apply on open is
  the same idempotent one Jake runs at boot. Leave `sync` disabled in this
  shape: Jake already syncs that file as its own device, and `kabane sync`
  warns when `db.path` and sync are both set.
- **extensions** (optional) turns official extensions on by name, e.g.
  `"extensions": ["loop"]`; absent is none. An extension ships inside the
  `kabane` package and adds commands, listed by `kabane help` once it is on,
  and board activity and triggers. It is imported only when one of its
  commands or the board runs, so `kabane list` never loads it. An off
  extension's command prints the line to add here instead of running. A name
  this version does not ship is ignored, with a warning on stderr when a
  command reads the list. The contract an extension implements
  is `@cabane/extension`.

### Settings layers

An extension's settings (today the loop's, under `loop`) resolve through layers, lowest first,
key by key:

1. the schema's defaults;
2. **user**: the namespace's key in `config.json`, for every project;
3. **project**: `<repo>/.kabane/<namespace>.json`, checked in with the repo (`.kabane/loop.json`);
4. **scope**: your settings for one project, in `config.json` under `scopes`, keyed by the scope
   id the repo detects, so they hold in every checkout and worktree of it and put no file in a
   repo you do not own;
5. the command's own flags, or the board's run form.

```json
{
  "actor": "cabane://actor/human/alex",
  "deviceId": "mbp",
  "loop": { "stallAfter": 4 },
  "scopes": {
    "github.com/acme/app": { "loop": { "gates": { "test": "npm test" }, "worktree": false } }
  }
}
```

Objects merge key by key, so each layer can add a gate; lists and scalars are replaced by the
higher layer. `null` in a layer unsets what the layers under it say. Every layer is validated on
its own first, so an error names the file, or "your settings for scope X", it is in; a key no
setting has is refused in every layer. Device keys (`actor`, `deviceId`, `sync`, `db`,
`copilot`, `harness`, `timezone`, `extensions`) live in your `config.json` only: no project file
or scope can redirect the database or the hub.

### Managing config from the CLI

```bash
kabane config                         # every key, its value and layer, and its description
kabane config list --json
kabane config get copilot.model        # dotted paths; one value
kabane config get loop.gates --layers  # every leaf under the key, each with the layer it came from
kabane config set copilot.model opus
kabane config set sync.enabled false   # booleans are true or false
kabane config set sync.batchBytes 262144
kabane config set extensions loop      # comma-separated names; "" clears the array
kabane config set copilot.args -- '--model,sonnet'
kabane config set sync.headers '{"CF-Access-Client-Id":"id","CF-Access-Client-Secret":"secret"}'
kabane config set loop.gates.test 'bun test' --layer scope    # this repo's scope, no file in it
kabane config set loop.lenses quality --layer project         # the repo's .kabane/loop.json
kabane config set loop.model haiku --scope github.com/acme/app  # a named scope, from anywhere
kabane config unset copilot.model      # remove the key from the layer
kabane config path                     # resolved config.json location
```

Reads resolve for the project the command runs in: its `.kabane/` files when run from the
project's root (what `kabane loop start` reads from there), and your settings for its scope, or
for `--scope <uri or id>`. Writes go to the user layer unless `--layer user|scope|project` names
another; `--scope` alone writes that scope's layer.

Every operation supports `--json`. `list` returns rows with `key`, `value`,
`default` (no layer sets it), `layer` and `from` (the file or scope it came from), `readOnly`,
`protected` and `description`. `get` returns the resolved value, or JSON `null` / human
`default` when absent; with `--layers` it returns `{key, value, leaves}`, where `leaves` maps
every dotted key under `key` to its `value`, `layer` and `from`, and prints a line per leaf. `path` returns a string. `set` returns `{key, layer, value}` and `unset`
returns `{key, layer, unset: true}`. `sync.token` and `sync.headers` read as `<set>`.

Strings are literal; numbers and booleans use JSON syntax. Arrays take trimmed
comma-separated values, with an empty string meaning an empty array.
`sync.headers` and `loop.gates` take a JSON object of string values; one gate is its own key,
`loop.gates.<name>`. Put `--` before a value starting with `--`. Object groups (`sync`, `db`,
`copilot`, `loop`, `loop.budget`) can be read; edit or unset their dotted keys individually.
`actor`, `deviceId` and `sync.deviceId` are read-only, including for `unset`.

Writes validate the entire config, or the whole namespace block they land in, before touching
the file, and retain unknown device fields, including those inside groups. A project file keeps
its indentation. Unsetting removes the key from that layer so a lower layer, or the default,
applies. Enabling an unshipped extension preserves its name and prints the extension loader's
warning on stderr. These operations never open SQLite or connect to sync. Except for `path`,
they require an existing config and point to `kabane init` when none exists.

## Scope

`scopeUri` is the context a task is filed under. Storage never resolves it; the
CLI does, from the working directory, so `list`, `search`, `add`, `board` and
`mcp` all land on the same scope whether you run them at a repo root, in a
package below it, or in a worktree. The cascade, highest first:

1. `--scope <uri>`
2. `.kabane/scope` — the nearest one walking up (one line, e.g. `myapp`);
   `kabane init --scope <uri>` writes it
3. `.jake/config.json` → `project.id` — a device sharing a Jake database has to
   honour the id Jake already filed tasks under
4. the git remote, normalized to `host/owner/repo` (`origin`, else the first
   remote listed), cached into `.kabane/scope`
5. the first commit, as `git:<hash12>`, also cached — replaced by a real remote
   id if one appears later, never the reverse
6. the project root path

Outside a project there is no scope and a query spans all of them. Bare ids
normalize to `jake://scope/<id>`; a detected scope also carries `branch` and
`package` as URI parameters, which record where a task was filed and never
narrow a filter. The resolution itself is `@cabane/core/scope` — off the package
barrel, because it needs git and a filesystem and the Worker has neither.

## Output and exit codes

Human text by default, `--json` on any command for the structured value. Exit
codes: `0` ok, `1` error, `2` usage. Errors go to stderr.

## Commands

| Command | Flags |
|---|---|
| `init` | `--actor <uri>` `--device <id>` `--sync-url <url>` `--sync-token <token>` `--access-client-id <id>` `--access-client-secret <secret>` (together; Access service token sent as headers on every push and pull) `--db-path <file>` `--table-prefix <prefix>` (open another database, e.g. Jake's `~/.jake/jake.db` with `planner_`) `--scope <uri>` (writes `./.kabane/scope`) `--force` |
| `config [list\|get <key>\|set <key> <value>\|unset <key>\|path]` | `--json` — inspect or edit device config without opening the database |
| `add "<title>"` | `--kind task\|issue` `--state <s>` `--priority urgent\|high\|normal\|low` `--scope <uri>` `--assignee <who>` `--parent <id>` `--description <text>` `--tags a,b` `--due YYYY-MM-DD\|<ISO time>` (a date is due by the end of that day in your timezone; a time without `Z` or an offset is your local time) `--format concise\|full` |
| `list` | `--state <s>` `--kind` `--priority` `--assignee` `--scope` `--tag` `--all` (include done and cancelled) `--limit <n>` `--format concise\|full` `--cursor <cursor>` |
| `show <id>` | task, links, comments, work log; `--json` also carries `updatedBy` (actor URI of the last writer) and `version` |
| `edit <id>` | `--title` `--description` `--state` `--priority` `--kind` `--assignee <who>\|none` `--scope` `--parent <id>\|none` `--tags` `--due` `--format concise\|full` |
| `done <id>` | `--format concise\|full` |
| `search <query>` | `--state` `--scope` `--limit` `--format concise\|full` `--cursor <cursor>` |
| `link <src> <dst>` | `--type blocks\|blocked_by\|parent\|child\|related\|duplicate\|follows` `--note` — a task-to-task DAG edge, not an external issue |
| `upstream link <id> <url>` | `--title <t>` `--provider <p>` `--id <key>` `--external-id <id>` — point a task at one issue in Linear or GitHub. Provider and issue key are read off the URL; the flags cover self-hosted or unfamiliar shapes |
| `upstream unlink <id> [key]` | drop the link; the key is only needed when a task has more than one |
| `open <id>` | launch the task's linked issue: the desktop app when its scheme is registered, else the browser, else the URL lands on the clipboard |
| `comment <id> "<text>"` | `--as <actor>` |
| `questions [<id>]` | `--all` (include answered and withdrawn) `--scope <uri>` `--limit <n>` `--cursor <cursor>` — open questions for the directory's scope or one issue, as `kabane_questions` prints them; `--json` is the question records, capped by `--limit` |
| `answer <handle> <answer…>` | `--why <text>`; or `--withdraw --why <text>` — answer `JCAB-12:1` (a choice ignoring case, a comma list for multi-select); an unknown choice exits 1 listing the valid ones. The last answer moves a waiting issue to next |
| `log <id>` | `--ref <type:value>` (repeatable) `--commit <sha>` `--branch <name>` `--pr <owner/repo#n>` `--url` `--session` `--file` `--note` |
| `context <id>` | `--no-deref` `--no-subtasks` `--format concise\|full` `--sections metadata,description,upstream,position,context,priorWork,discussion` `--cursor <cursor>` — lossless bounded selected markdown in concise mode; complete legacy brief otherwise |
| `sync [status\|push\|pull\|backfill]` | `backfill` seeds the log with rows that existed before sync was armed, then pushes |
| `update` | `--check` `--json` — metadata-only stable candidate (policy-unverified), or explicit verified update of a supported hoisted Bun global registry install; no tracker initialization |
| `board` | `--scope <uri>` — the terminal kanban (`@cabane/board`) on this device, no activity feed or dispatcher; those are host ports |
| `mcp` | `--as <actor>` — serve this device over MCP on stdio; the hub's tool list (`kabane_*`), with the working directory's scope as the default so writes may omit `scopeUri` |
| `mcp install` | `--harness claude\|codex\|gemini` (repeatable) `--force` `--print` — register `mcp` in each harness on PATH through its own `mcp add`, as `cabane://actor/agent/<harness>`; `--print` prints the snippets instead, also the fallback when none is found |

Updates are latest-stable only within the installed major (`0.x`: same minor). Source links,
file/tarball/other-manager and unverified isolated/missing-global-bin installs refuse mutation;
no automatic link repair, downgrade, git pull, startup networking or MCP rewiring is performed.
The explicit update preserves Bun registry/proxy/age policy; dry-run may populate external
package-manager caches, while check only reads metadata and may use runtime/metadata caches.
No tracker DB/config is opened. Restart board/MCP after a verified update; binary rollback
is not database rollback. See [compatibility/backup procedure](../../docs/getting-started.md#updating).

Agents should select `--format concise` on list/search/add/edit/done/context.
Context defaults to all sections; concatenate chunks by offset and consume every
preceding chunk before relying on its completeness flags. Finish required
description and human steering before starting work; request omitted sections
with `--sections` and continue using the same flags plus `--cursor`. Queue output
is compact JSON pages (default 20, maximum 100, <=16KiB UTF-8); mutation receipts
are <=2KiB with identity/state/version and no description echo. Follow
`nextCursor` via `--cursor` with the same filters. Preview truncation is explicit;
`show <id> --json` retrieves full fields. Omitted/full formats keep legacy human
text or raw `--json` records. See [concise read semantics](../../docs/concise-reads.md),
including query-relevant stale cursors and independent MCP today buckets.

Ids are short ids (`JCAB-12`) or ULIDs. Short ids are labels, not identities:
two devices can mint the same one offline, and `sync pull` relabels the later
one (`sync status` counts `renamed ids`).

## MCP on this device

```bash
kabane mcp install          # every harness on PATH: claude, codex, gemini
kabane mcp install --print  # .mcp.json, config.toml, settings.json, and a generic entry
```

Each harness gets `kabane` at user scope, spawning `<absolute bun> <this
clone>/index.ts mcp --as cabane://actor/agent/<harness>`: absolute because a
harness spawns servers with its own PATH, which often lacks `~/.bun/bin`, and
the bin's `#!/usr/bin/env bun` needs bun on it. An existing entry is reported
and left alone unless `--force`. The table behind both the install and the
snippets is `src/mcp-clients.ts`; `McpInstall.run(harnesses, opts)` in
`src/commands/mcp-install.ts` is the same install for callers other than the
command.

Same tools as a hub at `https://<your-domain>/mcp`: `kabane_scopeList`,
`kabane_add`, `kabane_get`, `kabane_list`, `kabane_search`, `kabane_today`,
`kabane_context`, `kabane_edit`, `kabane_done`, `kabane_link`,
`kabane_comment`, `kabane_log`, `kabane_contextAdd`, `kabane_contextList`,
`kabane_contextRemove`. The one difference: here a write may omit `scopeUri`
and take the directory default; at the hub it is required. Stdout is the wire,
so the command prints nothing of its own.

## Layout

```
index.ts            bin shim
src/main.ts         command table, help, exit codes
src/args.ts         pure argv parser
src/config.ts       KABANE_HOME, config.json, the scope pin file
src/context.ts      Runtime.configure + Planner.init, the Ctx commands receive, scope resolution
src/output.ts       --json vs human rendering, icons
src/first-run.ts    bare `kabane` in a terminal: the setup screen's deps, then the board
src/mcp-clients.ts  per-harness MCP registration argv and config snippets (pure)
src/commands/*.ts   one file per command
cli.test.ts         scripted session against the real binary
```

## Verified

`cli.test.ts` drives every command through the binary. Two devices were
converged by hand through a local `wrangler dev` of the sync log: concurrent
offline creates on both devices, the short-id rename on pull, and `backfill`
from a device that had rows before sync was enabled.
