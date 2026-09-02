# Claude Patrol

## First-time setup

Run **`pnpm run setup`** once on a fresh clone. It clones and builds the vendored `xterm.js`, runs `pnpm install` (which covers both root and the `frontend/` workspace package), and fixes node-pty's spawn-helper permissions on macOS. It is idempotent.

After that initial bootstrap, plain `pnpm install` works for both root and frontend deps - `frontend/` is a pnpm workspace (see `pnpm-workspace.yaml`). `pnpm run setup` is still the right command after pulling changes that touch the vendored xterm.js commit, or any time `vendor/xterm.js` is missing.

We do **not** use `preinstall` / `postinstall` hooks - install hooks are dangerous (they run silently on every `pnpm install`, including in CI and dependency installs), so the xterm.js bootstrap and the node-pty chmod stay gated behind the explicit `pnpm run setup` command. If you see `vite: command not found` or missing `vendor/xterm.js`, run `pnpm run setup`.

## Running the server

- **Production**: `pnpm start` (builds frontend, starts server; press space to open browser)
- **Development with rebuild on change**: `pnpm watch`
- **Testing/development**: `node src/index.js` (skips frontend build)
- Pass `--open` to auto-launch the browser on startup

## Gates

Run all four before committing; CI (`.github/workflows/ci.yml`) runs the same set on push and pull request.

- `pnpm run lint` (biome, also formatting)
- `pnpm run typecheck` (tsc over the frontend JS)
- `pnpm run test:backend` (node:test, runs under a throwaway HOME via `src/test-support/isolate-home.js`)
- `pnpm run test:frontend` (vitest)

## Workflow

- **Version control is jj.** The repo root has `.jj/` colocated with git. Use `jj` for describing, splitting and pushing; do not use `git commit` or `git push`.
- **Semantic commits**: conventional commit format (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `style:`, `test:`). Scope to the affected area when useful (e.g. `feat(poller):`, `fix(terminal):`).
- **Commit cadence**: one commit per distinct change (feature, review cycle, bug fix). Do not batch unrelated changes into a single commit.
- **Never push unless asked.** Commit locally only until the user asks for a push.
- UI verification rules live in `AGENTS.md` (Chrome DevTools MCP).
