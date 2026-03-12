#!/bin/bash
set -euo pipefail

# Clone or update xterm.js from GitHub, build it
VENDOR_DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor"
XTERM_DIR="$VENDOR_DIR/xterm.js"
COMMIT="master"

mkdir -p "$VENDOR_DIR"

if [ -d "$XTERM_DIR/.git" ]; then
  echo "Updating existing xterm.js clone..."
  cd "$XTERM_DIR"
  git fetch
  git checkout "$COMMIT"
  git pull --ff-only 2>/dev/null || true
else
  echo "Cloning xterm.js..."
  git clone --depth 1 https://github.com/xtermjs/xterm.js.git "$XTERM_DIR"
fi

cd "$XTERM_DIR"

# Disable corepack strict mode - the root project uses pnpm but xterm.js uses npm
export COREPACK_ENABLE_STRICT=0

echo "Installing dependencies..."
npm install

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
