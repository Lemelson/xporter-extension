#!/usr/bin/env bash
#
# package.sh — build a clean Chrome Web Store zip for XPorter.
#
# Allowlist-based: only files that ship in the extension are added, so dev
# artifacts (.git*, the docs/ Pages source, scripts/, *.md, .DS_Store,
# .nojekyll, .github/, ...) can never leak in.
#
# Usage:  scripts/package.sh
# Output: ../xporter-v<version>.zip (next to the extension root; overwritten)
# Override the output path for testing: XPORTER_ZIP_OUT=/tmp/test.zip scripts/package.sh

set -euo pipefail

# Extension root = parent of the directory this script lives in.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v zip >/dev/null 2>&1 || { echo "ERROR: 'zip' not found in PATH" >&2; exit 1; }
command -v unzip >/dev/null 2>&1 || { echo "ERROR: 'unzip' not found in PATH" >&2; exit 1; }
command -v zipinfo >/dev/null 2>&1 || { echo "ERROR: 'zipinfo' not found in PATH" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "ERROR: 'node' not found in PATH" >&2; exit 1; }

# A Chrome Web Store archive must never be created from code that fails the
# deterministic runtime gates. Keeping this inside the only supported
# allowlist packager makes the checks mandatory instead of relying on a release
# checklist that can be forgotten.
echo "Running release checks..."
node scripts/test-all.js
node scripts/test-xlsx-libreoffice.js

# Read version from manifest.json (no jq dependency).
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -n 1)"
if [[ -z "$VERSION" ]]; then
  echo "ERROR: could not read \"version\" from manifest.json" >&2
  exit 1
fi

OUT="${XPORTER_ZIP_OUT:-$(dirname "$ROOT")/xporter-v${VERSION}.zip}"

# ---- Allowlist: everything that ships, nothing else. ----
INCLUDE_FILES=(manifest.json LICENSE THIRD_PARTY_NOTICES)
INCLUDE_DIRS=(background content popup utils icons _locales)

for f in "${INCLUDE_FILES[@]}"; do
  [[ -f "$f" ]] || { echo "ERROR: required file missing: $f" >&2; exit 1; }
done
for d in "${INCLUDE_DIRS[@]}"; do
  [[ -d "$d" ]] || { echo "ERROR: required directory missing: $d" >&2; exit 1; }
done

# Collect regular files from the allowed directories, dropping junk
# (dotfiles like .DS_Store and any stray markdown) even inside allowed dirs.
FILES=("${INCLUDE_FILES[@]}")
while IFS= read -r -d '' f; do
  FILES+=("${f#./}")
done < <(find "${INCLUDE_DIRS[@]}" -type f ! -name '.*' ! -name '*.md' -print0 | sort -z)

OUT_DIR="$(dirname "$OUT")"
OUT_NAME="$(basename "$OUT")"
TEMP_BASE="$(mktemp "${OUT_DIR}/.${OUT_NAME}.tmp.XXXXXX")"
TEMP_OUT="${TEMP_BASE}.zip"
rm -f "$TEMP_BASE"
cleanup() {
  rm -f "$TEMP_BASE" "$TEMP_OUT"
}
trap cleanup EXIT

zip -X -q "$TEMP_OUT" "${FILES[@]}"
unzip -tq "$TEMP_OUT" >/dev/null

EXPECTED_ENTRIES="$(printf '%s\n' "${FILES[@]}")"
ACTUAL_ENTRIES="$(zipinfo -1 "$TEMP_OUT")"
if [[ "$ACTUAL_ENTRIES" != "$EXPECTED_ENTRIES" ]]; then
  echo "ERROR: package contents do not match the runtime allowlist" >&2
  exit 1
fi

# The temporary archive lives beside the destination, so rename is atomic.
# A failed build or validation therefore leaves the previous good artifact
# untouched.
mv -f "$TEMP_OUT" "$OUT"
trap - EXIT

COUNT="$(zipinfo -1 "$OUT" | wc -l | tr -d ' ')"
echo "Packaged XPorter v${VERSION}"
echo "  Zip:   $OUT"
echo "  Files: $COUNT"
