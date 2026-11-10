# Settings: a generated editor, and settings that live with the user

Status: analysis, 2026-11-08 (JCAB-168). Baseline: `d688da9`. Nothing here is built yet. The
decisions still open are asked on JCAB-168, and the slices are filed as its children.

## Conclusions

1. **Most of "settings live with the user" already shipped in JCAB-90.** Every loop setting can
   be kept out of the repo: the user layer covers all projects, and the per-scope user layer
   covers one project and beats the checked-in file. What is left is narrow:
   - A write can silently do nothing. `kabane config set loop.stallAfter 7` reports success
     while `.kabane/loop.json` keeps the effective value at 2.
   - Custom lenses can only live in the repo (kept that way: they are files in its dispatch skill, JCAB-174).
   - The scope pin can only live in the repo (JCAB-175 adds a local pin).
2. **The precedence order should not change.** Every tool compared below puts the project file
   above the user's global settings, so a team's checked-in gate is not beaten by a default the
   user meant for other projects. "The project file is the fallback" already holds for the
   layer that is the user's own for that project, which is scope.
3. **The editor is mostly a data problem, then a board problem.** The resolver already knows
   each leaf's origin. Several things are missing:
   - which layers a key may be written to;
   - what a lower layer says that a higher one hides;
   - which keys are secrets;
   - which settings need a restart;
   - one description of a field that every surface shares;
   - a declared place for labels and groups.
   With those in the CLI's rows, the board view is a port and a renderer.
4. **Share the field description and the reading of typed values, not the interaction.** The
   run form and the editor share a grid. Elicitation stays one field at a time. Setup stays
   hand-built.

## Inventory

### Device config (`KABANE_HOME/config.json`, user layer only)

Schema: `ConfigSchema` at `packages/cli/src/config.ts:97`. Rows were checked against
`kabane config list --json` in `bun run sandbox` with `loop` enabled.

| Key | Kind | Flags | Read by | Written by |
| --- | --- | --- | --- | --- |
| `actor` | string | read-only | every write's stamp | setup (`first-run.ts:153`), `init` |
| `deviceId` | string | read-only | sync | setup, `init` |
| `sync.enabled`, `.url`, `.batchBytes` | bool, string, int | protected | sync | `init --sync-*`, `config set` |
| `sync.token`, `sync.headers` | string, record | protected, secret | sync | `config set` |
| `sync.deviceId` | string | read-only, protected | sync | `init` |
| `db.path`, `db.tablePrefix` | string | protected | opening the store | `config set` |
| `copilot.harness`, `.model`, `.command` | string | — | board start; `--copilot` overrides the harness (`board-runtime.ts:47`) | `config set`, copilot, `/setup` |
| `copilot.args` | list of string | — | board start | `config set` |
| `harness.mode` | enum `auto`/`default` | — | every session | `config set`, copilot |
| `updates.check` | bool | — | board start | `config set`; the sandbox writes false |
| `timezone` | IANA string | — | deadlines, today | `config set`, copilot |
| `extensions` | list of string | — | every command | `config set`, copilot, `/setup` |

The flags come from code, not from the schema: read-only (`config-settings.ts:71`), protected
(`:75`), secret (`:80`, shown as `<set>` by `redact`, `:97`). Two keys are checked outside the
schema: `copilot.harness` against `Harnesses.IDS` (`:385`), and `extensions` against the names
this build ships (`:418`). A device key written to any layer but user is refused (`:329`).

### Namespace `loop` (layered)

Schema: `LoopConfig.SettingsSchema` (`extensions/loop/src/config.ts:180`), strict at every
layer. Keys:

- `implementer` and `verifier`: enums of harness ids. `verifier` is optional.
- `model`: an optional string.
- `budget.concurrency` (1 to 8), `budget.continuations` and `budget.spend` (optional):
  numbers. `budget.currency`: a string.
- `stallAfter`: an integer.
- `gates`: a record of one-word names to commands.
- `worktree` and `recheck`: booleans.
- `lenses`: a list of lens names.
- `land`: the enum `none`/`pr`.

JCAB-144 and JCAB-162, both in flight, add `loop` keys (per-claim isolation and `loop.base`).
They appear in every surface below through the schema. They need a `LOOKS` entry only to get
a label.

