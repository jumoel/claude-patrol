# Build Log

## 2026-05-03 - "Rebase onto X" quick-action: resolve conflicts and push on green

The "Rebase onto $base" button in `QuickActions` only told Claude to fetch and run `jj rebase -d <base>@origin`. If the rebase landed cleanly it was fine, but with conflicts Claude would stop after marking them and never push, leaving the user to finish by hand. Extended the button's command string to spell out the rest of the flow: resolve any conflicts via `jj status` + edit + `jj squash` (without pausing to ask), run the project's test suite, then move the bookmark and `jj git push` only if tests pass. Failing tests halt before the push and get reported instead.

## 2026-04-30 - Restart-via-wrapper-loop instead of detached respawn

Clicking "Restart now" in the web UI left the TUI broken when running interactively under `pnpm start`. The old flow rebuilt the frontend, called `destroyTui()`, spawned a `detached: true` child with `stdio: 'inherit'`, then `process.exit(0)` after 500 ms. The fatal step was the parent exiting: `pnpm` saw its child die and exited too, so the user's shell reclaimed the terminal and started drawing its prompt while the orphaned new node process - in its own session, no controlling TTY - tried to render a TUI on top of it. Two processes fighting for the same terminal, raw mode toggling between them, stdin going to the shell. Looked "borked" because it was.

Fix: keep the foreground process group alive across the restart. `pnpm start` now ends in `bash scripts/start-loop.sh`, a tiny while-loop that runs `node src/index.js`, and on exit code 42 adds `--reattach` and runs again. `restartServer()` no longer spawns anything - it builds the frontend, tears down the TUI, and `process.exit(42)`. The wrapper holds the TTY the whole time, so the shell never gets a chance to draw a prompt mid-restart. Watch mode (`src/watch.js`) supervises its child differently but had the same exit-code gap, so it now treats 42 as "relaunch with --reattach" too.

Port stickiness used to ride on `restartServer()` passing `--port <currentPort>` to the spawned child so the in-process MCP URL stayed valid. With the wrapper there's no good way to pass that. Instead, `startServer()` now treats `--reattach` without an explicit `--port` as a signal to read the previous instance's port from the PID file and pin to it (sticky-retry through the overlap window) - same end result, simpler chain of custody.

## 2026-04-30 - Maximized terminals leave the app header visible

Maximizing a terminal (TerminalCard overlay or GlobalTerminal drawer) used `fixed inset-0`, which painted over the AppShell header and stranded users on whatever page the terminal was attached to - the only way back to the dashboard was Escape, Cmd+Enter, or the Restore button. Cheap fix: the overlay now starts below the header instead of at the top of the viewport. AppShell measures the actual header element with a ResizeObserver and publishes its height as a `--app-header-height` CSS variable on `<html>`, which the two overlay rules (`shared.terminalOverlay`, `GlobalTerminal.maximized`) read via `top: var(--app-header-height, 0px)`. ResizeObserver instead of a hardcoded number so the update banner / future header changes don't require a CSS edit.

## 2026-04-30 - In-process HTTP MCP server, port-stable restarts

The patrol MCP server was a stdio child of every Claude session. With 10-20 active sessions that meant 10-20 `node mcp-server.js` processes, each holding ~30-50 MB and a frozen `PATROL_PORT` env var captured at spawn time. After a Patrol restart on a different port, every existing child kept fetching the old port, every tool call returned `ECONNREFUSED`, and `/mcp` still showed "connected" because the stdio child itself was alive. Hard to diagnose, easy to misread as "Claude can't connect."

Replaced the stdio shape with an in-process HTTP MCP endpoint mounted at `POST /mcp` in the Patrol Fastify app. `src/mcp-server.js` now exports `createMcpServer(app)` which builds an `McpServer` whose tool handlers call routes via `app.inject()` instead of HTTP loopback. The new MCP config writes `{type: "http", url: "http://127.0.0.1:<port>/mcp"}`, so spawned Claude sessions connect to the live Patrol server directly. One server, no extra processes, no port to go stale.

