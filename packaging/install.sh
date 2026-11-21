#!/bin/sh
# Installs kabane from its GitHub releases: the release's kabane/ directory as <prefix> (default
# ~/.local/share/kabane) and a link to its executable at <bin>/kabane (default ~/.local/bin).
#
#   curl -fsSL https://github.com/davidpp/kabane/releases/latest/download/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- --version 1.2.0 --prefix ~/opt/kabane --bin ~/bin
#
# Downloads this machine's archive and SHA256SUMS with curl, refuses the archive unless its SHA-256
# matches its line there, and also verifies its build provenance with `gh attestation verify` when
# an authenticated GitHub CLI is available. Run again to reinstall; `kabane update` updates it in
# place. KABANE_UPDATE_API and KABANE_UPDATE_RELEASES point it at another releases API and asset
# base, as they do for `kabane update` (docs/release.md).
set -eu

repo="davidpp/kabane"
prefix="${HOME}/.local/share/kabane"
bindir="${HOME}/.local/bin"
version=""
api="${KABANE_UPDATE_API:-https://api.github.com/repos/${repo}/releases}"
releases="${KABANE_UPDATE_RELEASES:-https://github.com/${repo}/releases/download}"

fail() {
  printf 'kabane install: %s\n' "$1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || fail "--version needs a value"; version="${2#v}"; shift 2 ;;
    --prefix) [ $# -ge 2 ] || fail "--prefix needs a value"; prefix="$2"; shift 2 ;;
    --bin) [ $# -ge 2 ] || fail "--bin needs a value"; bindir="$2"; shift 2 ;;
    -h | --help)
      printf 'usage: install.sh [--version X.Y.Z] [--prefix DIR] [--bin DIR]\n'
      exit 0
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done

for url in "$api" "$releases"; do
  case "$url" in
    https://* | http://127.0.0.1[:/]* | http://localhost[:/]* | http://\[::1\][:/]*) ;;
    *) fail "not https, nor plain http to this machine: $url" ;;
  esac
done

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux)
    os=linux
    if ldd --version 2>&1 | grep -qi musl; then
      fail "kabane's Linux builds need glibc; this system uses musl"
    fi
    ;;
  *) fail "no kabane build for $(uname -s); macOS and Linux only" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "no kabane build for $(uname -m)" ;;
esac
name="kabane-${os}-${arch}.tar.gz"

if [ -z "$version" ]; then
  # The latest release, which GitHub never makes a prerelease: `--version` installs a beta.
  version=$(curl -fsSL "${api}/latest" | sed -n 's/.*"tag_name": *"v\([^"]*\)".*/\1/p' | head -n 1) ||
    fail "could not read the latest release from ${api}/latest"
fi
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "not a release version: '${version}'" ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  fail "needs sha256sum or shasum to check the download"
fi

# Beside the prefix, so the finished directory is renamed into place on the same filesystem.
parent=$(dirname "$prefix")
mkdir -p "$parent"
work=$(mktemp -d "${parent}/.kabane-install.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

base="${releases}/v${version}"
printf 'Downloading kabane %s for %s-%s…\n' "$version" "$os" "$arch"
curl -fsSL -o "${work}/${name}" "${base}/${name}" ||
  fail "download failed: ${base}/${name} (a release before binaries has none)"
curl -fsSL -o "${work}/SHA256SUMS" "${base}/SHA256SUMS" || fail "download failed: ${base}/SHA256SUMS"
expected=$(awk -v file="$name" '$2 == file { print $1 }' "${work}/SHA256SUMS")
[ "$(printf '%s\n' "$expected" | grep -c .)" = 1 ] || fail "SHA256SUMS has no single line for ${name}"
[ "$(digest "${work}/${name}")" = "$expected" ] ||
  fail "SHA-256 mismatch: ${name} is not the archive the release published"
printf 'SHA-256 verified.\n'

if [ "$releases" != "https://github.com/${repo}/releases/download" ]; then
  printf 'Skipped provenance check: the archive did not come from GitHub.\n'
elif command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  gh attestation verify "${work}/${name}" --repo "$repo" >/dev/null ||
    fail "build provenance verification failed (gh attestation verify)"
  printf 'Build provenance verified: built by %s GitHub Actions.\n' "$repo"
else
  printf 'Skipped provenance check (needs an authenticated gh): gh attestation verify %s --repo %s\n' "$name" "$repo"
fi

tar -xzf "${work}/${name}" -C "$work"
[ -x "${work}/kabane/kabane" ] && [ -d "${work}/kabane/templates" ] || fail "${name} holds no kabane/ release directory"
installed=$("${work}/kabane/kabane" --version) || fail "the downloaded kabane does not run"
[ "$installed" = "$version" ] || fail "the downloaded kabane reports ${installed}, not ${version}"

# Only ever replace a previous install: the executable with templates/ beside it.
if [ -e "$prefix" ]; then
  [ -x "${prefix}/kabane" ] && [ -d "${prefix}/templates" ] ||
    fail "${prefix} exists and is not a kabane install; choose another --prefix"
  mv "$prefix" "${work}/previous"
fi
mv "${work}/kabane" "$prefix"
mkdir -p "$bindir"
ln -sf "${prefix}/kabane" "${bindir}/kabane"
printf 'Installed kabane %s in %s, linked at %s/kabane\n' "$installed" "$prefix" "$bindir"

case ":${PATH}:" in
  *":${bindir}:"*) ;;
  *) printf '\n%s is not on your PATH. Add it, then open a new terminal:\n  echo '\''export PATH="%s:$PATH"'\'' >> ~/.zprofile\n' "$bindir" "$bindir" ;;
esac
printf '\nRun `kabane` to set it up and open the board. `kabane update` installs a newer release.\n'
