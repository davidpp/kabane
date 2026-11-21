# Releasing kabane

A kabane release is a GitHub release of `davidpp/kabane`: a standalone binary for each of four
Unix platforms, the curl installer `install.sh`, `SHA256SUMS`, the release manifest and its
notes, with build-provenance attestations. A stable release also commits the Homebrew formula
to `davidpp/homebrew-tap`. Homebrew, the installer and mise's `github:` backend all install from
it. Nothing is published to npm: the npm package `kabane` stops at `1.0.0-beta.0`, and
`kabane update` on a Bun install says releases moved to GitHub and prints the brew and installer
commands.

A release is **human-triggered**. Agents never run `bun run release` without `--dry-run`,
dispatch `release.yml` with `publish=true`, push release tags or change release settings. A
`publish=false` dispatch and the local checks below publish nothing and are safe.

## One command from a version to a published release

From a clean `main` checkout that matches `origin/main`, with `gh` authenticated as a
maintainer:

```bash
bun run release --dry-run                # print every step and any unmet precondition
bun run release                          # auto: Conventional Commits since the last release
bun run release --bump patch|minor|major # an explicit increment
bun run release --version 1.0.0          # an explicit version
```

Before it writes anything, the command checks:

- the tree is clean, on `main`, and `HEAD` is `origin`'s `main` (`git ls-remote`); `origin` is
  `davidpp/kabane`;
- no `v<version>` tag exists here or on `origin`, and the version is newer than the source's
  `packages/cli/package.json` and than the highest published stable release;
- release immutability is enabled on the repository;
- the `release` environment exists. A job naming a missing environment would create it,
  without protection and without the tap's deploy key.