Restart needed two follow-ups: the URL still embeds the port, so a Patrol restart on a different port would invalidate every running Claude session's MCP config. `restartServer()` now reads the current port from the PID file and passes `--port <currentPort>` to the spawned `--reattach` instance, and `startServer()` treats an explicit `--port` as sticky - retrying the same port for up to 5 seconds across the overlap window with the dying old process instead of bumping. tmux session reattach is unchanged; what's new is that the MCP endpoint comes back at the same URL the existing sessions are already calling.

Verified end to end: HTTP probe lists 17 tools and round-trips `list_prs` and `list_workspaces`; 10 concurrent clients complete in 76 ms total against a single Patrol server; Claude with the new HTTP config calls `mcp__patrol__list_workspaces` and returns the right count; killing a server while a sticky-port replacement is starting takes ~2 s for the new instance to bind, after which MCP responds normally.

## 2026-04-30 - Remove stale root `public/` and ignore it

The repo had an untracked `public/` folder at the project root with hashed Vite build artifacts (`assets/index-*.js`, `assets/index-*.css`) from late April. Nothing serves it: `src/server.js` registers `@fastify/static` against `frontend/dist`, and Vite's source assets live at `frontend/public/`. The root folder was leftover from an earlier layout where build output landed there. Deleted it and added `/public/` to `.gitignore` so a stray build can't recreate the confusion.

## 2026-04-29 - Don't pause mid-rebase to ask about conflicts

A rebase session ended with the subagent saying "Your scoped instruction was just fetch + rebase, so I stopped here. Want me to resolve the conflicts and continue, or leave the workspace in this state for manual inspection?" - which is the wrong default. A user asking to rebase a CONFLICTING PR is asking for the conflicts to be resolved; pausing to ask defeats the entire point. Tightened the rebase section of `patrol-system-prompt.md` to spell out that "rebase the PR" includes conflict resolution and that the model should only stop on genuinely ambiguous conflicts (and even then propose a resolution rather than asking open-ended). Updated the parallel-rebase subagent example to match - the previous version put conflict handling in a trailing "if there are conflicts" sentence after a single `&&`-chained command line, which read as optional cleanup rather than part of the job.

## 2026-04-29 - Fix retrigger_checks substring filter against workflow-prefixed names

A real session showed Claude run `wait_for_checks`, see "2 failed (both smith-bench)", call `retrigger_checks(check_name: "smith-bench")`, and get `retriggered: 0` back - then fall back to retriggering without the filter. Root cause: DB check names come from GraphQL via `extractChecks` which prefixes with the workflow name (`"smith-bench / @adobe/css-tools@4.4.4"`), but `fetchFreshFailedChecks` returns raw GitHub REST names with no prefix (`"@adobe/css-tools@4.4.4"`). The retrigger handler only filtered against REST names, so a workflow-name substring matched zero entries even though `get_pr`/`wait_for_checks` showed the prefixed form. The handler now filters against both name sources (preferring REST when it matches, falling back to DB) and, when the substring matches nothing, returns `available_failed_checks` listing every failed check name plus a hint pointing at the matrix-variant naming quirk - giving Claude enough info to self-correct without an extra round-trip. Updated the MCP tool description and `patrol-system-prompt.md` to call out the dual matching surface and the recovery path.

## 2026-04-29 - Wrap remaining async ops as tasks

Extended task tracking to the four candidates noted in the previous entry: `summarizer.generateSummary`, `POST /api/workspaces/cleanup`, `createWorkspace` / `createScratchWorkspace`, and `POST /api/sessions/:id/promote`. The summarizer wraps only the actual `claude --print` call (after debounce/no-content/hash-unchanged bailouts) so the dropdown only shows real work, not skipped runs. The cleanup endpoint creates a parent task labeled with the filter (e.g. "Cleanup 3 workspaces (ci=fail)") so bulk teardown is visible alongside the individual destroy children. Workspace create wraps the post-DB-insert work (jj init, jj add, init commands), keeping the existing rollback semantics on failure. Promote wraps the entire scratch-creation + jj squash + transcript copy + session resume flow as one task so the user sees progress for what is otherwise a multi-step background op.