Layers, lowest first (`Settings.Layer` in `packages/extension/settings.ts`, stored per
`ConfigLayers.sources` in `packages/cli/src/config-layers.ts`), named since JCAB-179:

| Layer | Stored in | Applies to | Former name |
| --- | --- | --- | --- |
| default | the schema | everywhere | — |
| global | `KABANE_HOME/config.json` at `loop` | every project on this device | `user` |
| shared | `<root>/.kabane/loop.json`, checked in | this project, for everyone who clones it | `project` |
| local | `KABANE_HOME/projects/<slug>/loop.json`; under it, a legacy `scopes.<scopeId>.loop` in `config.json` | this project, for you only, on this device | `scope` |
| caller | flags, or the run form | one run | — |

Objects merge key by key. Lists and scalars are replaced. `null` unsets.

The surfaces that touch it:

- **CLI.** `kabane config list|get [--layers]|set|unset [--layer global|local|shared]
  [--scope]`. The former names stay accepted on input. With no `--layer` a write goes to local
  inside a project and to global outside one. The shared layer is read and written only when
  cwd is the detected root; the local layer from anywhere inside the project.
- **MCP.** `kabane_configGet` and `kabane_configSet` (`config-tools.ts`) behave the same, for
  the project at the server's cwd. Every write answers `restartRequired: true` (`:76`), even
  though a namespace is re-read at each resolve.
- **Copilot.** It writes `layer: local` for "this project only" and never `shared`
  (`packages/acp/src/instructions.ts:64`, `:66`). `/setup` asks for the harness, model and
  extensions (`:170`).
- **Run form.** `LoopSettings.inputs` reads the resolved config (`dispatcher.ts:87`), and
  `overrides` turns the form's values into the caller layer (`settings.ts:272`). Nothing is
  saved. The gates show read-only in the preview.
- **`kabane loop start` flags.** These are the caller layer.

### What kabane reads from a repo

| Path | What | Written by |
| --- | --- | --- |
| `.kabane/` (the directory itself) | marks a project root ahead of git's toplevel (`packages/core/scope/detect.ts:105`), so a monorepo package can track its own issues | anything that writes below |
| `.kabane/scope` | the shared pin, in the scope cascade after your own pin in `KABANE_HOME/projects/<slug>/scope` (`detect.ts`, `resolveScopeId`) | only `kabane init --scope --shared` (`packages/cli/src/config.ts`, `writeDirectoryScope`) |
| Jake's project pin | the legacy pin, read and never stored (`packages/cli/src/context.ts:124`) | Jake |
| `.kabane/loop.json` | the loop's shared layer (`ConfigLayers.sharedFile`) | `config set --layer shared`, by hand |
| `.claude/skills/dispatch/references/lenses/<name>.md` | a custom lens, or the replacement for a shipped one, in the project's dispatch skill (`extensions/loop/src/lenses.ts`, JCAB-174); `.kabane/loop/lenses/<name>.md` is still read after it, for lenses written before | `/setup-dispatch`, by hand |

Nothing else lands in a repo. Scope detection stores what it found under `KABANE_HOME`
(JCAB-110). Run files and loop worktrees live under `KABANE_HOME` too (`extensions/loop/src/store.ts`).
Two files are written by an agent at the human's request, never by kabane: the first issue
asks an agent to add the tracker block to `CLAUDE.md` or `AGENTS.md` (`first-run.ts:77`), and
`/setup-dispatch` writes `.claude/skills/dispatch/`. Neither is a setting.

## Editor gap

What a settings screen generated for any namespace needs, and where each part stands:

