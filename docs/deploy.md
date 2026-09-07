# Deploy runbook

**Issue:** JCAB-11 · **Verified locally:** 2026-09-07 against `wrangler dev` with the dev
verifier (see the last section). Steps an agent must never perform are marked **MANUAL**:
they touch Cloudflare, DNS, Access, or a connector UI. Everything else was run as written.

Reading order matters. Part 1 builds the hub, part 2 the first device, part 3 the others,
part 4 connects clients, part 5 is what you do when something changes. The auth decision
behind part 1 is in [`auth.md`](auth.md).

What you end up with:

```
laptop ──┐                       ┌── Claude Code  (service token, CLI or hub)
desktop ─┼── cabane.3pew.ca ─────┼── Hermes       (service token)
hermes ──┘   CabaneLog (oplog)   ├── Codex        (service token)
             CabaneHub (device   ├── Claude.ai    (Managed OAuth)
             "cloud", MCP)       └── ChatGPT      (Managed OAuth)
```

Every device keeps an authoritative SQLite. The hub is one more device with a public URL.

---

## 1. Cloudflare

Prerequisites: the `3pew.ca` zone is on this Cloudflare account, and the Zero Trust team
`3pew` exists (`https://3pew.cloudflareaccess.com`), both already true from FamilyOS.

### 1.0 Deploy from GitHub Actions instead of your laptop — MANUAL once

`.github/workflows/ci.yml` runs the gate on every push and, on `main`, deploys the Worker
with `cloudflare/wrangler-action`. The deploy step stays a green no-op until the credentials
exist, so you can push before finishing this part. Once set up, 1.1, 1.2, 1.5 and 5.7 are
things CI does for you; the Access application, service tokens and Managed OAuth (1.3, 1.4,
1.6) remain dashboard work either way.

In the repository settings create the `production` environment and add:

| Kind | Name | Value |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | An API token from the Cloudflare dashboard with `Workers Scripts: Edit`, `Workers Routes: Edit`, `Account Settings: Read`, and, because the Worker owns the `cabane.3pew.ca` custom domain, `Zone: DNS: Edit` and `Zone: Workers Routes: Edit` on the `3pew.ca` zone |
| Secret | `CLOUDFLARE_ACCOUNT_ID` | Overview page of the account |
| Secret | `SYNC_TOKEN` | `openssl rand -base64 32`; uploaded to the Worker on every deploy |
| Variable | `ACCESS_AUD` | The AUD tag from 1.3 |
| Variable | `HUMAN_EMAIL` | Your address, the one in the Allow policy |
| Variable | `SERVICE_ACTORS` | The JSON map from 1.5, one line |

Variables can stay empty until 1.3 and 1.4 are done; an empty value deploys a Worker that
admits nobody, exactly like a fresh manual deploy. Re-run the workflow (Actions, `ci`,
`Run workflow`) after filling them. Do not put the AUD or the email into `wrangler.jsonc`
when CI deploys: the `vars` block there stays empty and the workflow passes them with
`--var`, which overrides the file.

### 1.1 Log in and deploy — MANUAL, or skip when 1.0 is set up

```bash
cd ~/Projects/cabane/packages/worker
bunx wrangler login
bunx wrangler deploy
```

Expected: the deploy creates the Worker `cabane-worker`, applies migration tag `v1`
(`CabaneLog` and `CabaneHub` as SQLite-backed Durable Object classes), and attaches the
custom domain `cabane.3pew.ca` (from `routes` in `wrangler.jsonc`, `custom_domain: true`).
Wrangler creates the DNS record for a custom domain; nothing to add by hand. No
`workers.dev` URL and no preview URL are published (`workers_dev` and `preview_urls` are
`false`). The Workers Free plan is enough: SQLite-backed Durable Objects are the only kind
it offers, and the limits (100k requests and 100k rows written per day, 5 GB stored) are
far above one person's tracker.

Check:

```bash
curl -i https://cabane.3pew.ca/health
```