Verified end to end: hitting `POST /api/workspaces/:id/summarize` against a real workspace produced a `task-update` running event, then a success event 13 seconds later, both with full context attached.

## 2026-04-29 - Tasks dropdown for async background ops

Added a small in-memory task registry (`src/tasks.js`) for surfacing long-running async operations to the UI: `createTask` / `completeTask` plus a `runTask(opts, fn)` wrapper that captures returned warnings and converts thrown errors into task errors. Tasks emit a `task-update` SSE event, and a new `GET /api/tasks` returns the current snapshot (running first, then most recently completed; pruned after 5 minutes or 50 entries). Wrapped `destroyWorkspace`'s post-mark cleanup in `runTask` so users see "Destroy <name>" with status (Running / Done / Warnings / Failed) and any collected warnings. The registry is observability-only and is not persisted - on restart, the slate is empty, which is fine since the underlying ops complete regardless.

Frontend: a `useTasks()` hook seeds from `/api/tasks` and merges in `task-update` SSE events. `DashboardSummary` shows a third `StatDropdown` next to workspaces and sessions ("N running tasks" or "N recent tasks"), hidden entirely when there are no tasks.

**Other candidates worth wrapping next, found while spelunking:** (1) `summarizer.generateSummary` - calls Claude haiku, runs auto on 5-min idle and on session exit, currently invisible; (2) `workspace.cleanup` (`POST /api/workspaces/cleanup`) which destroys multiple workspaces by filter and would benefit most from progress reporting; (3) `createWorkspace` / `createScratchWorkspace`, especially when `initCommands` runs `pnpm install` or similar; (4) `session.promote`, which moves a global session into a scratch workspace.

## 2026-04-29 - Unblock event loop during workspace destroy

Workspace destroy used `rmSync` with `recursive: true` to remove the workspace directory. For workspaces with `node_modules` or other large trees, that synchronous walk pinned the Node.js event loop for several seconds, so every other API request (including `GET /api/workspaces?type=scratch` from the dashboard) stalled. The dashboard appeared to "lose" scratch workspaces because the fetch couldn't return until destroy was finished. Switched `destroyWorkspace` and `rollbackWorkspace` to `rm` from `node:fs/promises` so the directory removal yields, and moved `emitLocalChange()` inside `destroyWorkspace` right after the DB row is marked destroyed - the UI now drops the workspace from active lists immediately rather than after filesystem cleanup completes.

## 2026-04-28 - Docker Compose cleanup on workspace destroy and rollback

Extracted a shared `dockerComposeDown` helper that both `destroyWorkspace` and `rollbackWorkspace` call. Previously, `rollbackWorkspace` didn't touch Docker at all, so if `initCommands` started a compose stack and a later step failed, containers were orphaned. The helper also falls back to project-name-based cleanup when the compose file is missing but containers still exist - Docker tracks projects independently of the file on disk.

## 2026-04-27 - Visual separation between multiple stack groups

When the PR table showed multiple stacks, they rendered as one continuous block - the purple left border ran unbroken across both stacks with only a nearly-invisible 2px/30%-opacity top border between them. Replaced the old `stackBoundary` border with a separator row that creates a clear visual gap between stack groups (and between stacked and non-stacked sections). Stack view toggle still correctly hides all stack visual treatment when off.

## 2026-04-23 - Markdown copy respects stacked PR grouping

The "copy as markdown" button now nests stacked PRs by depth when stack view is active. Each stack group is separated by a blank line, and child PRs are indented under their parents. Non-stacked PRs remain flat. When stack view is off, output is unchanged.

## 2026-04-22 - Summarizer: brief executive summaries instead of verbose reports

Replaced the structured multi-section summary prompt (Purpose/Key Decisions/Current State headers, 300 words) with a 1-3 sentence executive summary format. No headers, no bullets - just a plain paragraph a busy person can glance at.

