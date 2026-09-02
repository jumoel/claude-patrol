#!/bin/bash
set -euo pipefail

# Clone or update xterm.js from GitHub, check out the tested revision, and build it
VENDOR_DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor"
XTERM_DIR="$VENDOR_DIR/xterm.js"
COMMIT="e749cb61253b9ca886a0ad9bf15f5d95c70eadf6"

mkdir -p "$VENDOR_DIR"

if [ -d "$XTERM_DIR/.git" ]; then
  echo "Updating existing xterm.js clone to $COMMIT..."
else
  echo "Cloning xterm.js..."
  git clone --depth 1 --filter=blob:none --no-checkout https://github.com/xtermjs/xterm.js.git "$XTERM_DIR"
fi

cd "$XTERM_DIR"
if ! git cat-file -e "$COMMIT^{commit}" 2>/dev/null; then
  git fetch --depth 1 origin "$COMMIT"
fi

git checkout --detach "$COMMIT"

# Disable corepack strict mode - the root project uses pnpm but xterm.js uses npm
export COREPACK_ENABLE_STRICT=0

# Defense against npm supply-chain attacks (shai-hulud, packagegate, etc).
# This project uses pnpm; the only place we shell out to npm is here, on the
# vendored xterm.js clone. Disable lifecycle scripts and pin the shell/git
# binaries so a malicious dependency cannot run arbitrary code during install.
# The explicit `npm run setup` below is still executed - that's a deliberate
# script invocation, not a lifecycle hook.
export npm_config_ignore_scripts=true
export npm_config_git=/usr/bin/git
export npm_config_shell=/bin/sh
export npm_config_script_shell=/bin/sh

echo "Installing dependencies..."
# ci installs exactly what xterm.js's lockfile pins and fails instead of rewriting it.
npm ci

echo "Building xterm.js..."
# npm run setup runs: presetup (tsgo/tsc) -> setup (esbuild) -> postsetup (demo)
# postsetup may fail (demo stuff) - that's fine
npm run setup || {
  echo "Full setup had errors, checking if core packages built..."
  # Verify the packages we need actually built
  if [ -f "$XTERM_DIR/lib/xterm.js" ] && [ -d "$XTERM_DIR/addons/addon-fit/lib" ]; then
    echo "Core packages built successfully."
  else
    echo "ERROR: Core packages did not build. Trying manual build..."
    # Fallback: try tsc + esbuild directly
    npx tsc -b ./tsconfig.all.json
    node esbuild.mjs
  fi
}

echo "xterm.js setup complete."
