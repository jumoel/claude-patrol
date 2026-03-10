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

## 2026-03-09T23:10:00 - Plan 04: Terminal Bridge

Added PTY session management with WebSocket streaming and xterm.js frontend.

**What changed:**
- `src/pty-manager.js` - PTY lifecycle via node-pty, fixed-size RingBuffer for replay (50KB, zero-alloc appends), WebSocket message validation, orphaned session cleanup on startup
- `src/routes/sessions.js` - POST/GET/DELETE /api/sessions + WebSocket upgrade at /ws/sessions/:id
- `frontend/src/components/Terminal/` - xterm.js wrapper with WebSocket connection, auto-resize via ResizeObserver
- `frontend/src/components/GlobalTerminal/` - collapsible drawer at bottom of UI, creates global session on first open
- `frontend/vite.config.js` - added WebSocket proxy for dev mode
- `src/server.js` - registered @fastify/websocket plugin and session routes

**Why:**
- Terminal bridge lets users interact with Claude CLI sessions directly from the dashboard. The ring buffer enables reattaching to running sessions with output history.

## 2026-03-10T00:00:00 - Plan 05: Integration

Wired workspace and session management into the PR dashboard. Added PR detail view, quick actions, startup validation, and health checks.

**What changed:**
- `src/startup.js` - validates gh, jj, claude CLI availability and gh auth before starting
- `src/health.js` - periodic checks (60s) verify session PIDs alive and workspace dirs exist, runs immediately on start
- `src/index.js` - added startup validation and health check wiring
- `frontend/src/App.jsx` - hash-based routing for PR detail view, DashboardSummary integration
- `frontend/src/components/DashboardSummary/` - summary stats bar (PR count, workspace count, session count, sync time)
- `frontend/src/components/PRDetail/` - full PR detail view with metadata, checks, reviews, labels. Parallel data loading for PR + workspaces.
- `frontend/src/components/WorkspaceControls/` - create/destroy with confirmation dialog
- `frontend/src/components/QuickActions/` - sends commands to terminal via WebSocket (rebase, lint fix, custom)
- `frontend/src/components/Terminal/` - added external wsRef prop so QuickActions can send commands
- `frontend/src/lib/api.js` - expanded with workspace/session/PR CRUD functions

**Why:**
- Completes the full flow: PR table -> PR detail -> create workspace -> Claude session with quick actions. Startup validation prevents a half-working server.

![Final dashboard](screenshots/plan05-dashboard-final.png)

## 2026-03-10 - Four feature batch: button fix, merge status, poll config, stale cleanup

### Feature 1: "Open in Claude" button persists after workspace creation
One-line fix in PRDetail.jsx - removed the `!workspace` guard so the button shows whenever there's no active session. The handler already checks for existing workspace before creating one.

### Feature 2: Auto-cleanup workspaces for merged/closed PRs
When the poller detects PRs that are no longer open, it now destroys their workspaces (kill sessions, docker down, jj forget, rm directory, Claude memory cleanup) before deleting the DB rows. Split into two phases: sync (transaction for upserts) then async cleanup (workspace destruction + stale row deletion).

### Feature 3: Merge/conflict status on dashboard and detail page
- Added `mergeable` field to GraphQL query and DB schema (migration via ALTER TABLE)
- New StatusBadge variants for merge status: Clean (green), Conflict (red), Unknown (gray)
- "Merge" column added to PR table, merge status badge on PR detail page

### Feature 4: Config supports `poll.orgs` + `poll.repos` + `poll.interval_seconds`
Restructured config from flat `orgs`/`poll_interval_seconds` to nested `poll` object. Supports org-level and individual repo-level polling. Repo-level polls are skipped if the repo's org is already polled. Stale deletion is scoped per-org or per-repo. Backward-compatible migration handles legacy config format.

**Files changed:** PRDetail.jsx, PRTable.jsx, StatusBadge.jsx/css, poller.js, db.js, config.js, routes/sync.js, routes/config.js, index.js, config.json, config.example.json
