# Claude Patrol

## Running the server

- **Production**: `pnpm start` (builds frontend, starts server; press space to open browser)
- **Testing/development**: `node src/index.js` (skips frontend build)
- Pass `--open` to auto-launch the browser on startup

## Workflow

- **Build log**: Maintain `BUILD_LOG.md` at project root. Each entry: date, what changed, why. If the change is visual, include a screenshot.
- **Semantic commits**: Use conventional commit format (`feat:`, `fix:`, `refactor:`, `chore:`, `docs:`, `style:`, `test:`). Scope to the affected area when useful (e.g. `feat(poller):`, `fix(terminal):`).
- **Commit cadence**: After each distinct change (feature, review cycle, bug fix), make a commit and update the build log. Do not batch unrelated changes into a single commit.
- **Visual changes**: When a change affects the UI, take a screenshot using Chrome Devtools MCP and include it in the build log entry.