## 2026-04-22 - Fix summarizer: drop --bare flag, add diagnostic logging

The summarizer was calling `claude --print --model haiku --bare` which fails with "Not logged in" because `--bare` strips authentication context. Removed the `--bare` flag so the CLI inherits the user's auth session. Also added console.log to every silent bail-out path in `generateSummary`, `scheduleSummary`, and `getWorkspaceConversationText` - previously all skip/failure conditions returned null with zero logging.

## 2026-04-21 - Branch stack detection and stack view

Added detection of stacked branches (where a PR's base branch is another open PR's head branch). Backend now fetches `baseRefName` from GitHub GraphQL, stores it as `base_branch` in the DB, and computes stack relationships (parent, children, depth, root) across all PRs in the same repo. The main PR table shows a git-branch icon next to stacked PRs, with tree-like indentation when stack view is active. A purple "Stacks" toggle in the filter bar reorders PRs so each stack appears grouped together (base first, children in depth order). The PR detail page shows a purple banner for stacked PRs with clickable links to parent and child PRs. All state (stack view toggle) persists in the URL hash.

## 2026-03-17 - Navigate back immediately on workspace destroy

Previously clicking "Destroy" blocked the UI on the workspace detail page until the full teardown completed (killing sessions, docker cleanup, jj forget, directory removal). Now the frontend navigates back to the homepage immediately and the destroy runs in the background. The workspace list shows up right away.

## 2026-03-17 - Filter TUI status-bar output from activity detection

Claude Code's own TUI status bar (PR status, update notifications) produces periodic pty output even when idle at a prompt. This caused false working->idle cycles that reset the "dismissed" state, making sessions flip from "Idle" to "Waiting" repeatedly. Fix: strip ANSI escape sequences and only count data events with >= 10 printable characters as activity moments. Also raised MOMENT_THRESHOLD from 2 to 3 and LARGE_OUTPUT from 150 to 500 to further reduce sensitivity to small updates.

## 2026-03-17 - Disable tmux status bar to fix false activity detection

Tmux's status bar refreshes every 15 seconds by default, producing terminal output that the activity detector interprets as real work. This caused dismissed "Idle" sessions to cycle through working -> idle, clearing the dismissal and showing "Waiting" again. Fix: set `status off` on every patrol tmux session at creation time (both `createSession` and `createResumedSession`), and also during reattach for sessions created before this fix.

## 2026-03-16 - Stack and Box layout components

Created Stack and Box components under `frontend/src/components/ui/`. Stack handles all flex+gap layout (horizontal/vertical, alignment, justification, wrapping). Box handles padding, borders, border-radius, and backgrounds - absorbing the recurring card/panel pattern. Migrated 32 files across the frontend, replacing ~42 pure-layout CSS classes with Stack elements, ~10 card/container classes with Box, and slimming ~20 mixed classes by extracting their flex+gap into Stack wrappers. Consolidated fractional gap values (gap-0.5, gap-1.5, gap-2.5) to whole numbers. Net result: ~170 lines of CSS deleted, layout intent expressed directly in JSX.

## 2026-03-16 - Button and Badge component library

Created reusable Button and Badge components under `frontend/src/components/ui/`. Migrated 30+ scattered button class definitions across 9 CSS modules to the shared Button component (supports size, variant, dark mode, filled mode). Migrated 15+ badge class definitions to the shared Badge component (supports 10 colors, optional border, pulse animation). Refactored StatusBadge to use Badge internally and deleted its CSS module. Net result: ~175 lines of CSS removed, ~50 lines of component code added.

## 2026-03-16 - Simplify idle/working detection

Rewrote the session activity tracking from scratch. Was: two boolean flags (`notifiedIdle`/`notifiedActive`), two SSE event types (`session-idle`/`session-active` with `exited` flag), three frontend Sets (`idleSessions`/`idleWorkspaces`/`workingWorkspaces`), plus dead code (`dismissIdle`, `idleSessions`). Now: single `state` enum (`'working'|'idle'`), single `session-state` SSE event, single `Map<workspaceId, state>` on the frontend.