Then it sets the version in `packages/cli/package.json`, refreshes `bun.lock`, runs
`bun run check`, `typecheck` and `test` on that tree, commits both files as
`chore: release kabane <version>`, creates the annotated tag `v<version>` (honoring configured
Git signing), pushes `main` and the tag in one atomic push, dispatches `release.yml` on the tag
with `publish=true` and the release notes, and watches that run until it ends, printing its
URL first. It finds the run by the tag's commit and the `workflow_dispatch` event, since the
pushed tag also starts a [verification run](#verification-without-publishing). There is no npm
login.

The notes come from `--notes-file <path>` (32KiB at most), or are drafted from history: the
`feat`, `fix` and `perf` subjects since the previous tag, at most 60, then a link to the compare
view. `--dry-run` prints them. A change that moves where kabane keeps data or settings, migrates
its database, or changes what it outputs gets an upgrade section under
[Updating](getting-started.md#updating) before its release, and reviewed notes link to it (for
example
[settings layers and scope pins](getting-started.md#upgrading-from-100-beta0-settings-layers-and-scope-pins)).

A step that fails stops the command and names it; the steps before it stay done. A failed gate
leaves the version edit uncommitted: `git checkout -- packages/cli/package.json bun.lock` undoes
it. A failed publishing run leaves `main` and the tag pushed: rerun its
failed jobs from the run page, or fix the cause and release the next version. Nothing moves or
deletes a tag.

### How the version is chosen

`--bump` and auto start from the highest stable `vX.Y.Z` tag that has a published GitHub
release; drafts and betas never count. With none published there is nothing to bump, and the
command asks for `--version`. Auto reads the commit range since that tag. It checks that the
tag's commit is the same here and on `origin`, that it is an ancestor of `HEAD` and that its
`packages/cli/package.json` names that version; shallow history, more than 1000 commits or
unclear history fail rather than guess. Selection uses declared Conventional Commit intent, not
a proof of API compatibility:

- `!`, `BREAKING CHANGE:` or `BREAKING-CHANGE:`: major, **minor during 0.x**. Auto never
  declares initial development stable 1.0.0: pass `--version 1.0.0`.
- `feat:`: minor; `fix:` / `perf:`: patch. Highest severity wins.
- `docs`, `chore`, `style`, `refactor`, `test` / `tests`, and `ci`: no automatic release
  without release-affecting commits. Other types (`build`, `revert`) and unclassified merges
  need an explicit `--bump`.

### Beta releases

A beta is `X.Y.Z-beta.N` (`N` a non-negative integer; no other prerelease identifier), and only
`--version` selects one. It must pass the highest published stable release, like any release.
The publishing run creates the draft with `--prerelease` and finalizes it with
`--prerelease --latest=false`, so GitHub's latest release, which Homebrew, the installer's
`latest` URL and `kabane update` on a stable install read, stays the last stable one. The tap is
left alone. Promote to stable with `--version X.Y.Z`.

## One-time setup

1. Create the GitHub environment **`release`** on `davidpp/kabane`. Add required reviewers if a
   publishing run should wait for approval; without them, `publish=true` publishes as soon as the
   checks pass. Restrict it to tag refs and protect `v*` tags from moving.
2. Enable repository **release immutability**
   (`gh api --method PUT repos/davidpp/kabane/immutable-releases`).
3. Add a deploy key with write access to `davidpp/homebrew-tap`, and store its private half as
   the secret **`HOMEBREW_TAP_DEPLOY_KEY`** of the **`release` environment**, not as a
   repository secret, so only a job in that environment reads it. Without it the `homebrew`
   job fails after a stable release and nothing else changes; rerun it once the secret exists.
4. Review the exact action pins in `.github/workflows/release.yml`. Bun comes from
   `.bun-version`; the release needs no Node or npm.

## What the publishing run does

A dispatch of `release.yml` on an existing `v<version>` tag ref with `publish=true`. Do not
dispatch a branch with `publish=true`: preparation refuses it.

1. Each of four native runners builds its archive once and retains it with a source, version,
   Bun and hash record ([standalone release assets](#standalone-release-assets)).
2. `prepare` runs the frozen install and the full gate, records the release's identity and
   notes (`scripts/release.ts prepare`), attaches the four archives and `install.sh` after
   checking their records (`scripts/release-binaries.ts`), renders `kabane.rb`, and uploads
   one Actions artifact.
3. `installed-smoke` on Linux x64 and macOS arm64 downloads **that artifact ID**, verifies its
   hashes, and drives the extracted binary with no Bun on `PATH`.
4. `attest` records build provenance for the archives and `install.sh`
   (`actions/attest-build-provenance`), which `install.sh` checks with `gh attestation verify`.
5. `publish` (environment `release`, `contents: write` only) re-verifies the bytes, the clean
   source and the remote tag's commit, and reads the release for the tag. A published release
   with identical assets is a verified no-op; one with other assets, or one that is not
   immutable, fails. Otherwise the version must pass the highest published stable release. It
   creates a draft with every asset (`gh release create --verify-tag --draft`), or adds only the
   missing ones to a matching draft, never overwriting; downloads each asset back and compares
   its SHA-256; checks the tag again; then publishes the draft and verifies it is final,
   immutable, complete and marked as its channel says.
6. `homebrew`, for a stable release only, downloads the published `SHA256SUMS` from its public
   URL, which answers only once the release is final, requires it to match this run's, and
   commits this run's `kabane.rb` to `davidpp/homebrew-tap` as `Formula/kabane.rb` (no commit
   when it already matches). It writes with the deploy key, never the repository token.

GitHub's tag endpoint shows published releases only; drafts are found through an authenticated
listing with push access, read to its last page (100 a page, at most 10 pages). Conflicting,
duplicate, malformed or incomplete listings fail; a 404 alone never proves absence. The publish
job's concurrency group never cancels a publication in flight.

## Verification without publishing

The gate, as CI runs it:

```bash
bun install --frozen-lockfile
bun run check && bun run typecheck && bun run test
bun run smoke
```

`bun run smoke` builds and packs the bundled package into a temporary archive, checks its
members, identity, exact externals and that no machine path or source map leaks, installs it
with `bun add -g` into throwaway homes and drives the CLI and stdio MCP, then the loop extension.
It checks the bundle, which no release ships; the release smoke drives the binary.

The whole release pipeline, on any branch, publishing nothing:

```bash
gh workflow run release.yml --repo davidpp/kabane --ref <branch> -f publish=false
```

A pushed `vX.Y.Z` or `vX.Y.Z-beta.N` tag runs the same. Both build the four archives, run the
gate and the installed smoke, attest, and retain the artifact; only a tag-ref dispatch with
`publish=true` reaches `publish` and `homebrew`.

The release's identity and notes, locally:

```bash
work=$(mktemp -d)
bun scripts/release.ts prepare "$work/release"
bun scripts/release.ts verify "$work/release"
rm -rf "$work"
```

The manifest records the version, commit, tag (or null), whether the source was dirty, the Bun
version and the notes' SHA-256; once the archives are attached, their SHA-256s and the
installer's. A dirty or untagged release can be checked but never published.

## Standalone release assets

The Actions workflow builds natively on `macos-15` (darwin-arm64), `macos-15-intel`
(darwin-x64), `ubuntu-24.04` (linux-x64 baseline) and `ubuntu-24.04-arm` (linux-arm64).
These labels follow [GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
No Windows or notarization is provided. The native build refuses a different host target,
uses its installed OpenTUI optional dependency, and records an embedded `/$bunfs/.../libopentui`
dylib/so path plus executable size in the log. Both x64 compilations use Bun's baseline target.
Project bunfig preloads and dotenv autoload are disabled at compile time.

Each `kabane-<os>-<arch>.tar.gz` contains `kabane/kabane`, an empty `kabane/templates/`,
`kabane/README.md` and `kabane/LICENSE`. `kabane update` in every release so far takes the
`templates/` directory for the mark of an extracted release, on the archive it downloads and
beside the executable it replaces, so the archive keeps it. Keep the directory intact when
installing. The copilot and loop still
need their harness runtime (currently Node/npx); bundling Bun does not bundle those harnesses.

Each matrix job builds once and retains its archive and source/version/Bun/hash record.
Preparation downloads this run's native artifacts, verifies their source commit, version,
Bun version and hashes against the release manifest, then retains one combined artifact ID.
Its manifest lists all four binaries; `SHA256SUMS` covers the four archives. Linux x64 and
macOS arm64 smoke extract those downloaded bytes and run version, init/add/list and MCP
initialize/tools/list with `PATH=/usr/bin:/bin`, isolated HOME/KABANE_HOME, and hostile
project preload/dotenv files. Publication includes the binaries in existing draft conflict,
byte verification, no-overwrite and immutable finalization checks. It never rebuilds them.

Do not add assets to an already published immutable release or replace retained bytes.
Binary self-update is `kabane update` ([standalone binaries](getting-started.md#standalone-binaries)).

A release with binaries also carries `install.sh`, the curl installer copied from
`packaging/install.sh` at assembly; the manifest records its SHA-256 (`installerSha256`) and
publication verifies and uploads it like the archives. `SHA256SUMS` keeps listing only the
archives. Preparation also renders `kabane.rb` from `packaging/homebrew/kabane.rb.tmpl`
(`scripts/release-formula.ts`): one url and SHA-256 per platform archive, installed under
`libexec` with `bin/kabane` linked to it. It travels in the Actions artifact, not in the
release. mise's `github:davidpp/kabane` backend takes the release archives as they are: it
picks `kabane-<os>-<arch>.tar.gz`, checks it against `SHA256SUMS` and strips the `kabane/`
directory.

Local host verification (no publishing):

```bash
mkdir .binary-check
bun scripts/build-binary.ts darwin-arm64 "$PWD/.binary-check/artifact" # choose your native target
mkdir .binary-check/extracted
tar -xzf .binary-check/artifact/kabane-darwin-arm64.tar.gz -C .binary-check/extracted
bun scripts/smoke.ts --binary "$PWD/.binary-check/extracted/kabane/kabane"
rm -rf .binary-check
```

The build requires a new output directory and refuses replacement. Smoke creates its isolated
home/repo under the system temporary directory (honoring `TMPDIR`), removes it on success
and prints its retained location on failure.
A human must dispatch `publish=false` to prove all runner builds and retained transfer, then
check first-run setup/board in a real terminal. Manually verify MCP installation, copilot
and loop template/self-launch behavior in disposable
homes. No live release or notarization claim follows from local binary smoke.

To rehearse a binary update before a release exists, build an older and a newer binary
(the newer from a checkout whose CLI version is bumped), install the older one, and serve
the newer as a release from this machine. Two variables point the binary there instead of
GitHub:

- `KABANE_UPDATE_API` stands for `https://api.github.com/repos/davidpp/kabane/releases`. It
  answers `GET <api>/latest` with `{ "tag_name": "v<version>", "draft": false, "prerelease":
  false }` and `GET <api>` with a list of those; a beta is a `"prerelease": true` entry there.
- `KABANE_UPDATE_RELEASES` answers `GET <releases>/v<version>/SHA256SUMS` and
  `<releases>/v<version>/kabane-<os>-<arch>.tar.gz`.

Both must be `https:`, or `http:` to `127.0.0.1`, `::1` or `localhost`, including after
redirects. Run the older binary with an isolated `HOME`/`KABANE_HOME`: `kabane update
--check`, then `kabane update`, then `kabane --version`. Serve a corrupted `SHA256SUMS` once
to see it refuse with the old install untouched. The first real GitHub update after a
release, which follows the download redirect, stays a human check.

## Recovery

- Identical published release: verified no-op, no writes.
- Matching draft: each existing asset's bytes are checked; only missing assets are added.
- Any source, tag, version, hash or asset conflict, or a published release that is not
  immutable: the run fails and writes nothing more. Investigate by hand; nothing deletes a
  release or moves a tag.
- A run that failed after its draft: rerun the failed jobs while the run's artifact is retained.
  A rebuild of the same source is not the same bytes, so never substitute one.

A live release still has to show the environment, immutable assets and tag, the attestations,
the tap commit and each platform's binary running. Static workflow checks and local runs do not
prove those. Binary updates and data rollback are separate; see
[updating](getting-started.md#updating).

## Main builds

A main build is kabane built from a commit of `main` rather than a release. It installs like
the standalone binary, with the repository's extensions beside it, and it follows `main`
instead of the latest or beta release. Build and install one from a clone, with Bun 1.4 or later:

```bash
git clone https://github.com/davidpp/kabane.git
cd kabane && bun install
bun run main-build
```

It fetches `origin` and builds from a temporary worktree of `origin/main`, so nothing
uncommitted in the clone gets in, whatever branch the clone is on. It builds the standalone
binary for this machine and each extension of the repository that the `extensions` setting
enables. Only once every build has succeeded does it copy the tracker database to
`$KABANE_HOME/backups/kabane-before-main-build.db` (through SQLite, so the copy is consistent
while a board or `kabane mcp` holds it open; each build overwrites the previous copy), then
install the binary at `$BUN_INSTALL/bin/kabane` (default `~/.bun/bin/kabane`, where Bun puts
`kabane` on PATH) and the extensions into `$KABANE_HOME/extensions/`. `--bin <path>` installs
the binary somewhere else.

A symlink at any of those places is a contributor's own setup, from `bun link` or
`bun run link-extensions`. The build refuses before it builds anything and names each link;
`bun run main-build --replace-links` replaces them with the build. It removes the link, never
what it points at.

The binary carries the commit it was built from, that commit's date, the clone and the clone's
`origin`:

```text
$ kabane --version
1.0.0-beta.0 (main 4a7bdfa, 2026-11-17)
```

`kabane update --check` reads `main` on that `origin` with `git ls-remote` and, when it moved,
reads main's history (commits, no file contents) into a temporary repository to count the
commits after the stamped one. It never fetches into the clone. It says the build is level, that
main is N commits past it, or that main no longer has its commit because it was rewritten. The
board shows the same thing as its update notice, read at most once an hour. `kabane update`
runs `bun run main-build` in the recorded clone, with `--bin` set to the running binary, and
fails with that build's output when it fails. When the clone is gone it says so and installs
nothing: run `bun run main-build` from another clone.

To go back to a release, install the release over the main build (the
[standalone binary](getting-started.md#standalone-binaries); remove `~/.bun/bin/kabane` first),
then build the extensions from a checkout of that release's tag and
install them ([extensions](extensions.md#build-them-from-a-kabane-checkout)). A main build may
have migrated the database past what the release reads. In that case keep the main build, or
restore a backup taken before the migration, which loses what changed since.