| Primitive | Exists | Missing |
| --- | --- | --- |
| Field kinds from zod | Three walkers of zod schemas: `LoopSettings.kindOf`/`fieldsOf` (`extensions/loop/src/settings.ts:99`, `:108`; enum, number, boolean, string, other), `keysOf`/`parseValue` (`config-settings.ts:30`, `:109`; list, number, boolean, record from text), and `Settings.unwrap` (`settings.ts:81`) | One walker that yields a plain field description: `enum` with values, `number` with integer/min/max from the zod checks, `boolean`, `string` with min length, `list` (free, or picked from options), `record` (key schema plus value), and `optional` |
| Field description shared by surfaces | `CopilotFormField` (`packages/board/src/ports.ts:262`) already carries kind, bounds and options; `TriggerInput` (`ports.ts:160`) carries only type, default, label, group and options | One type in `@cabane/board/ports`, since extension already depends on board and board has no zod |
| Labels and groups | `LOOKS` and `GROUPS`, private to the loop (`settings.ts:43`, `:82`); `.describe()` on every key | A declared place on the contract (`Extension.looks?`, keyed by dotted path) and one from the CLI for device keys. `LOOKS` repeats the schema's bounds (`range(1, 8)` beside `.max(8)`) |
| Options known only at run time | `Harnesses.IDS`, `Extensions.names`, `Lenses.offered(projectDir)` | A way for a look to name its option source, so `copilot.harness`, `extensions` and `loop.lenses` show choices |
| Per-field origin | `Settings.Resolved.origins` per leaf (`settings.ts:29`); `get --layers` leaves; `layer`/`from` on list rows | What the layers below say. Only the winner is reported, so neither "the project says 2 and your scope overrides it" nor "unsetting here falls back to 2" can be shown |
| The layer a save goes to | `ConfigSettings.set(…, layer)` (`config-settings.ts:530`) | Which layers a key accepts (device keys: user only), carried on the row so a screen offers only those |
| A write that doesn't take effect | — | A write whose effective value a higher layer still decides should say so and name that layer (shown live: `set loop.stallAfter 7` prints `= 7`, `get` prints `2 (project: …/.kabane/loop.json)`) |
| Validation that names its source | `Settings.validate` names the file or "your settings for scope X" (`settings.ts:149`); a write validates the whole block it lands in (`config-settings.ts:398`); `FormField.read` reads a typed answer against bounds (`form-field.ts:79`) | Zod issues mapped back to the field, so the screen shows the error beside the field |
| Secrets | `redact`, `<set>` (`config-settings.ts:97`) | A `secret` flag on the row (today only the value shows it), and write-only entry: a new value is typed and never echoed |
| Read-only and protected | `readOnly` and `protected` on list rows (`config-settings.ts:499`) | Nothing. The editor is the human's own surface, so a protected key is editable there after a confirmation; only the agent is barred |
| Restart | — | A row flag: device keys apply at the next start, namespace keys at the next resolve. The MCP note should follow it |
| Records | `loop.gates.<name>` is its own key in the CLI (`config-settings.ts:232`) | An add/remove-entry interaction. The run form leaves records out (`settings.ts:11`) |

### One field model?

There are three form surfaces today, and they differ in interaction more than in data:

- **The run form** (`trigger-form.ts`) is a grid: `j/k` move, `h/l` step a value, `enter`
  fires. It can only hold a field that has a default and somewhere to step (`:27`).
- **The elicitation and decision forms** (`elicitation-form.ts`, `decision-form.ts`) ask one
  field at a time and type text into an input.
- **Setup** (`setup.tsx`, 910 lines) is a welcome flow. It asks for a name and harness
  checkboxes, then runs the installs. The only settings it writes are `actor` and `deviceId`.

Recommendation: share three things.

1. The field description, the `CopilotFormField` shape extended with a label, a group and
   whether the field is optional. It is derived from zod in `@cabane/extension`.
2. The reading of typed values: `FormField.read`, which the loop's questions already reuse.
3. The grid interaction between the run form and the editor. The editor is the run form plus
   an origin column, a target layer, text entry, unset and save.

Setup stays hand-built: converting it costs a rewrite and its render tests, and it would gain
two fields.

What sharing costs. `TriggerInput` is a port type that the loop builds, so the run form moves
to the shared description in the same change as the loop's `inputs`. The run form's keys and
behaviour don't change, but its row model, its stories and the loop's settings tests all move
together. One extra walker isn't the risk; the risk is the two existing ones (`keysOf` and
`fieldsOf`) drifting further, and that is what slice 2 removes.

## Settings layers: global, local, shared (JCAB-179)

"User" is not used on its own: in other tools it means "applies to all projects", and here it
was also used for "stored in your home". The three layers are named for whom they apply to.

- **Names.** `global`, `local` and `shared` in `--layer`, the MCP tools, every JSON row's
  `layer` and text output. `user`, `scope` and `project` stay accepted on input and mean
  global, local and shared; output uses only the new names.
