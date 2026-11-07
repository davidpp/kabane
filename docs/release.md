# Releasing kabane

Kabane ships as the npm package `kabane` (requiring Bun) and standalone Unix binaries
through the Actions release flow. A release is
**human-triggered**: agents must never publish, log in, create/push tags, run a
publish-capable workflow, or configure npm/GitHub release settings. Nonpublishing local
verification and installed smoke are safe with the disposable homes described below.

The implementation is committed; the additional review was stopped at the maintainer's
request without a release/update verdict. No release version is selected by this work.
Live environment protection, trusted publishing, provenance and immutable-release behavior
remain unverified until a human performs the approved release.

## Local release (human-run)

You can release from your computer without an Actions environment, npm trusted publisher,
or OIDC. Use a clean `main` checkout with this implementation committed and pushed. GitHub
CLI must already be authenticated (`gh auth login` if needed), with repository admin access
when enabling release immutability. Let the command choose and bump the version:

```bash
bun run release:local prepare
```

Auto reads npm `latest` and inspects the complete commit range since that release's
consistent tag or registry `gitHead`. It checks the baseline's CLI version and ancestry;
missing/conflicting baselines, shallow history, more than 1000 commits, or oversized/unclear
history fail rather than guessing. Selection uses declared Conventional Commit intent, not
an automatic proof of API compatibility:

- `!`, `BREAKING CHANGE:` or `BREAKING-CHANGE:`: major, **minor during 0.x**. Auto never
  declares initial development stable 1.0.0.
- `feat:`: minor; `fix:` / `perf:`: patch. Highest severity wins.
- `docs`, `chore`, `style`, `refactor`, `test` / `tests`, and `ci`: no automatic release
  without release-affecting commits. Unknown/substantive types without declared breaking
  intent (`build`, `revert`) and unclassified merges require a deliberate override.

For a fresh release, force a semantic increment with `prepare --bump patch`, `--bump minor`,
or `--bump major`; these increment npm latest without requiring history inference. Explicit
major during 0.x means deliberately entering stable 1.0.0. Numeric `--version X.Y.Z` remains
available for deliberate selection/recovery. Do not combine selectors.

This command updates **only** the CLI version and lockfile, commits those files, runs
check/typecheck/test, builds/packs **once**, validates the archive and runs the installed
CLI/MCP smoke on those bytes. It retains the original archive, manifest, checksums, release
notes and verification record under gitignored `.releases/<selected-version>/`. The selected
version/selector/source and phase are retained in `.releases/current.json`. Repeated preparation
and publication reuse that choice; authentication handoff never increments again, even if
npm latest has already advanced during partial publication. Default notes contain
recent commit subjects for review; provide `--notes-file /path/to/reviewed-notes.md` during
fresh preparation to supply your own public notes.

After verification it enables GitHub release immutability if disabled, creates an annotated
`v<selected-version>` tag (honoring configured Git signing), and atomically pushes main plus that tag.
It never moves an existing tag. A configured signing key may require its own authentication.
**Preparation does not publish, run npm login, replace your installed Kabane, or open tracker
config/data.** These source/tag/settings writes are authorization granted by the human
running the command; agents must not execute the release flow against real accounts.

Review the retained notes and perform the real-terminal board check below using that archive,
then authenticate to npm and explicitly resume:

```bash
npm login
bun run release:local publish
```

Publication uses your local npm configuration/authentication, including interactive npm
2FA prompts. It refuses a missing/unverified artifact, changed source/tool versions, moved
remote tag, disabled immutability, conflicting assets or registry bytes. It creates the
matching GitHub draft/assets, publishes the exact retained tarball once, waits up to five
minutes for the registry to serve it with matching integrity/latest, then finalizes and verifies the immutable GitHub release. **It does not
rerun gates, build or pack.** Local publication does not claim GitHub Actions OIDC provenance.

GitHub's tag endpoint exposes **published** releases, not drafts. The publisher discovers
drafts through an authenticated push-authorized releases listing, consumes all pages within
its bound (100 releases/page, at most 10 pages), and rejects conflicting, duplicate,
malformed or incomplete metadata/pagination. A tag-route 404 alone never proves absence.
All matching asset bytes are still downloaded and hashed; API digests do not replace this.

