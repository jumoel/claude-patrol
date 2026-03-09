# Build Log

## 2026-03-09: Plan 01 - Config and GitHub Ingestion

Implemented the core backend: config loading with live-reload, SQLite database with `node:sqlite` (Node 24 built-in), and GitHub PR poller via `gh api graphql`.

**What changed:**
- `src/config.js` - config loading, validation with predicate functions, `fs.watchFile` live-reload, path expansion at load time
- `src/db.js` - SQLite setup with WAL mode, all three table schemas (prs, workspaces, sessions) with CHECK constraints on status columns
- `src/poller.js` - GitHub GraphQL polling with pagination, concurrent org fetching via `Promise.allSettled`, transaction-wrapped upserts, cached prepared statements, bulk stale PR deletion
- `src/utils.js` - shared `expandPath` utility for tilde expansion
- `src/index.js` - entry point wiring config, db, and poller together

**Why:**
- Foundation for the PR dashboard. Everything else builds on this data layer.
- Used `node:sqlite` instead of `better-sqlite3` to avoid native addon builds.
- Poller uses `gh api graphql` to reuse existing `gh auth` - no separate token management.