- **Order:** unchanged. Defaults, global, shared, local, caller. Global sits below the shared
  file, as in Claude Code, Codex, VS Code and mise, so a personal default never beats a team's
  checked-in gate in every repo; local sits above it.
- **Where local is stored.** `KABANE_HOME/projects/<slug>/<namespace>.json` (`ProjectDirs` in
  `packages/core/scope/projects.ts`), the same document a shared file holds. `<slug>` is the
  root's path with each run outside `[A-Za-z0-9]` as `-`, then `-` and 8 hex of its sha256.
  Written whole through a temp file and a rename, since the board, MCP and the CLI can write at
  once.
- **Keyed by path, not scope id.** A scope id changes during a project's life: a repo with no
  remote is `git:<firstCommit>` until a remote is added, and `kabane init --scope` changes it.
  A block keyed by the old id was silently orphaned. Nothing syncs `config.json`, so the id
  bought no reach across devices. The key is the detected project root, from any directory in
  it; in a linked worktree, the same place in the main checkout (`mainCheckoutRoot`), since a
  repo that checks in `.kabane/` has the marker in every worktree. Moving the directory or
  cloning it again starts with no local settings; that is accepted.
- **Default write layer** (JCAB-168:1). With no `--layer`, a write inside a project goes to
  local, and outside one to global. Global and shared are written only when named. A device key
  has the global layer only, so it goes there wherever the command runs, and any other layer
  is refused.
- **Legacy `scopes.<scopeId>` blocks** keep working, read as a second local source just under
  the file and above shared, labelled `scopes.<id> in <config.json>`. Kabane never writes,
  moves or deletes them. `config unset --layer local` removes the key from the file only, and
  says when a `scopes` block still decides. Moving one into the file is JCAB-177.
- **`--scope <id>`** reads that scope's legacy block only. When it names another project than
  the one here, there is no shared or local file to read, and a local write is refused: it
  needs the project's directory.
- **`loop.json`:** stays readable as the shared layer. Nothing moves, and nothing is rewritten.
- **Lenses:** no user directory (JCAB-168:2: lenses stay repo files). A lens is
  `references/lenses/<name>.md` in the project's dispatch skill, read by the loop and by the
  skill's own close review alike (JCAB-174). Per-project choice exists, because `loop.lenses`
  at `--layer local` selects which lenses run there.
- **The pin:** `kabane init --scope` writes it to the same `projects/<slug>/` directory
  (JCAB-175), and `--shared` writes `.kabane/scope` as before. The local pin comes first in the
  cascade: local beats shared, read from "a local setting wins over a shared one" rather than
  answered by David. A `.kabane/scope` already in a repo keeps working and is never moved.
  Marking a project root below the git toplevel still takes a `.kabane/` directory in the repo.
- **Not synced.** A synced per-scope layer, if one is ever wanted, is a separate layer.
- **Device keys** stay global only (`copilot.command` and `.args` launch a process, which is
  what Codex and VS Code refuse from a checked-in file). A local layer for some of them is
  JCAB-176.

### How other tools layer settings

Read on 2026-11-08 from each tool's live docs.