If a tooling bug blocks an already verified release, keep its source checkout and original
archive unchanged. A separate fixed tooling checkout can use that clean `main` source root
for **publish only**, without committing source changes or rebuilding:

```bash
# HUMAN ONLY, from the original verified source checkout:
bun /path/to/fixed-tooling/scripts/release-local.ts publish --source-root "$PWD"
```

Source-root selection still requires the original manifest/proof/bytes, exact source commit,
remote tag and producer tool versions, local authentication, and enabled immutability. It is
not accepted for preparation or as an alternative to CI's protected OIDC authorization.
Retain the recovery tooling/checkpoint until publication is verified complete; only then
integrate the fix into main for future releases.

Rerun `prepare` for the same untouched prepared source to finish a failed setting/tag/push
step without rerunning successful gates/smoke or rebuilding. Rerun `publish` for matching
npm-success/GitHub-failure state to complete GitHub only. An identical completed release
is a verified no-op. Never delete the archive and rebuild after an ambiguous publication.
A failed gate/version commit may leave local source changes: inspect/fix them deliberately,
not by stashing/resetting unrelated work. Before an archive exists, auto rechecks changed
source and resumes only if it still selects the original version; once an archive exists,
restore the original source instead of replacing its bytes. After successful publication,
a new `prepare` selects the next release from the newly published baseline. Keep the selection
record; if it is missing for an older verified archive, deliberately pass its numeric
`--version` to publish. A `.releases/release.lock` prevents overlapping local commands on this
checkout; investigate a stale lock before removing it. It is not a cross-machine lock against
other publishers.

The `.releases/` directory is deliberately retained, not automatically cleaned up. Keep the
four original public assets for recovery; remove local artifacts only after a verified
successful release and an intentional retention decision.

## Beta releases

A beta is `X.Y.Z-beta.N` (`N` a non-negative integer; no other prerelease identifier) on npm
dist-tag `beta`. Only an explicit `--version` selects one. Auto and `--bump` never produce a
prerelease and keep reading npm `latest` as their baseline, so a beta never becomes the base
of a stable selection.

```bash
bun run release:local prepare --version 1.0.0-beta.0 --notes-file <reviewed notes>
npm login
bun run release:local publish
```

Everything above applies, with these differences. The version must be newer by SemVer
precedence than npm `latest` and any npm `beta` (`1.0.0-beta.10` follows `1.0.0-beta.9`),
and not older than the source. Tag, archive and retained directory keep the
`v<version>`/`kabane-<version>.tgz`/`.releases/<version>/` naming. Publication runs
`npm publish --tag beta`, never `latest`; readback requires the archive's integrity, `beta`
at or past this version and `latest` exactly as it was before publishing. The GitHub draft
is created with `--prerelease` and finalized with `--prerelease --latest=false`; final
verification also requires the prerelease flag, and immutability, asset and byte checks are
unchanged. Afterwards `npm view kabane dist-tags` shows `beta: 1.0.0-beta.0` beside the
unchanged `latest`, and the GitHub release is marked Pre-release.

The next beta is a fresh `prepare --version 1.0.0-beta.1`. Promote to stable with a fresh
`prepare --version 1.0.0` (auto never selects 1.0.0 during 0.x); it publishes on `latest`
like any stable release. `beta` keeps naming the last beta, so `bun add -g kabane@beta`
installs that older beta until another ships, while an installed beta's `kabane update`
already prefers the newer `latest`. Never move npm dist-tags by hand: the publisher reads
them as release state. The Actions route runs the same scripts on the existing
`v<version>` beta tag.

## Package and version

`packages/cli/package.json` is the only release version. Its development manifest stays
private, with a source bin and `workspace:*` dependencies. `scripts/build.ts` generates
`packages/cli/dist` containing:

- `bin/kabane.js`: Bun bundle entry, workspace and pure-JS dependencies inlined, Bun shebang
  kept, plus `bin/chunk-<hash>.js`: code-split chunks for what loads lazily (the board's TUI,
  the extensions), so a command that draws nothing never loads OpenTUI. The artifact check
  admits exactly that shape. Every official extension under `extensions/` is bundled too; the
  build fails when one of those directories is missing from the bundle, which means the CLI's
  list does not import it.
