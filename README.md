# Kabane

Local-first issue tracker and kanban for humans and AI agent runtimes. Every device
keeps an authoritative SQLite; devices converge through an append-only oplog relayed
by a Cloudflare Durable Object. A hub Worker runs the same core on DO SQLite and
serves MCP, so browser-only tools (ChatGPT, Claude.ai) and CLI-capable runtimes
(Claude Code, Hermes, Codex) share one tool surface. One machine on local SQLite is a
complete setup; the hub is optional and you host it yourself.

| Package | Name | Runtime | Holds |
|---|---|---|---|
| `packages/core` | `@kabane/core` | Bun + Workers | schemas, storage over the Db port, sync, MCP tool definitions and server composition |
| `packages/sqlite` | `@kabane/sqlite` | Bun | Db adapter over `bun:sqlite` |
| `packages/acp` | `@kabane/acp` | Bun | Agent Client Protocol client: harness registry, session runner and form types |
| `packages/extension` | `@kabane/extension` | Bun | the extension contract, and the argument parsing and outcomes every command is written with |
| `packages/questions` | `@kabane/questions` | Bun + Workers | data module: the decisions agents ask a human on an issue (`kabane_ask`, `kabane_questions`, `kabane_answer`), replicated like tasks |
| `packages/checklist` | `@kabane/checklist` | Bun + Workers | data module: the steps of one issue, ticked as they land (`kabane_checklist`, `kabane_checklistAdd`, `kabane_checklistTick`, `kabane_checklistEdit`), replicated like tasks |
| `packages/outcome` | `@kabane/outcome` | Bun + Workers | data module: decisions, findings, verifications and summaries projected into the issue's Discussion timeline |
| `packages/handoff` | `@kabane/handoff` | Bun + Workers | data module: what whoever did the work on an issue, code, research or a design, leaves for the next reader, written from a template (summary, evidence, what is not verified, risk) with `kabane_handoff`; an entry on the issue's timeline, and the brief opens with the latest |
| `packages/cli` | `kabane` | Bun | the device command line and MCP over stdio |
| `packages/board` | `@kabane/board` | Bun | OpenTUI kanban over ActivitySource, Dispatcher and Copilot ports |
| `packages/worker` | `kabane-worker` | Workers | sync log DO + cloud device serving MCP over Streamable HTTP |

Kabane bundles no extension. Three live in `extensions/`, each built and installed on its own:
the [loop](docs/loop.md) runs issues through coding harnesses on your machine,
[dispatch](extensions/dispatch/README.md) gives your projects the dispatch and grill skills and
the setup-dispatch skill that writes them, and [recipes](docs/recipes.md) runs prompt recipes from your
project in background terminals with `kabane run`. [`docs/extensions.md`](docs/extensions.md) installs and enables
them, and [`docs/writing-an-extension.md`](docs/writing-an-extension.md) walks through writing
your own.

## Install

