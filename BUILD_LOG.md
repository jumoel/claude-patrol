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

## 2026-03-11 - Plan 11: Scratch Workspaces

Decoupled workspaces from PRs so users can start new work without an existing PR. A "scratch workspace" picks a repo, names a branch, and creates a jj workspace. When a PR is created from that branch, the poller auto-adopts the workspace into the PR flow.

**What changed:**
- `src/db.js` - made `pr_id` nullable, added `repo` column, SQLite table recreation migration for existing DBs
- `src/workspace.js` - new `createScratchWorkspace()` function, extracted shared `runPostCreateSetup()` helper, fixed `destroyWorkspace()` to derive repo path from `workspace.repo` for scratch workspaces
- `src/poller.js` - new `adoptScratchWorkspaces()` runs after each sync, matches scratch workspace branch+repo to newly-synced PRs, cached prepared statements
- `src/routes/workspaces.js` - extended POST to accept `{repo, branch}` for scratch creation, added `type` filter to GET, added GET `/:id` endpoint, fixed LEFT JOIN for repo filter
- `src/mcp-server.js` - new `create_scratch_workspace` MCP tool
- `frontend/src/lib/api.js` - new `createScratchWorkspace()`, `fetchWorkspace()`, `fetchScratchWorkspaces()` functions
- `frontend/src/App.jsx` - hash routing for `#/workspace/:id`, scratch workspace list on dashboard, "New Work" form with repo selector and branch input
- `frontend/src/components/WorkspaceDetail/` - new component for scratch workspace detail view with terminal session management

**Why:**
- Previously all workspaces required an existing PR. This makes the tool useful for greenfield work where you want to start coding before opening a PR.

## 2026-03-11 - Plan 12: Switch from xterm.js to ghostty-web

Replaced `@xterm/xterm` + `@xterm/addon-fit` with `ghostty-web` (v0.4.0) for the terminal emulator component. ghostty-web uses Ghostty's Zig parser compiled to WASM, providing the same xterm.js-compatible API surface with canvas-based rendering.

**What changed:**
- `frontend/package.json` - swapped `@xterm/xterm` and `@xterm/addon-fit` for `ghostty-web`
- `frontend/src/components/Terminal/Terminal.jsx` - replaced xterm.js imports with ghostty-web, added async WASM init with cancellation flag pattern, removed `letterSpacing` option (not supported, was 0 anyway), removed xterm CSS import

**Why:**
- ghostty-web renders to a canvas element, which avoids xterm.js's DOM-heavy rendering. The API surface we use is small (Terminal, FitAddon, onData, onResize, write, focus, dispose) and fully supported by ghostty-web. Pre-1.0 caveat acknowledged - the risk is low given our limited API usage.

## 2026-03-11 - Add maximize buttons to terminal windows

Added a maximize/restore toggle to both the GlobalTerminal drawer and WorkspaceDetail terminal card. When maximized, the terminal fills the entire viewport (fixed positioning, z-index 40). Restore via the button or Escape key.

**What changed:**
- `frontend/src/components/GlobalTerminal/GlobalTerminal.jsx` - added `maximized` state, maximize/restore toggle button in header bar, Escape key listener, conditional `.maximized` CSS class that replaces `.drawer` positioning, hides resize handle when maximized, close button also un-maximizes
- `frontend/src/components/GlobalTerminal/GlobalTerminal.module.css` - new `.maximized` class (fixed inset-0 z-40), `.maximizeButton` styled as neutral gray pill
- `frontend/src/components/WorkspaceDetail/WorkspaceDetail.jsx` - added `maximized` state, maximize button next to Kill Session, full-viewport overlay with header bar showing workspace name, Escape key listener. Also fixed pre-existing bug: Terminal was receiving `sessionId` prop (which it ignores) instead of `wsUrl`
- `frontend/src/components/WorkspaceDetail/WorkspaceDetail.module.css` - new `.maximizeButton`, `.terminalOverlay`, `.overlayHeader`, `.overlayTitle`, `.overlayContent`, `.terminalContainer` (400px explicit height for card-embedded terminal) classes

**Why:**
- Terminal windows were constrained to a drawer or card with no way to focus on a single session. Maximizing fills the browser window so you can work in the terminal without the surrounding dashboard chrome.
- Default terminal height increased from 400px to 600px (both GlobalTerminal and WorkspaceDetail) for better usability.
- Workspace terminal is now resizable via a drag handle, matching the GlobalTerminal's existing resize behavior.

![Global terminal with maximize button](screenshots/global-terminal-maximize-button.png)
![Workspace terminal resizable](screenshots/workspace-terminal-resizable.png)

## 2026-03-11 - Extract shared hooks and CSS module

Consolidated duplicated patterns across frontend components into shared hooks and a shared CSS module. Reduced CSS bundle from 94.7KB to 89.1KB.

**What changed:**
- `frontend/src/hooks/useEscapeKey.js` - extracted from GlobalTerminal + WorkspaceDetail
- `frontend/src/hooks/useResizeHandle.js` - extracted from GlobalTerminal + WorkspaceDetail, unified delta calculation (was inconsistent between the two), returns `handleProps` spread object
- `frontend/src/hooks/useClickOutside.js` - extracted from DashboardSummary + FilterBar
- `frontend/src/hooks/useSyncEvents.js` - extracted SSE listener from PRDetail + WorkspaceDetail
- `frontend/src/styles/shared.module.css` - consolidated ~20 CSS classes duplicated across PRDetail, WorkspaceDetail, and GlobalTerminal (card, headerCard, backButton, sectionTitle, identityRow, killSessionButton, maximizeButton, destroyButton, openButton, terminalHeader/Actions/Overlay, resizeHandle/Grip/dragOverlay, loading, error)
- `frontend/src/components/PRDetail/` - imports shared styles, removed ~60 lines of duplicated CSS
- `frontend/src/components/WorkspaceDetail/` - imports shared hooks + styles, removed ~90 lines of duplicated CSS/JS
- `frontend/src/components/GlobalTerminal/` - uses useEscapeKey + useResizeHandle hooks
- `frontend/src/components/DashboardSummary/` - uses useClickOutside hook
- `frontend/src/components/FilterBar/` - uses useClickOutside hook

**Why:**
- The same CSS classes and JS patterns were copy-pasted across 3-5 components. Extracting them into shared modules means one source of truth for button styles, layout patterns, and behavioral hooks.