Expected: `HTTP/2 401` **from the Worker** with body `{"error":"unauthorized"}`. Access
is not in front yet, so the request reaches the Worker, which refuses it because no
assertion is present. If you get `522` or a Cloudflare error page, the custom domain has
not finished provisioning; wait a minute.

### 1.2 The log secret — MANUAL

```bash
openssl rand -base64 32          # keep the output, every device needs it
bunx wrangler secret put SYNC_TOKEN
```

Paste the value when prompted. Expected: `✨ Success! Uploaded secret SYNC_TOKEN`. Devices
send this as `Authorization: Bearer` on `/push` and `/pull`; it is the log's own check and
sits behind Access, so it is the second wall, not the perimeter.

### 1.3 The Access application — MANUAL

Zero Trust dashboard → **Access controls → Applications → Add an application →
Self-hosted** (or **AI controls → MCP servers → Add an MCP server** if you want the MCP
server application type; both produce an application with an AUD and the same policy
model). Fill:

| Field | Value |
|---|---|
| Application name | `cabane` |
| Application domain | `cabane.3pew.ca`, path empty (every route is protected, `/health` included) |
| Session duration | 24 hours (browser sessions only; service tokens do not use it) |

Policies, two of them:

| Policy | Action | Include |
|---|---|---|
| `david` | Allow | Emails: your address |
| `runtimes` | Service Auth | Service Token: every token created in 1.4 (come back and add them) |

No Bypass policy anywhere. This is the FamilyOS invariant (their ADR 0001 exit criteria:
"the Access application has no bypass") and `auth.md` depends on it.

After saving, open the application and copy the **Application Audience (AUD) Tag**. That is
`ACCESS_AUD`.

### 1.4 Service tokens, one per runtime — MANUAL

**Access controls → Service credentials → Service tokens → Create Service Token**, four
times, duration 1 year:

| Token name | Runtime | Actor the Worker stamps |
|---|---|---|
| `cabane-claude-code` | Claude Code | `cabane://actor/agent/claude` |
| `cabane-hermes` | Hermes | `cabane://actor/agent/hermes` |
| `cabane-codex` | Codex | `cabane://actor/agent/codex` |
| `cabane-cron` | scheduled pulls on devices | `cabane://actor/agent/cron` |

Each creation shows the **Client ID** (ends in `.access`) and the **Client Secret** once.
Store the secret in the runtime machine's keychain or env; it never goes into a repo. The
client ids go into `SERVICE_ACTORS` in the next step. Then return to 1.3 and add the four
tokens to the `runtimes` Service Auth policy.

### 1.5 Fill the vars and redeploy — MANUAL

Edit `packages/worker/wrangler.jsonc`, the `vars` block:

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "https://3pew.cloudflareaccess.com",
  "ACCESS_AUD": "<the AUD tag from 1.3>",
  "HUMAN_EMAIL": "<your address, the one in the Allow policy>",
  "SERVICE_ACTORS": "{\"<claude-code client id>.access\":\"cabane://actor/agent/claude\",\"<hermes client id>.access\":\"cabane://actor/agent/hermes\",\"<codex client id>.access\":\"cabane://actor/agent/codex\",\"<cron client id>.access\":\"cabane://actor/agent/cron\"}",
  "SYNC_INTERVAL_MINUTES": "5"
}
```

Empty `ACCESS_AUD`, `HUMAN_EMAIL`, or `SERVICE_ACTORS` means nobody is admitted, which is
the state the fresh deploy from 1.1 was in. Commit this change (the AUD and client ids are
identifiers, not secrets; FamilyOS commits the same two), then:

```bash
bunx wrangler deploy
```

Check, from a machine with a service token:

```bash
curl -s https://cabane.3pew.ca/health \
  -H "CF-Access-Client-Id: <client id>" \
  -H "CF-Access-Client-Secret: <client secret>"