Key behaviors preserved: 30s idle threshold, 200-byte burst detection to filter tmux status bar redraws, optimistic "Working" on reattach with idle timer correction, state cleared on SSE reconnect, idle badge suppressed when user is viewing the workspace.

## 2026-03-16 - Fix idle detection false positives

Guard idle badge with `has_session` so it only renders when there's a running session. Clear client-side idle state on SSE reconnect. Increase idle threshold from 5s to 30s. PRTable cell derives display from accessor's cached sort value.

## 2026-04-20 - Fix summarizer to discover all JSONL transcripts + MCP summary tools

**Summarizer bug fix:** `gatherNewTranscripts` previously only found JSONL files linked to DB-tracked sessions, missing any sessions started outside patrol (e.g. direct `claude` CLI usage in the workspace directory). Fixed to scan the entire Claude project directory for all `.jsonl` files, using DB sessions only as a supplementary source for archived transcripts that live outside the project dir. Files are sorted by mtime so older transcripts come first. For incremental updates, the mtime cutoff still applies - only files modified since the last summary are read.

**MCP tools:** Added `get_workspace_summary` (read the current summary for a workspace) and `summarize_workspace` (trigger generation/regeneration) to the patrol MCP server.

## 2026-04-20 - Auto-generated workspace summaries

Scratch workspaces now get continuously updated summaries of what has been discussed, planned, and implemented. Summaries are generated by calling `claude --print --model haiku --bare` with session transcript content piped via stdin.

**Triggers:** Summary generation fires after 5 minutes of continuous session idle and on session exit. Manual refresh available via API and UI button. If the session becomes active again during the 5-minute countdown, the timer is cancelled.

**Cost control:** Five layers prevent unnecessary API calls: (1) 5-minute idle threshold before triggering, (2) incremental transcript reading - only JSONL files modified since `summary_updated_at` are read, not the full history, (3) SHA-256 content hash skips the Claude call if new transcript content is identical to what was last processed, (4) 5-minute debounce between runs, (5) concurrency guard prevents parallel summarization for the same workspace. The prompt for incremental updates sends only the existing summary + new conversation text, not the entire conversation history.

**Conversation-only extraction:** The summarizer uses the shared `parseTranscript()` function (extracted from the transcript API route into `src/transcripts.js`) which parses JSONL, simplifies content blocks, and tags `isHuman` messages. The summarizer then filters to only genuine human messages and assistant text blocks - all tool_use, tool_result, thinking blocks, and system-injected user messages are dropped. This drastically reduces input tokens since a typical session is 90%+ tool calls by volume.

**Backend:** New `src/summarizer.js` module uses the shared transcript parser, builds a prompt with existing summary + only new conversation text, and spawns Claude in non-interactive mode. Results stored in new `summary` and `summary_updated_at` columns on the workspaces table. New SSE event `summary-updated` pushes changes to the frontend. New endpoint `POST /api/workspaces/:id/summarize` for manual trigger. Refactored `simplifyContent`, `parseTranscript`, `resolveSessionJsonlPath`, and `claudeProjectDirForWorkspace` out of `routes/sessions.js` into shared `src/transcripts.js`.

**Frontend:** Summary card displayed in WorkspaceDetail with markdown rendering (headings, bold, code, lists). Refresh button for on-demand regeneration. Summary preview snippet in ScratchWorkspaces list. Auto-updates via SSE.

**MCP:** Added `get_session_history` and `get_session_transcript` tools to the patrol MCP server.

## 2026-03-13 - Global terminal in cmd-k command palette

When the global terminal has an active session, it appears as a "Global Terminal" entry in cmd-k with a green "active session" pill. Selecting it opens/focuses the global terminal drawer. GlobalTerminal reports session state up via `onSessionChange` callback.

