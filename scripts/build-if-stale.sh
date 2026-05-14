#!/bin/bash
set -euo pipefail

# Build the frontend only if its output is missing or stale.
# Used by `pnpm start` / `pnpm watch` so they don't redundantly rebuild
# when the user (or a previous step) just ran `pnpm run build`.
#
# Considered stale if frontend/dist/index.html is older than ANY file under
# frontend/src or any of the frontend build-config files. Cheap enough to
# run on every start; vite's own incremental cache handles the real work.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

OUT=frontend/dist/index.html
WATCH_PATHS=(frontend/src frontend/index.html frontend/vite.config.js frontend/vite.config.ts frontend/package.json)

# Filter to paths that actually exist (vite config may be .js or .ts).
existing=()
for p in "${WATCH_PATHS[@]}"; do
  [ -e "$p" ] && existing+=("$p")
done

needs_build=false
if [ ! -f "$OUT" ]; then
  needs_build=true
elif [ -n "$(find "${existing[@]}" -type f -newer "$OUT" -print -quit 2>/dev/null)" ]; then
  needs_build=true
fi

if $needs_build; then
  pnpm --filter claude-patrol-frontend build
else
  echo "frontend/dist is up-to-date — skipping build"
fi
