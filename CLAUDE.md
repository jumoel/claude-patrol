# Claude Patrol

## First-time setup

After `pnpm install`, run **`pnpm run setup`** once. This is the single command that clones and builds the vendored `xterm.js`, installs the `frontend/` package's deps, and fixes node-pty's spawn-helper permissions on macOS. It is idempotent.

We do **not** use `preinstall` / `postinstall` hooks — install hooks are dangerous (they run silently on every `pnpm install`, including in CI and dependency installs), so setup is gated behind an explicit command. If you see `vite: command not found` or missing `vendor/xterm.js`, you forgot to run `pnpm run setup`.

## Running the server

- **Production**: `pnpm start` (builds frontend, starts server; press space to open browser)
- **Testing/development**: `node src/index.js` (skips frontend build)
- Pass `--open` to auto-launch the browser on startup

## Workflow

- **Build log**: Maintain `BUILD_LOG.md` at project root. Each entry: date, what changed, why.
- **Semantic commits**: Use conventional commit format (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `style:`, `test:`). Scope to the affected area when useful (e.g. `feat(poller):`, `fix(terminal):`).
- **Commit cadence**: After each distinct change (feature, review cycle, bug fix), make a commit and update the build log. Do not batch unrelated changes into a single commit.
- **Never push**: Do not run `git push` unless the user explicitly asks for it. Commit locally only.