## 2026-03-13 - Filter escape-only PTY output from idle detection

Tmux sends cursor positioning, show/hide, status-line redraws, and OSC title sequences through the PTY even when nothing meaningful is happening. These escape sequences were resetting the idle timer and causing false idle/active cycling. Added `hasPrintableContent()` that strips ANSI escape sequences and only counts output as activity if printable characters remain.

## 2026-03-13 - Fix stale idle indicators + idle badge in PR table

Idle state was never cleared when sessions exited or were killed - `proc.onExit` cleared the timer but didn't emit `session-active`, and `killSession` for detached sessions had no idle cleanup at all. Fixed both paths. Also added an amber "Idle" badge to the PR table's Local column and shortened the label from "Needs attention" to "Idle".

## 2026-03-13 - Browser notifications for idle terminal sessions

Server-side idle detection tracks output silence per session and emits SSE events (`session-idle`, `session-active`) with workspace context. Frontend hook (`useIdleNotification`) fires browser notifications when any session goes idle and the tab is hidden. Bell icon button in the header for notification permission. Idle sessions surface as "Needs attention" pills in the cmd-k command palette, sorted to the top. Dismisses automatically when the session resumes output or when the user navigates to the PR/workspace.

## 2026-03-13 - CLI attach command

New `claude-patrol attach [id]` subcommand that lists active sessions and attaches directly to the backing tmux session. Auto-selects when only one session exists, supports partial ID matching, and shows workspace context for multi-session selection.

## 2026-03-13 - Terminal UX improvements

- Cmd+Enter keyboard shortcut to toggle terminal maximize (shown in button label)
- Fix terminal sizing on cmd-k navigation by scheduling a post-layout fit via requestAnimationFrame

## 2026-03-12 - Promote global terminal to scratch workspace

New feature to promote a running global terminal session into a proper scratch workspace. Backend endpoint `POST /api/sessions/:id/promote` creates a jj workspace, moves uncommitted changes via `jj squash`, copies Claude session files to the new project dir, kills the old session, and restarts Claude with `--resume` in the workspace directory. Frontend adds a "Promote" button in the global terminal header with inline repo/branch form. Navigation redirects to the new workspace detail page after promotion.

## 2026-03-12 - Interactive setup wizard via web UI

Replaced the "edit JSON manually" first-run experience with a 3-step web wizard for configuring poll targets and interval. Accessible via Settings button for reconfiguration.

**What changed:**
- `src/config.js` - removed empty poll target validation, added `isConfigured()` and `getConfigPath()` exports
- `src/index.js` - server starts with empty config instead of exiting, conditional poller start, emits `local-change` SSE on config change, updates TUI header on config change
- `src/routes/config.js` - added `needs_setup` to GET response, added POST `/api/config` endpoint for writing config
- `src/routes/setup.js` (new) - backend endpoints for GitHub account/repo discovery via `gh` CLI (`/api/setup/accounts`, `/api/setup/repos`)
- `src/server.js` - registered setup routes
- `src/poller.js` - tracks `lastTargetsKey` to skip immediate re-poll when only interval changes
- `frontend/src/App.jsx` - setup mode detection, `#/setup` hash route, Settings button prop
- `frontend/src/components/SetupMode/SetupMode.jsx` (new) - 3-step wizard: accounts (checkboxes with avatars) -> repos (all/pick per account with lazy-loaded lists) -> settings (preset interval buttons + custom input). Pre-populates from existing config.
- `frontend/src/components/SetupMode/SetupMode.module.css` (new) - step indicator, preset buttons, settings card styles
- `frontend/src/components/AppShell/AppShell.jsx` - added Settings button with sliders icon
- `frontend/src/lib/api.js` - added `saveConfig()`, `fetchSetupAccounts()`, `fetchSetupRepos()`
- `frontend/src/hooks/usePRs.js` - re-fetches config on `local-change` SSE events, sets countdown directly to new interval