```

Expected: `{"ok":true,"service":"cabane-worker","actor":"cabane://actor/agent/claude"}`
with the actor matching the token you used. And the reject test:

```bash
curl -i https://cabane.3pew.ca/health
bunx wrangler tail --format pretty      # in a second terminal, while running the curl
```

Expected: a `302` to the Access login page (a browser) or `401` from Access (a non-browser
client), and **no invocation in `wrangler tail`**. Access rejected before the Worker ran.

### 1.6 Managed OAuth for browser connectors — API for the toggle, MANUAL for the allowlist

Only needed for Claude.ai and ChatGPT. The Worker needs no change: Managed OAuth ends in
the same `Cf-Access-Jwt-Assertion` the Worker already verifies (`auth.md`, topology a).

**The toggle is an API field** (done 2026-09-07 on the live application). `PUT
/accounts/<id>/access/apps/<app>` with the existing fields plus:

```json
"oauth_configuration": {
  "enabled": true,
  "dynamic_client_registration": {
    "enabled": true,
    "allow_any_on_localhost": true,
    "allow_any_on_loopback": true
  }
}
```

The two `allow_any_on_*` flags are what the dashboard calls **Allow localhost clients** and
**Allow loopback clients** (Claude Code and the MCP inspector redirect to
`http://localhost:<port>/callback`). Note the PUT must resend `policies` as
`[{ "id", "precedence" }]` or the application loses them.

**The allowlist and lifetimes are dashboard-only.** The API accepted but did not persist
`allowed_redirect_uris`, `access_token_lifetime`, and `grant_session_duration` (verified:
they never come back on GET). Set them by hand: Zero Trust → **Access controls** →
**Applications** → `Cabane` → ⋯ → **Edit** → **Advanced settings** → Managed OAuth section:

| Setting | Value |
|---|---|
| Allowed redirect URIs | `https://chatgpt.com/connector/oauth/*` |
| | `https://chatgpt.com/connector_platform_oauth_redirect` |
| | `https://claude.ai/api/mcp/auth_callback` |
| Access token lifetime | 15 minutes |
| Grant session duration | 14 days |

Whether an empty allowlist admits any `https` redirect or none is not documented; add the
three URIs before testing a browser connector so the result is unambiguous.

Check (both were verified live after the API call):

```bash
curl -s https://cabane.3pew.ca/.well-known/oauth-authorization-server
curl -s -o /dev/null -D - -X POST https://cabane.3pew.ca/mcp -H 'Content-Type: application/json' -d '{}' | grep -i www-authenticate
```

Expected: the first returns JSON with `issuer` `https://3pew.cloudflareaccess.com`,
`authorization_endpoint`, `token_endpoint`, `registration_endpoint` under
`/cdn-cgi/access/oauth/`, and `code_challenge_methods_supported: ["S256"]`. The second is a
`401` carrying `WWW-Authenticate: Bearer realm="OAuth" ... resource_metadata="https://cabane.3pew.ca/.well-known/cloudflare-access-protected-resource/mcp"`,
which is the RFC 9728 pointer ChatGPT and Claude.ai follow.

---

## 2. First device

### 2.1 Install the CLI

The CLI is not published (JCAB-15 is parked), so it runs from the checkout. `bun link` is
the install path that was verified; `bun install -g` from a path is not supported for a
workspace package and was not used.

```bash
cd ~/Projects/cabane && bun install
cd packages/cli && bun link
cabane --help
```

Expected: `bun link` prints `Success! Registered "cabane"`, `which cabane` answers
`~/.bun/bin/cabane`, and `--help` lists fourteen commands. The link points at this
checkout, so `git pull` updates the binary; do not link from a worktree that will be
removed.

### 2.2 Initialize

```bash
cabane init \
  --actor cabane://actor/human/<your name> \
  --device <short machine name> \
  --sync-url https://cabane.3pew.ca \
  --sync-token '<SYNC_TOKEN from 1.2>'
```

Expected:

