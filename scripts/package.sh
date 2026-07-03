#!/usr/bin/env bash
#
# package.sh — build a clean Chrome Web Store zip for XPorter.
#
# Allowlist-based: only files that ship in the extension are added, so dev
# artifacts (.git*, docs/, scripts/, index.html, *.md, privacy-policy.html,
# .DS_Store, .nojekyll, root icon128.png, .github/, ...) can never leak in.
#
# Usage:  scripts/package.sh
# Output: ../xporter-v<version>.zip (next to the extension root; overwritten)
# Override the output path for testing: XPORTER_ZIP_OUT=/tmp/test.zip scripts/package.sh

set -euo pipefail

# Extension root = parent of the directory this script lives in.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

command -v zip >/dev/null 2>&1 || { echo "ERROR: 'zip' not found in PATH" >&2; exit 1; }

# Read version from manifest.json (no jq dependency).
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -n 1)"
if [[ -z "$VERSION" ]]; then
  echo "ERROR: could not read \"version\" from manifest.json" >&2
  exit 1
fi

OUT="${XPORTER_ZIP_OUT:-$(dirname "$ROOT")/xporter-v${VERSION}.zip}"

# ---- Allowlist: everything that ships, nothing else. ----
INCLUDE_FILES=(manifest.json LICENSE)
INCLUDE_DIRS=(background content popup utils export icons _locales)

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

rm -f "$OUT"
zip -X -q "$OUT" "${FILES[@]}"

COUNT="$(zipinfo -1 "$OUT" | wc -l | tr -d ' ')"
echo "Packaged XPorter v${VERSION}"
echo "  Zip:   $OUT"
echo "  Files: $COUNT"