**Why:**
- First-run required editing JSON by hand - not a real onboarding experience. The wizard discovers GitHub accounts/repos via `gh` on the backend and presents checkboxes in the browser. Reconfiguration is accessible from the dashboard header at any time.

## 2026-03-12 - Fix xterm.js rendering: WebGL renderer, Unicode 15 graphemes, stale session cleanup

Added xterm.js addons to fix emoji rendering gaps and improve terminal performance. Also fixed stale sessions surviving server restarts.

**What changed:**
- `frontend/package.json` - added `@xterm/addon-unicode-graphemes` and `@xterm/addon-webgl` (vendored local packages)
- `frontend/src/components/Terminal/Terminal.jsx` - load UnicodeGraphemesAddon (Unicode 15 with grapheme cluster support for proper emoji width), WebglAddon (GPU-accelerated rendering with custom box-drawing glyphs), added `allowProposedApi` and `rescaleOverlappingGlyphs` terminal options
- `src/pty-manager.js` - `cleanupOrphanedSessions()` now also cleans `'detached'` sessions (previously only `'active'`), preventing stale sessions from persisting across server restarts
- `src/index.js` - added `--port` CLI flag to override config port and skip single-instance check

**Why:**
- xterm.js defaults to Unicode 6 width tables where emoji are single-cell-wide, creating visible gaps between characters in the Claude crab mascot. The unicode-graphemes addon provides Unicode 15 tables with proper double-width emoji and ZWJ sequence support.
- The DOM renderer has known limitations with glyph rendering. The WebGL renderer is GPU-accelerated and produces tighter, cleaner cells.
- The stale session bug caused terminals to show reconnect loops after server restarts because `cleanupOrphanedSessions()` only cleaned `'active'` sessions while the frontend queries both `'active'` and `'detached'`.


## 2026-03-12 - Switch from ghostty-web to xterm.js (GitHub master)

Replaced `ghostty-web` with `@xterm/xterm` + `@xterm/addon-fit` built from the xterm.js GitHub master branch. The latest npm release (6.0.0) is from December 2024 with 15+ months of unreleased fixes on master, so we vendor-build from source.

**What changed:**
- `scripts/setup-xterm.sh` (new) - clones xterm.js repo into `vendor/xterm.js`, runs `npm install` + `npm run setup` (tsgo + esbuild). Disables corepack strict mode so npm works inside our pnpm-managed repo.
- `frontend/package.json` - swapped `ghostty-web` for `file:` refs to `@xterm/xterm` and `@xterm/addon-fit` pointing at `vendor/xterm.js`
- `frontend/src/components/Terminal/Terminal.jsx` - replaced ghostty-web imports with xterm.js, removed async WASM `init()` wrapper (xterm.js needs none), added CSS import, added `attachCustomKeyEventHandler` for Shift+Enter (`\x1b[13;2u` kitty protocol sequence)
- `package.json` - added `setup:xterm` script, inlined vendor check into `start`/`watch` commands
- `src/watch.js` - vite output now forwarded to server via IPC so it renders inside the TUI instead of corrupting it. Spawns vite directly from `node_modules/.bin` instead of via `npx` (avoids npm config warnings).
- `src/index.js` - added IPC message listener for watch.js log forwarding, distinct exit code (78) for "already running" so watch mode exits cleanly instead of showing a crash message
- `.gitignore` - added `vendor/`

**Why:**
- ghostty-web is pre-1.0 and had rendering quirks. xterm.js is the industry standard with a larger ecosystem.
- The npm release is stale, but master has active development. Vendor-building pins us to a known commit and keeps builds reproducible.
- Shift+Enter is needed for Claude Code's multi-line input. xterm.js doesn't distinguish it from Enter by default - the custom key handler sends the CSI u sequence that Claude expects.

## 2026-03-12 - Watch mode with session-safe backend reloading

Added backend file watching to `pnpm watch`. When a `.js` file in `src/` changes, the server restarts with `--reattach` mode that preserves active terminal sessions instead of killing them.