| Tool (source) | Layers, low to high | A UI or CLI write goes to | Personal per-project file | Refused from the project file |
| --- | --- | --- | --- | --- |
| Claude Code ([settings](https://code.claude.com/docs/en/settings), pages cite features up to v2.1.314) | user `~/.claude/settings.json` → `.claude/settings.json` → `.claude/settings.local.json` → `--settings` → managed | `/config`: mostly user; a few options go to local. A permission "don't ask again" goes to local. There is no `config set` CLI today | `settings.local.json`, added to the *global* git excludes on first write | keys scoped "user or managed" are ignored; `defaultMode: auto/bypassPermissions` has no effect from project or local. Lists such as `permissions.allow` concatenate across layers |
| Codex CLI ([config basics](https://learn.chatgpt.com/docs/config-file/config-basic), [advanced](https://learn.chatgpt.com/docs/config-file/config-advanced)) | defaults → `/etc/codex` → cloud-managed → `~/.codex/config.toml` → profile file → `.codex/config.toml` from the root down to cwd → `-c` | no write command or UI is documented | none (use a profile) | `model_provider(s)`, base URLs, `notify`, `profile(s)`, `otel`, ignored with a warning; an untrusted project loads no `.codex/` at all |
| VS Code ([settings](https://code.visualstudio.com/docs/configure/settings), page dated 2026-11-04) | default → user → remote → workspace → folder → per-language → policy | the active User/Workspace tab of the Settings editor | none | `application` and `machine` scopes are user only; settings needing a trusted workspace are off in Restricted Mode |
| mise ([configuration](https://mise.jdx.dev/configuration.html)) | system → global → project files from `/` down to cwd (`mise.local.toml` over `mise.toml`) → `config.override.toml` | `mise use`/`set`: the nearest project's `mise.toml`; `-g` global, `--env local` local | `mise.local.toml` | `[settings]` cannot change discovery; gated by `mise trust` rather than per key |

Two things to take from it:

- **Origins in a UI.** VS Code's Settings editor is the only one that shows them: a modified
  bar and an `@modified` filter. Its 1.74 notes mention a "Modified elsewhere" indicator that
  the current page doesn't describe, so the wording is unverified. It also generates widgets
  from the schema: boolean to checkbox, enum to dropdown with `enumDescriptions`, string and
  number to an input, a simple array to an editable list, a flat object to a key/value grid,
  and anything else to "Edit in settings.json". That is the model for kabane's field kinds,
  with a record falling back to `kabane config set`.
- **Write defaults.** No tool defaults a write to a personal per-project layer. Claude Code and
  VS Code default to the user. mise writes the nearest project file, which is the opposite of
  what this issue wants.

## North Stars

- **Yours, by asking (3): strained, not broken.** A settings screen is configuration to learn,
  which this star says nobody should need. The copilot (`/setup`, `kabane_configSet`) is the
  asking path and stays the primary one. The editor earns its place as the place to *see* what
  is in effect and why, including what an agent changed. Ship it view-first, and keep the
  copilot's instructions as the way most people change things.
- **Yours, everywhere (4): one real tension.** User-level settings and lenses keep a repo you
  don't own clean, and one machine stays a complete setup. But `config.json` doesn't sync, and
  the hub isn't in use, so a value moved from a checked-in file to the user lives on one device
  where the file travelled with the repo to every one. Until settings sync, "user is the
  default" trades reach across devices for a clean repo. Settings sync is out of scope here; the
  tension should be said where the user chooses a layer (the editor's layer picker, and the
  CLI's help text).
- **Instant (2): fine if loaded on open.** `kabane config list --json` takes about 130 ms as a
  whole process against 80 ms for `--version` (sandbox, 3 runs). It resolves every namespace
  and imports every shipped extension (`extensions.ts:132`). The editor must build its rows
  when it opens, never at board start. The shadow check on a write is one more in-memory
  resolve.
- **Explains itself (5) and The human stays in charge (6): served.** Origins answer "why is it
  this value". Protected keys stay the human's, editable only on the human's surface.

## Slices, smallest first

1. **A write says when a higher layer still decides** (JCAB-169), in the CLI and MCP, and `get --layers` lists
   the values each leaf hides.
2. **Settings rows describe their fields** (JCAB-170). One zod walker in `@cabane/extension` replaces
   `keysOf` and `fieldsOf`. Rows gain `field`, `layers`, `secret` and `restart`.
   `kabane_configSet`'s restart note follows `restart`.
3. **Looks are declared** (JCAB-171). `Extension.looks` replaces the loop's private `LOOKS` and names
   option sources. The CLI declares looks for device keys.
4. **Board: a read-only settings view** (JCAB-172), with origin badges, behind a host port with a no-op
   default, and gallery stories.
5. **Board: edits in the view** (JCAB-173). Step and type values, choose the target layer, unset,
   write-only secrets, a confirmation for protected keys, the shadow warning.
6. **Lenses in the dispatch skill** (JCAB-174), `.claude/skills/dispatch/references/lenses/`, with
   no user-level directory. This one is independent of the others.

Order: 2 blocks 3, 3 blocks 4, and 4 blocks 5. Slice 1 blocks 4 and 5. Slice 6 stands alone.

Someday: a scope layer for `copilot.*` and `harness.mode`
(JCAB-176); `kabane config move` between layers (JCAB-177); adding and removing record entries
(gates) in the editor (JCAB-178).
