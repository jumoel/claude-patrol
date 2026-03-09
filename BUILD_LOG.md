# Build Log

## 2026-03-09T21:57:00 - Plan 01: Config and GitHub Ingestion

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

## 2026-03-09T22:15:00 - Plan 02: API and Frontend

Added Fastify REST API and React frontend with a filterable PR dashboard.

**What changed:**
- `src/server.js` - Fastify setup with CORS, SSE endpoint (with `reply.hijack()`), static file serving with SPA fallback
- `src/routes/prs.js` - GET /api/prs with query filtering, GET /api/prs/:id with proper 404, derived CI/review status
- `src/routes/sync.js` - POST /api/sync/trigger
- `src/routes/config.js` - GET /api/config (non-sensitive fields only)
- `frontend/` - React + Vite + Tailwind v4 + TanStack Table
- Components: AppShell, PRTable, FilterBar, StatusBadge - all with CSS modules using `@reference "tailwindcss"` for Tailwind v4 compatibility
- `frontend/src/hooks/usePRs.js` - SSE-driven auto-refresh
- `frontend/src/lib/time.js` - shared relative time formatter
- `frontend/src/lib/api.js` - fetch wrappers

**Why:**
- Serves the cached PR data through a dashboard UI with live updates via SSE.
- Filter bar derives options from the dataset, no extra endpoint needed.

![Dashboard empty state](screenshots/plan02-dashboard-styled.png)

## 2026-03-09T22:40:00 - Plan 03: Workspace Manager

Added jj workspace creation/destruction tied to PRs, with symlink setup and Docker cleanup.

**What changed:**
- `src/workspace.js` - create/destroy workspace logic with insert-first concurrency guard (unique partial index on active workspaces), symlink setup, sequential destroy with warnings
- `src/routes/workspaces.js` - POST/GET/DELETE /api/workspaces endpoints
- `src/db.js` - added unique partial index `idx_workspaces_active_pr` to prevent concurrent creation for the same PR
- `src/server.js` / `src/index.js` - wired workspace routes and config propagation

**Why:**
- Workspaces are the bridge between the PR dashboard and Claude sessions. Each workspace is a jj workspace checked out to the PR's branch with symlinks for Claude memory and other config.