Releases ship on [GitHub Releases](https://github.com/davidpp/kabane/releases) as a standalone
binary, which includes Bun, for macOS (`darwin-arm64`, `darwin-x64`) and Linux (`linux-x64`,
`linux-arm64`, glibc). Any one of these puts `kabane` on PATH:

```bash
brew install davidpp/tap/kabane                  # Homebrew (recommended)
curl -fsSL https://github.com/davidpp/kabane/releases/latest/download/install.sh | sh
mise use -g github:davidpp/kabane                # mise's GitHub backend
kabane --version
```

- **Homebrew** installs the latest stable release from the [`davidpp/tap`](https://github.com/davidpp/homebrew-tap)
  tap, whose formula this repository's release workflow commits and pins by SHA-256. In a
  Brewfile: `tap "davidpp/tap"` and `brew "davidpp/tap/kabane", trusted: true` (`brew bundle`
  refuses formulae from a third-party tap it has not been told to trust).
- **The installer** downloads the archive for this machine and the release's `SHA256SUMS` over
  https, redirects included, refuses the archive on a mismatch, and checks its build provenance
  with `gh attestation verify` when an authenticated `gh` is on PATH. It installs the release
  directory as `~/.local/share/kabane` and links `~/.local/bin/kabane`. `--prefix <dir>` and
  `--bin <dir>` choose other places. Run again, it keeps the previous install until the new one
  is linked and puts it back if anything fails. It never overwrites a `kabane` in the bin
  directory that is not a symlink. `latest` is the latest stable release; for a beta, take
  that release's installer and name its version:
  `curl -fsSL https://github.com/davidpp/kabane/releases/download/vX.Y.Z-beta.N/install.sh | sh -s -- --version X.Y.Z-beta.N`.
- **mise** downloads the same archive for your platform and checks it against `SHA256SUMS`.
- **On a Bun install** (`bun add -g kabane`, up to `1.0.0-beta.0`): releases no longer go to
  npm. Install with Homebrew or the installer, run `bun remove -g kabane`, then
  `kabane mcp install --force` so your coding agents launch the new `kabane`.
  `kabane update` prints the same.

Each install updates with its own command; the board's update notice names it:

| Installed with | Update with |
|---|---|
| Homebrew | `brew upgrade kabane` |
| the installer, or an extracted release archive | `kabane update` |
| mise | `mise up github:davidpp/kabane` |
| `bun add -g` (up to `1.0.0-beta.0`) | move to Homebrew or the installer, as above |

To install a release archive by hand, download its `kabane-<os>-<arch>.tar.gz` and `SHA256SUMS`
from the same release, check it with `shasum -a 256 --check --ignore-missing SHA256SUMS`
(`sha256sum` on Linux) and extract it with `tar -xzf`. Keep the extracted `kabane/` directory
whole: `kabane update` knows an extracted release by the `templates/` directory beside the
executable, and the shipped extensions live in its `extensions/`. Put that directory on PATH or symlink its `kabane` into one that is.
The binary includes Bun; git is still used for project scopes, and coding harness adapters
still need their own runtime (currently Node/npx). Windows and notarization are not provided.

To work on kabane itself, run it from a clone instead:

```bash
git clone https://github.com/davidpp/kabane.git
cd kabane && bun install
cd packages/cli && bun link                      # `kabane` on PATH, pointing at the clone
```

To release, a maintainer runs `bun run release` (or `--bump patch|minor|major`, or
`--version X.Y.Z[-beta.N]`; `--dry-run` prints the steps). It commits the version, tags it,
pushes, and starts the workflow that publishes the GitHub release and, for a stable release, the
`davidpp/tap` formula. See [`docs/release.md`](docs/release.md).
For a standalone binary, `kabane update --check` reports a candidate from GitHub releases,
and, unless Homebrew or mise owns the install, `kabane update` downloads that release's archive for your platform, verifies it against
its `SHA256SUMS`, checks that the new executable prints the candidate version, then renames it,
`templates/` and `extensions/` over the real executable (symlinks followed); any failure before that leaves
the old install as it was. On a Bun global install, both say releases moved to GitHub and print
the brew and installer commands. A stable install follows GitHub's latest release; a beta
install takes the higher of the newest beta and latest. Updates
stay within major, or minor for `0.x`; source links and unknown installs refuse replacement. The board shows `kabane <version> is out` when that candidate
exists, with what your install runs to take it: `kabane update`, `brew upgrade kabane` or `mise up <tool>`. It reads GitHub releases at most once a day and installs nothing;
`kabane config set updates.check false` turns it off. `kabane mcp` and other commands never
check, and `kabane update` opens no tracker DB and rewires no MCP entry.
After an update, `kabane doctor` reports what kabane wrote that the new version has moved past:
settings, a project's Tracker block, a harness's MCP entry, and what enabled extensions check.
`kabane doctor --fix`
repairs what needs no decision; `/doctor` in the board's copilot walks you through the rest.
Doctor opens the tracker and applies pending database migrations even without `--fix`.
Back up the database before its first run after an update; an older version may require
restoring that backup.
See [updating and data compatibility](docs/getting-started.md#updating).

## Quick start

New to kabane? Follow [`docs/getting-started.md`](docs/getting-started.md): install, run
`kabane`, wire your agents, one machine on local SQLite.

```bash
kabane
```

The first run shows one card on what kabane is, then a setup screen: your name and the
coding harnesses found on this machine that get a `kabane` MCP entry. Enter writes the
config (one machine, local SQLite), files a first issue that has your agent add kabane to
the project's `CLAUDE.md`, `AGENTS.md` or `GEMINI.md`, and opens the board; every later
`kabane` opens the board directly. Scripts and agents that run `kabane` without a terminal
still get the help text, and `kabane init --actor … --device …` remains the flag form.

Multi-device sync and the hub (a Cloudflare Worker behind Cloudflare Access, on a domain
and account of your own) are set up by following [`docs/deploy.md`](docs/deploy.md):
Cloudflare, first device, more devices, each client (Claude Code, Hermes, Codex, Claude.ai,
ChatGPT), and day-two operations. The auth decision is in [`docs/auth.md`](docs/auth.md).

## Board

`kabane board` opens the kanban on the scope the working directory resolves to. The footer
shows the everyday keys of where you are, and `?` opens a sheet along the bottom with every key
of the view you are in, then the ones that work everywhere; a key that does nothing right now
(no row selected, say) shows faint. Two of them are the copilot: `m` marks rows into a working set, and `A` opens a
one-line prompt that carries what you are looking at — the scope, the section, the filters,
the selected row, the marked set and their briefs — to a coding harness running on your
machine as you.

```
 kabane · myapp                                           · 3 marked
 next · 3
   JMYA-37  ● Checkout: retry a declined card once, then …
   JMYA-38  ● Wire the retry into the payment form
   JMYA-39    Receipts: attach the order id to every email

 copilot · claude · JMYA-31 · 3 marked · next
 ▸ verify which of these are still real todos, someday or next
```

`enter` sends it. The turn runs in the background, the board stays interactive, and the
footer carries `⠹ copilot · <last tool call>` while it goes, then `✓ copilot · <the agent's
last line>` until the next keypress. `o` opens the transcript — the session's last few turns,
each under the prompt that started it — and `x` there stops a running one.
Typing `/` first lists the shortcuts (`/triage`, `/refine`, `/split`, `/duplicates`,
`/reparent`, `/check-plan`, `/linear`, `/github`, `/setup`, `/settings`, `/doctor`), which expand into the window so you read what will be sent.
An enabled extension adds its own: the [dispatch extension](extensions/dispatch/README.md) adds
`/setup-dispatch`, which runs its setup-dispatch skill to write a project's dispatch skill for
coding sessions to turn asks into issues here.

Every write the copilot makes goes through `kabane mcp` into this device's database, stamped
`kabane://actor/agent/<harness>`, and the board reloads as each one lands. The harness is
Claude Code on Sonnet unless `~/.kabane/config.json` says otherwise — `copilot.harness`
picks `codex` or `gemini`, `copilot.model` runs the harness as something else — and
`kabane board --copilot <harness>` overrides that for one run; it has to be installed and
logged in on this machine ([`docs/deploy.md`](docs/deploy.md) part 4.7).

`enter` on a row opens its detail view. Pinned on top: the title, the task at a glance
(state, priority, kind, assignee), what is running on it, its parent, how many subtasks it
has and how many are done, what blocks it and what it blocks, the issue it links to, and any
question an agent is waiting on. Under it, four sections, one at a time: `now`, what is in
force while the work runs (the checklist, the newest handoff as a digest whose further headings
fold to one line each, the decisions made, the subtasks); `description`, the ask and its curated
context refs; `comments`, the whole timeline, newest first; and `log`, the work logged and what
agent sessions said. It opens on `now` when that has anything in it. `1`-`4` jump to a section,
`h`/`l` step through them, a click picks one, and `j/k`, `ctrl+d`/`ctrl+u` and `g`/`G` scroll
it. `r` reads the handoff in full, and `✦` marks what lands while the detail is open. The view
draws the task's records, not the agent brief; `y` still copies the brief for pasting into a
chat.

```
 JMYA-89 · Retry a declined card once    [copy]
 in progress · issue · @claude
 parent JMYA-1 Checkout rework
 subtasks 3 · 1 done
 blocked by JMYA-84 done · Payment errors…

 now  description  comments 2  log 9

 checklist · 1/3
 ✓ Reproduce the decline
 ○ Retry once on a soft decline
```

## Agent reads

Select efficient output explicitly: `kabane list --assignee codex --state next
--format concise`, `kabane search license --format concise`, and `kabane edit
JCAB-12 --state in_progress --format concise`. MCP uses `responseFormat:
"concise"` on list/search/today/add/edit/done/context. Use `kabane context <id>
--format concise` for lossless bounded context; consume all preceding chunks and
finish required description/human steering before starting work. Follow page
continuations; read full fields with `kabane_get` / `kabane show <id> --json`.
Defaults and explicit full keep legacy records and complete context briefs
(with the complete subtask rollup, including deferred and closed children). [Contracts and examples](docs/concise-reads.md)
cover byte bounds, preview markers and stale cursors.

## Gate

```bash
bun install
bun run check       # layers, oxlint, its type-aware pass, oxfmt --check, knip, jscpd
bun run typecheck   # tsc --noEmit per package
bun run test        # bun packages, then the Worker suite under vitest
```

`bun run fix` applies oxlint's fixes and oxfmt. Lefthook runs oxfmt on staged
files, both oxlint passes on staged `.ts`/`.tsx`, and `typecheck` when `.ts`
files are staged, on every commit.

Both oxlint passes deny warnings, in `bun run lint` and in lefthook, so a warning fails
the commit and the gate.

## Try a change without touching your own device

```bash
bun run sandbox                # first-run setup, then the board, on a throwaway device
bun run sandbox list           # any kabane command, inside the sandbox's git repo
bun run sandbox --fresh        # start over
bun run sandbox --harnesses    # also let setup install into harness configs under the sandbox
bun run sandbox --scripted board  # the board, its copilot on a scripted agent instead of a harness
```

The sandbox is its own `KABANE_HOME` plus a seeded git repo in the system temp directory,
one per checkout. By default setup finds no agents, so nothing is registered in your real
Claude Code, Codex or Gemini config. `--harnesses` gives the harnesses a sandbox HOME, so
the install step runs for real, but a harness may not be logged in there: try the copilot
without it.

The sandbox links the checkout's `extensions/loop`, `extensions/dispatch` and
`extensions/jobs` into its home, installed but not enabled.
`bun run sandbox config set extensions loop,dispatch,jobs --layer global` turns them on.

`--scripted` points the sandbox's copilot at `packages/acp/scripts/scripted-agent.ts`, an
ACP agent that needs no login and answers on cue. Open the copilot with `tab` and send
`ask form`, `ask multi`, `ask text` or `ask permission` to get each kind of ask, then answer
it and read what the agent received. `plan`, `tools` and `long` stream a plan, tool calls
and a long reply; anything else is echoed. The next run without the flag puts the copilot
back on a real harness.

To look at one surface without running anything, the gallery draws each of the board's
states from made-up props (`packages/board/src/stories`):

```bash
bun run gallery                           # a TUI: j/k the story, t the theme, w the width
bun run gallery --list                    # the stories
bun run gallery --print form-described    # one story's frame as text; --ansi for its colors
```

## License

MIT, see [`LICENSE`](LICENSE).