- `templates/dispatch/`, repository README and LICENSE, and generated package.json.
- Exactly pinned external `@opentui/core`, `@opentui/react` and `react`, taken from the
  board manifest. OpenTUI installs its platform-native optional dependency; React must not
  be duplicated inside the bundle. No published dependency may name `@cabane/*`.

The build carries CLI name/version/description/keywords/license/repository/homepage/bugs,
adds type/bin/files/dependencies, and derives the minimum Bun engine from `.bun-version`.
CLI `--version` and stdio MCP identify this version. Do not publish the private source
package or rebuild/repack after choosing a verified archive.

## Standalone release assets

The Actions workflow builds natively on `macos-15` (darwin-arm64), `macos-15-intel`
(darwin-x64), `ubuntu-24.04` (linux-x64 baseline) and `ubuntu-24.04-arm` (linux-arm64).
These labels follow [GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
No Windows or notarization is provided. The native build refuses a different host target,
uses its installed OpenTUI optional dependency, and records an embedded `/$bunfs/.../libopentui`
dylib/so path plus executable size in the log. Both x64 compilations use Bun's baseline target.
Project bunfig preloads and dotenv autoload are disabled at compile time.

Each `kabane-<os>-<arch>.tar.gz` contains `kabane/kabane`, `kabane/templates/<name>/`,
`kabane/README.md` and `kabane/LICENSE`. Template roots and collision handling are shared
with the npm builder. Keep the directory intact when installing. The copilot and loop still
need their harness runtime (currently Node/npx); bundling Bun does not bundle those harnesses.

Each matrix job builds once and retains its archive and source/version/Bun/hash record.
Preparation downloads this run's native artifacts, verifies their source commit, version,
Bun version and hashes against the npm manifest, then retains one combined artifact ID.
Its manifest lists all four binaries; `SHA256SUMS` covers all five archives. Linux x64 and
macOS arm64 smoke extract those downloaded bytes and run version, init/add/list and MCP
initialize/tools/list with `PATH=/usr/bin:/bin`, isolated HOME/KABANE_HOME, and hostile
project preload/dotenv files. Publication includes the binaries in existing draft conflict,
byte verification, no-overwrite and immutable finalization checks. It never rebuilds them.

The local release command still produces npm-only releases; use Actions for all-platform
binary releases. Older npm-only retained manifests remain valid for partial-release recovery.
Do not add binaries to an already published immutable release or replace retained bytes.
Binary self-update is `kabane update` ([standalone binaries](getting-started.md#standalone-binaries));
an installer, Homebrew and a mise registry entry are separate work.

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
A human must dispatch `publish: false` to prove all runner builds and retained transfer, then
check first-run setup/board in a real terminal. Manually verify MCP installation, copilot
and loop template/self-launch behavior in disposable
homes. No live release, npm/OIDC or notarization claim follows from local binary smoke.

To rehearse a binary update before a release exists, build an older and a newer binary
(the newer from a checkout whose CLI version is bumped), install the older one, and serve
the newer as a release from this machine. Two variables point the binary there instead of
npm and GitHub:

- `KABANE_UPDATE_REGISTRY` answers `GET <registry>/-/package/kabane/dist-tags` with
  `{ "latest": …, "beta": … }`.
- `KABANE_UPDATE_RELEASES` answers `GET <releases>/v<version>/SHA256SUMS` and
  `<releases>/v<version>/kabane-<os>-<arch>.tar.gz`.

Both must be `https:`, or `http:` to `127.0.0.1`, `::1` or `localhost`, including after
redirects. Run the older binary with an isolated `HOME`/`KABANE_HOME`: `kabane update
--check`, then `kabane update`, then `kabane --version`. Serve a corrupted `SHA256SUMS` once
to see it refuse with the old install untouched. The first real GitHub update after a
release, which follows the download redirect, stays a human check.

## Human-owned Actions setup (optional; before workflow publishing)

1. Review the proposed exact action pins in `.github/workflows/release.yml`, Node
   **24.21.0** and npm **12.2.0**. These versions/pins were checked against official
   distribution/registry/GitHub refs; availability is not approval to execute a release.
   Keep Bun **1.4.0** from `.bun-version`. npm trusted publishing requires CLI >=11.5.1
   and Node >=22.14.0; npm12.2.0 also requires a sufficiently recent Node24.
2. Configure GitHub environment **`npm-release`**, required reviewers and an appropriate
   self-review/bypass policy. A solo maintainer needs a reviewer arrangement that can
   actually approve their run. Restrict allowed release refs; protect tags from movement.
   Enable repository **release immutability**.
3. Configure the npm trusted publisher for public package `kabane`: owner **davidpp**,
   repository **kabane**, workflow filename **release.yml**, environment **npm-release**,
   GitHub-hosted runners. Explicitly permit **direct `npm publish`**: current npm defaults
   newly configured publishers to staged-publish permission only. No long-lived token
   fallback is provided. Public package/repository are needed for automatic provenance.
4. Only after checking those settings, set environment variable
   **`RELEASE_SETUP_CONFIRMED=true`** in `npm-release`. This is a human assertion, not
   programmatic proof that reviewers, tag protection, immutability or OIDC are configured.
   `npm whoami` is not an OIDC permission check.
5. Review compatibility and prepare notes. The pipeline compares the existing tag's commit
   but does not authenticate a maintainer signing key; signed-tag review is a human step.

The local command needs none of the Actions environment/trusted-publisher setup above.
It can enable release immutability when the human explicitly runs preparation. No agent
performs account setup or executes release operations. An accidentally auto-created unprotected
GitHub environment is not authorization: the publication script also requires confirmed
setup, a matching tag-ref event/source SHA, OIDC request permissions and no inherited npm
publish credentials.

## Human version and tag selection

The local command handles version/lock commit and annotated tag creation/push. For the
Actions route, choose the version in `packages/cli/package.json` and refresh its lockfile;
do not change the private root version or reset data. Commit the reviewed implementation
and selected release version, then a human creates/pushes the signed existing tag:

```bash
# HUMAN ONLY, after choosing/reviewing the version and source commit:
git tag -s v<version> -m "kabane <version>"
git push origin v<version>
```

The workflow never creates or pushes a missing tag. Package version, tag suffix, peeled
remote tag commit, checkout HEAD, event source SHA and installed CLI/MCP identity must
agree. Publishing a stable version must advance npm `latest` rather than downgrade it; a
beta must advance both `latest` and `beta` ([beta releases](#beta-releases)).
An already published name/version cannot be replaced, even after npm unpublish.

## Verification without publishing

Ordinary local gate:

```bash
bun install --frozen-lockfile
bun run check && bun run typecheck && bun run test
bun run smoke
```

Default smoke builds/packs a temporary archive, checks safe members, published identity,
exact externals, workspace dependencies, maps and machine-path leaks, installs into
throwaway HOME/Bun global directories/cache/KABANE_HOME, then exercises installed CLI
and stdio MCP, including concise queue/receipt/context checks and stdin-close exit.
Installation preserves the invoking user's registry/release-age settings; it does not
null out npmrc or weaken age/integrity policy. It does not open the board.

A retained nonpublishing archive and local byte round trip:

```bash
work=$(mktemp -d)
bun scripts/release.ts prepare "$work/release"
bun scripts/release.ts verify "$work/release"
bun scripts/smoke.ts --artifact-dir "$work/release"
# Existing archive only (no build/pack), for additional local checks:
bun scripts/smoke.ts --tarball "$work/release/kabane-<version>.tgz"
```

Preparation builds/packs **once** and retains archive, `manifest.json`, `SHA256SUMS` and
`release-notes.md`. The manifest records commit, tag (or null), dirty-source status,
Bun/npm versions, archive SHA256/SHA512 and notes SHA256. Dirty or branch artifacts can
be checked but are nonpromotable. Remove your disposable directory afterward; preserve it
on failure for investigation. Never substitute a rebuilt archive in partial-release recovery.

GitHub's **verified release** workflow is `workflow_dispatch` only; `publish` defaults
false. Branch verification is allowed. A human may run nonpublishing verification on an
existing tag, inspect the retained Actions artifact and review its notes/checksums. It
executes no `npm publish` (including `--dry-run`), draft/tag/release writes or OIDC exchange.
This tests artifact preparation/transfer/install, not publisher authentication.

## Human publishing run

Dispatch on the **existing `v<version>` tag ref**, with `publish=true` and reviewed public
notes. Do not dispatch a branch and substitute a different checkout ref. The workflow:

1. Frozen install and full gates on Linux; build/pack one release archive, inspect and
   upload that immutable Actions artifact identity.
2. Linux x64 and macOS arm64 jobs download **the same artifact ID**, independently verify
   hashes, and install/drive CLI+MCP from that archive without another build/pack. The standalone
   matrix also builds macOS x64 and Linux arm64; interactive-board checks remain manual.
3. The `npm-release` job waits for the configured human approval. Download **this run's
   archive** and perform the real-terminal board check before approving; a prior dry-run
   archive is not necessarily byte-identical to this run's archive.
4. Revalidate original bytes, clean source, remote tag, registry version/integrity/latest and
   release state. Prepare a draft with matching archive/manifest/checksum/notes using
   `gh release create --verify-tag`; append only missing matching draft assets, never
   overwrite remote assets.
5. Publish the **archive path**, not dist, using npm OIDC; bounded registry readback confirms
   integrity/stable-tag state. Publish the draft only afterward; verify final asset hashes
   and immutability. Notes/title can still be edited on GitHub, so the reviewed notes file
   is also an immutable asset. Checksums establish bytes, not independently trusted origin.

Only publication has GitHub contents-write/id-token-write permissions. Its package-wide
concurrency group does not cancel an in-flight publication and is separate from superseding
CI gates. Pending runs can be replaced; external publishers are not locked by Actions.
Tag protection and human setup remain important because the remote services are not an
atomic transaction.

### Manual real-terminal smoke

Use the publishing run's downloaded archive in a disposable home. Keep registry/age policy;
if blocked, inspect it rather than bypassing it. The package manager must install the
supported global bin; do not synthesize an internal-bin fallback.

```bash
# HUMAN, in a real terminal; replace the archive path with this run's original bytes:
work=$(mktemp -d)
cd "$work" && git init -q
HOME="$work/home" BUN_INSTALL="$work/bun" \
  BUN_INSTALL_GLOBAL_DIR="$work/bun/install/global" BUN_INSTALL_BIN="$work/bun/bin" \
  KABANE_HOME="$work/tracker" KABANE_HARNESSES= \
  bun add -g /absolute/path/to/kabane-<version>.tgz
HOME="$work/home" KABANE_HOME="$work/tracker" KABANE_HARNESSES= "$work/bun/bin/kabane"
```

Expect first-run card/setup/board; `q` quits. This command is not an agent authorization.

## Duplicate and partial-release recovery

- Identical npm version plus immutable matching GitHub release: verified no-op, no writes.
- Matching draft: verify each existing asset; add only missing assets, never clobber.
- npm version already exists with matching original bytes/stable-tag state: finish GitHub
  only, never republish. A later `latest` is not rolled back during older-release recovery.
- Any source/tag/version/hash/asset conflict, unknown state or unprotected final release:
  nonzero failure; investigate manually. Never unpublish/delete/move tags automatically.
- Publisher timeout/error: read committed state with a bounded retry, **no blind publish
  retry**. npm success followed by GitHub failure leaves a recoverable draft and nonzero
  partial result. Rerun failed jobs while the successful producer's original artifact is
  retained. If unavailable, recover the original hash-verified bytes from retained draft
  assets, or stop; rebuilding the same source does not recover its artifact identity.

A live human release must verify trusted-publisher token exchange, npm provenance and
integrity, protected-environment behavior, immutable GitHub assets/tag/attestation and
actual supported-platform execution. Local mocks/static workflow validation do not prove
those properties.

Official sources and pinned-Bun proof are recorded in
[`release-update-plan.md`](../wiki/release-update-plan.md). Binary updates/data rollback are
separate procedures; see [updating](getting-started.md#updating).