**What changed:**
- `src/pty-manager.js` - added `reattachOrphanedSessions()` that finds surviving tmux sessions and re-attaches node-pty to them instead of killing them
- `src/index.js` - `--reattach` flag skips PID check, calls reattach instead of cleanup, and doesn't kill sessions on shutdown
- `src/watch.js` - watches `src/*.js` files with debouncing, restarts server with `--reattach` on changes, handles crashes gracefully
- `frontend/src/components/Terminal/Terminal.jsx` - WebSocket auto-reconnect with exponential backoff (500ms-4s), shows [Connection lost] / [Reconnected] messages in terminal

**Why:**
- Editing backend code while a Claude session is running would kill the session on server restart. The tmux sessions are independent processes that survive - we just need to re-attach to them. The browser terminal auto-reconnects to the new server and gets the replay buffer.

## 2026-03-12 - Session Transcript Persistence

Added the ability to capture, archive, and view Claude Code JSONL transcripts for patrol sessions.

**What changed:**
- `src/utils.js` - extracted `toClaudeProjectKey()` from workspace.js for shared use
- `src/paths.js` - added `transcriptsDir()` for transcript storage at `~/.local/share/claude-patrol/transcripts/`
- `src/db.js` - added `claude_project_dir` and `transcript_path` columns to sessions table
- `src/transcripts.js` (new) - `findSessionJsonl()` matches JSONL files by mtime window, `archiveTranscript()` copies them to patrol's storage
- `src/pty-manager.js` - stores `claude_project_dir` at session creation, archives transcript on session exit (with 500ms delay for flush)
- `src/workspace.js` - archives all session transcripts before Claude project folder deletion in `destroyWorkspace()`
- `src/routes/sessions.js` - `GET /api/sessions/:id/transcript` parses and returns simplified conversation entries, `GET /api/sessions/history` returns killed sessions
- `src/poller.js` - deletes archived transcript files when cleaning up stale PRs
- `frontend/src/lib/api.js` - `fetchSessionHistory()` and `fetchSessionTranscript()` wrappers
- `frontend/src/components/TranscriptViewer/` (new) - conversation viewer with search, thinking toggle, collapsible tool calls
- `frontend/src/components/PRDetail/PRDetail.jsx` - "Past Sessions" section with lazy-loaded history and inline transcript viewing
- `frontend/src/components/WorkspaceDetail/WorkspaceDetail.jsx` - same session history section

**Why:**
- Terminal ring buffers get garbage collected when sessions end, and Claude project folders get deleted with workspaces. Without archiving, all session context is lost.
- Claude Code's JSONL files contain structured conversation data (tool calls, outputs, thinking blocks) - far more useful than raw ANSI terminal bytes.
- Transcripts are archived on session exit and again before workspace destruction as a safety net.

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

## 2026-03-12 - Fix functional gaps and add FUTURE-IDEAS.md

Three bug fixes and a documentation file.

**What changed:**
- `FUTURE-IDEAS.md` - documents three deferred features (notification/alerting, session transcript persistence, automation loop) with enough context to act on later
- `src/poller.js` - `ghGraphql()` now retries up to 3 times with exponential backoff (1s/2s/4s) on transient failures (non-zero exit codes, spawn errors). JSON parse errors are not retried. All callers (`fetchPRs`, `fetchRemainingChecks`) benefit automatically.
- `src/pty-manager.js` - `createSession()` now deduplicates workspace sessions the same way it already did for global sessions. Creating a second session for the same workspace returns the existing one instead of spawning a conflicting Claude Code instance.
- `frontend/src/components/PRDetail/PRDetail.jsx` - `CheckRow` now renders all failed job logs from a workflow run instead of only the first. When a run has multiple jobs, each gets a label above its log viewer.

**Why:**
- The poller was fragile against transient GitHub API errors - a single 502 or rate limit would leave PR data stale for an entire poll interval.
- Nothing prevented multiple concurrent Claude sessions in the same worktree, which could cause conflicting edits.
- Multi-job workflow failures only showed the first job's log, hiding the other failures.