```
✓ Initialized /Users/<you>/.cabane
  actor:  cabane://actor/human/<your name>
  device: <short machine name>
  sync:   https://cabane.3pew.ca
```

`CABANE_HOME` (default `~/.cabane`) now holds `config.json` and `cabane.db`. The device id
is write-once: it becomes the device's identity in the log on the first push and renaming
it afterwards makes the log treat the machine as new.

### 2.3 Give the device its Access credentials

The hub is behind Access, so every push and pull must carry a service token. Use the
`cabane-cron` token from 1.4 for devices (it is the identity of the machine, not of the
person; writes are still stamped with the device's `actor`). Edit
`~/.cabane/config.json` and add `headers` inside `sync`:[^init-flags]

```json
"sync": {
  "enabled": true,
  "url": "https://cabane.3pew.ca",
  "token": "<SYNC_TOKEN>",
  "deviceId": "<short machine name>",
  "batchBytes": 262144,
  "headers": {
    "CF-Access-Client-Id": "<cron client id>.access",
    "CF-Access-Client-Secret": "<cron client secret>"
  }
}
```

[^init-flags]: `cabane init --access-client-id <id> --access-client-secret <secret>` writes
this block, and `--scope <id>` writes `./.cabane/scope`. Both land with JCAB-19; until it
merges, edit the file.

Check:

```bash
cabane sync status
```

Expected: `Sync: not armed on this device (run \`cabane sync push\` once with sync
configured).` Arming happens on the first connection.

### 2.4 Arm, and backfill if you are migrating

If this is a fresh tracker:

```bash
cabane sync push
```

Expected: `⬆️  Pushed 0 ops (0 duplicates, 0 batches) as device <name>`. The device is
now armed and every later write is captured.

If you are migrating from Jake there are two routes, depending on where the CLI runs.

**Same machine as Jake: share the database, no migration.** Both hosts run the same
`@cabane/core`, so the CLI can open `~/.jake/jake.db` directly with the `planner_` prefix
Jake uses. Skip 2.2 and 2.3 and initialize like this instead:

```bash
cabane init \
  --actor cabane://actor/human/<your name> \
  --device <short machine name> \
  --db-path ~/.jake/jake.db --table-prefix planner_
cabane list --limit 5
```

Expected: the `init` output ends with `db: /Users/<you>/.jake/jake.db (tables planner_*)`
and `list` shows the same tasks `jake plan list` shows. Nothing is copied and nothing
syncs between the two hosts, because it is one file. Do **not** add `--sync-url` in this
shape: Jake already syncs that file as device `<jake machine name>` through its own
config, and `cabane sync` warns when `db.path` and sync are both set. Opening the file
from the CLI runs the same idempotent schema apply Jake runs at boot (verified: a copy of a
644 MB `jake.db` had an unchanged SHA-256 after `init`, `list`, `show`, and
`sync status`).

**Another machine: backfill through the log.** The Jake machine is itself a device once
JCAB-4 merges; point it at the same hub and let it backfill:

```jsonc
// ~/.jake/config.json
{ "modules": { "planner": { "sync": {
  "enabled": true,
  "url": "https://cabane.3pew.ca",
  "token": "<SYNC_TOKEN>",
  "deviceId": "<jake machine name>",
  "headers": { "CF-Access-Client-Id": "<cron client id>.access", "CF-Access-Client-Secret": "<cron client secret>" }
} } } }
```

```bash
jake plan sync push        # arms the Jake device
jake plan sync backfill    # one op per existing replicated row, then push
```

Expected: a per-table count under `Planner Sync — Backfill`, then a push. Backfill is
idempotent (op ids derive from table, row id and version), so a re-run is a no-op. What
carries over: tasks, links, comments, work logs, projects, focus lists, context refs. What
does **not**: agent sessions and activities, the task activity timeline, upstream links
(private by schema), session defaults, and anything marked `visibility: private`. Jake's
`jake plan sync backfill` exists on the JCAB-4 branch and lands with it.

Then, on the Cabane device: `cabane sync pull`. Expected: `⬇️  Pulled N ops, applied N,
renamed 0` and `cabane list --all` shows the tasks. Short ids may be relabelled when two
devices minted the same one offline; `cabane sync status` counts them under `renamed ids`.

Check:

```bash
cabane sync status
```

Expected: `Sync: armed as device <name>`, `pending ops: 0`, `last sync:` a timestamp,
`quarantined: 0`.

---

## 3. Additional devices

Repeat 2.1 to 2.3 with a different `--device` name (same `SYNC_TOKEN`, same or a
dedicated service token), then:

```bash
cabane sync pull
```

Expected: every replicated row from the log applied. A fresh device replays the full log;
at current rates that is seconds. Do not run `backfill` on an empty device: there is
nothing to seed.

### 3.1 Scheduled pull

Push is opportunistic (the hub pushes after every write, a device after `cabane sync
push`), but pull writes rows and may relabel ids, so it is never automatic inside another
command. Schedule it.

macOS (launchd), template in [`schedule/com.cabane.sync-pull.plist`](schedule/com.cabane.sync-pull.plist):

```bash
sed "s|__HOME__|$HOME|g" ~/Projects/cabane/docs/schedule/com.cabane.sync-pull.plist \
  > ~/Library/LaunchAgents/com.cabane.sync-pull.plist
plutil -lint ~/Library/LaunchAgents/com.cabane.sync-pull.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.cabane.sync-pull.plist
launchctl print gui/$(id -u)/com.cabane.sync-pull | grep -E "state|interval"
```

Expected: `OK` from `plutil`, then `state = waiting` and `interval = 300`. Output lands in
`~/.cabane/sync-pull.log`. Remove with `launchctl bootout gui/$(id -u)/com.cabane.sync-pull`.

Linux (cron), line in [`schedule/cabane-sync-pull.cron`](schedule/cabane-sync-pull.cron):

```bash
crontab -l 2>/dev/null | cat - ~/Projects/cabane/docs/schedule/cabane-sync-pull.cron | crontab -
crontab -l | grep cabane
```

Both assume the `bun link` install (`~/.bun/bin/cabane`) and the default `CABANE_HOME`.
Five minutes matches the hub's `SYNC_INTERVAL_MINUTES`; a task filed at the hub reaches a
device within two intervals.

### 3.2 A runtime that polls for work

Hermes, Codex, and Claude Code pick up issues assigned to them with `cabane list
--assignee <runtime> --state next` after a pull, then `cabane context <id>` for the brief.
The pollers themselves live outside this repo (JCAB-12 Hermes, JCAB-13 Codex, both
parked); `jake loop` is the Claude one.

---

## 4. Clients

Two ways in: a device's own CLI over stdio (full local tracker, no network), or the hub
over HTTP (the replicated surface, fifteen `cabane_*` tools, `scopeUri` required on
writes). Header-capable clients use a service token; browser connectors use Managed OAuth.

### 4.1 Claude Code

Hub, with the `cabane-claude-code` token:

```bash
claude mcp add --transport http -s user cabane https://cabane.3pew.ca/mcp \
  --header "CF-Access-Client-Id: <client id>.access" \
  --header "CF-Access-Client-Secret: <client secret>"
claude mcp list
```

Expected: `cabane: https://cabane.3pew.ca/mcp (HTTP) - ✔ Connected`. Writes from this
connection are stamped `cabane://actor/agent/claude`.

Local device instead (no network, sessions included):

```bash
claude mcp add -s user cabane -- cabane mcp --as cabane://actor/agent/claude
```

### 4.2 Hermes

`~/.hermes/config.yaml`, under `mcp_servers` (the `url` form is documented in Hermes's
`cli-config.yaml.example`; `headers` is the static-header map its MCP skills use):

```yaml
mcp_servers:
  cabane:
    url: https://cabane.3pew.ca/mcp
    headers:
      CF-Access-Client-Id: "<hermes client id>.access"
      CF-Access-Client-Secret: "<hermes client secret>"
    timeout: 30
```

Expected: Hermes registers tools named `mcp_cabane_cabane_add` and so on. Alternatively,
install the CLI on the Hermes machine (part 2) and let Hermes drive `cabane` through its
terminal toolset; that gives it sessions and the board, not just the replicated surface.

### 4.3 Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.cabane]
url = "https://cabane.3pew.ca/mcp"

[mcp_servers.cabane.http_headers]
CF-Access-Client-Id = "<codex client id>.access"
CF-Access-Client-Secret = "<codex client secret>"
```

Or keep the secret out of the file with `env_http_headers`, mapping header names to
environment variable names, in the same table position.

### 4.4 MCP inspector, the first browser-style test — MANUAL

Before touching a connector UI, prove Managed OAuth end to end with a client you can read:

```bash
npx -y @modelcontextprotocol/inspector https://cabane.3pew.ca/mcp
```

In the UI, transport Streamable HTTP, no headers, Connect. Expected: a browser tab opens on
the Access login, you authenticate as `HUMAN_EMAIL`, the inspector lists fifteen tools, and
`cabane_scopeList` returns your scopes. Writes are stamped `cabane://actor/human/<local
part>`.

### 4.5 Claude.ai — MANUAL

Settings → Connectors → Add custom connector → URL `https://cabane.3pew.ca/mcp`, no
client id. Expected: an Access login, then the connector shows as connected.

Known risk (`auth.md`): Claude.ai failed against Managed OAuth in June 2026 while Claude
Code worked (anthropics/claude-ai-mcp#410, causes isolated to the `resource` parameter and
`authentication_methods` ordering); no fix is confirmed. If Connect fails, capture the
`ofid_` reference from the error, check whether the authorization request carried
`resource`, and only then consider the fallback topology (b) in `auth.md`, which needs an
ADR because it introduces an Access bypass.

### 4.6 ChatGPT — MANUAL

Settings → Connectors → Advanced → Developer mode, then Create → URL
`https://cabane.3pew.ca/mcp`, Authentication OAuth, no client id. Expected: an Access
login, then the connector lists the tools. There is no public report of ChatGPT against
Managed OAuth either way; this is the last test in the order.

Test order, and stop at the first failure: inspector (4.4), Claude Code (4.1), Claude.ai
(4.5), ChatGPT (4.6).

---

## 5. Operations

### 5.1 Rotate the log secret — MANUAL

```bash
openssl rand -base64 32
bunx wrangler secret put SYNC_TOKEN
```

Then update `sync.token` on every device (`~/.cabane/config.json`, and
`modules.planner.sync.token` in `~/.jake/config.json` for the Jake device). Until a device
is updated its pushes fail with `401`, which propagates as an error and leaves the
watermark in place; nothing is quarantined on a `401`. Run `cabane sync push` on each
device to confirm.

### 5.2 Rotate or revoke a service token — MANUAL

Zero Trust → Service tokens → the token → **Refresh** (new secret, same client id, so
`SERVICE_ACTORS` is unchanged) or **Revoke**. Update the secret where that runtime keeps
it (Claude Code: `claude mcp remove` then `add`; Hermes and Codex: their config files;
devices: `sync.headers`). A revoked token gets `401` from Access before the Worker runs.

### 5.3 Add a runtime — MANUAL

Create a service token (1.4), add it to the `runtimes` Service Auth policy (1.3), add its
client id to `SERVICE_ACTORS` with the actor URI you want stamped (1.5), `bunx wrangler
deploy`. A token that is in the policy but not in `SERVICE_ACTORS` is admitted by Access
and refused by the Worker with `401 unknown service identity`; the Worker is closed by
default.

### 5.4 Watch it run — MANUAL

```bash
bunx wrangler tail --format pretty
```

Every request logs at the edge; `hub push failed` or `hub pull failed` lines mean the
scheduled pass hit the log and will retry at the next interval (the alarm never throws).
The hub's alarm runs every `SYNC_INTERVAL_MINUTES`; changing the var needs a redeploy and
takes effect at the next alarm.

### 5.5 What `quarantined` means

`cabane sync status` shows `quarantined: N` and the last ten op ids. A quarantined op is
one the server refused on content (a `400`, `413`, or `500`, typically a row over the 2 MB
Durable Object value cap: descriptions are PRDs). The transport bisected the failing batch
until the offender was alone, recorded it, and moved the watermark past it so everything
else keeps flowing. The row is still correct locally; it is simply not replicated. Fix:
shorten the row, edit it so a new version is captured, push again. A `401` or a dead
network never quarantines.

### 5.6 The log was wiped or restored

There is no restore command in Cabane, and none is needed for the data: every device is
authoritative. If the Durable Object is deleted or rolled back (Cloudflare keeps 30 days of
point-in-time bookmarks for SQLite-backed objects, restorable from the dashboard), the next
push from any device sees `head < last_applied_seq`, logs `sync log reset detected`, rewinds
its applied watermark to 0, and re-reads. To repopulate an empty log, run `cabane sync
backfill` on one device that has everything (or `jake plan sync backfill` on the Jake
machine); the others pull. Short ids may be relabelled during that convergence.

### 5.7 Redeploy after a code change — MANUAL, or a push to `main` when 1.0 is set up

```bash
cd ~/Projects/cabane && bun run check && bun run typecheck && bun run test
cd packages/worker && bunx wrangler deploy
```

`wrangler.jsonc` `migrations` only ever gain tags; never rename or remove a class.

---

## What was verified locally, and what was not

Run on 2026-09-07 against `wrangler dev --port 8794` with a `.dev.vars` carrying
`ACCESS_DEV_UNVERIFIED=true` (unsigned assertions accepted), `SYNC_TOKEN=dev-token`, a
`HUMAN_EMAIL`, and a two-entry `SERVICE_ACTORS`. Devices carried the dev assertion in
`sync.headers` instead of a service token, because there is no Access in front of
localhost.

| Step | Result |
|---|---|
| 1.1 reject test | `GET /health` bare → `401`; with a human assertion → `{"ok":true,…,"actor":"cabane://actor/human/david"}`; with a service assertion → the mapped agent actor; `GET /mcp` → `405`; `POST /push` without the bearer → `401` |
| 2.1 `bun link` | `cabane` on PATH at `~/.bun/bin/cabane`, `--help` lists the commands |
| 2.2 to 2.4 device A | `init` → `sync status` "not armed" → a task added before arming → `sync backfill` seeded and pushed it (1 op) → a task added after arming was captured and pushed live |
| 3 device B | `init`, `sync pull` → 2 ops applied, both tasks listed |
| hub as device | after the alarm the hub's `cabane_list` returned both device tasks with the right `updatedBy`; `cabane_add` at the hub as the Hermes service identity was stamped `cabane://actor/agent/hermes` |
| collision repair | hub and device A had both minted `JCAB-1`; device B's next pull applied the hub's task, `renamed 1`, and all three sides agree on `JCAB-3` for it |
| 3.1 templates | `plutil -lint` OK on the plist, before and after the `__HOME__` substitution |
| 4.1 Claude Code | `claude mcp add --transport http … --header "Cf-Access-Jwt-Assertion: …"` against localhost → `claude mcp list` shows `✔ Connected`; removed afterwards |
| 4.4 inspector | `npx @modelcontextprotocol/inspector --cli … --method tools/list` → 15 tools; `tools/call cabane_add` created a task |

Not verifiable without the real account, therefore **MANUAL** above: `wrangler login` and
`deploy`, the custom domain, the Access application and policies, service tokens, Managed
OAuth and its metadata endpoint, the `wrangler tail` reject test, Claude.ai and ChatGPT
connectors, Hermes and Codex against the real hub, and the launchd job on a machine you are
willing to have pull every five minutes.
