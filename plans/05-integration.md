# 05 - Integration

## Goal

Wire workspace and session management into the PR dashboard. Add convenience actions for common operations.

## File structure changes

```
frontend/src/
  components/
    PRDetail/
      PRDetail.jsx
      PRDetail.module.css
      PRDetail.stories.jsx
    WorkspaceControls/
      WorkspaceControls.jsx
      WorkspaceControls.module.css
      WorkspaceControls.stories.jsx
    QuickActions/
      QuickActions.jsx
      QuickActions.module.css
      QuickActions.stories.jsx
    DashboardSummary/
      DashboardSummary.jsx
      DashboardSummary.module.css
      DashboardSummary.stories.jsx
  pages/
    Dashboard.jsx        - PR table + filter bar (no styles, composes components)
    PRView.jsx           - PR detail page (no styles, composes components)
```

## PR Detail View

Clicking a PR row in the table navigates to `/pr/:id` (client-side route).

Layout:
- Left panel: PR metadata (title, repo, branch, author), checks list, reviews list, labels
- Right panel: workspace terminal (if workspace exists) or "Create Workspace" prompt
- Bottom: global terminal drawer (always available from plan 04)

Data comes from `GET /api/prs/:id` + `GET /api/workspaces?pr_id=...` + `GET /api/sessions?workspace_id=...`

### One-click flow

"Open in Claude" button on PR row or detail view:
1. Check if workspace exists for this PR
2. If not, create one (`POST /api/workspaces`)
3. Check if active session exists for this workspace
4. If not, create one (`POST /api/sessions`)
5. Attach terminal to session

Each step shows its status (creating workspace... starting session... connecting...).

## Quick Actions

Buttons that send a pre-written message to an active Claude session in the workspace.

Mechanism: the button sends a WebSocket `input` message with the command text + `\r` (enter). This is identical to the user typing it - no special API needed.

### Built-in actions

**Rebase onto main:**
```
Input: "/clear\r" then after 500ms: "Rebase this branch onto main using jj rebase -d main\r"
```

**Fix lint errors:**
```
Input: "Run the linter. Fix all errors and warnings. Show me what you changed.\r"
```

**Custom command:**
Text input + "Send" button. Types the message into the active session.

These are stored as simple `{ label, command }` objects. Later could be user-configurable in config.json (live-reloaded).

## Dashboard Summary

Top bar above the PR table:
- `X open PRs` | `Y active workspaces` | `Z running sessions` | `Last synced: 30s ago`

Data comes from existing endpoints, aggregated in the frontend. No new API needed.

## Startup Validation

Added to `src/index.js` before anything starts:

```js
// Check required tools are available
await checkCommand('gh', ['--version']);     // GitHub CLI
await checkCommand('jj', ['--version']);     // Jujutsu
await checkCommand('claude', ['--version']); // Claude CLI

// Check gh is authenticated
await checkCommand('gh', ['auth', 'status']);
```

If any check fails: log a clear error message saying what's missing and exit. Don't start a half-working server.

## Health Check

Simple process-level checks on an interval (every 60s):

- For each session with status='active' in SQLite: verify PID is still alive (`process.kill(pid, 0)`). If dead, update to 'killed'.
- For each workspace with status='active': verify directory exists. If not, update to 'destroyed'.

This catches stale state from crashes or external changes. Runs as a simple setInterval in the main process.

## Deliverable

- Complete flow: PR table -> PR detail -> create workspace -> Claude session
- Quick action buttons for rebase and lint fix
- Dashboard summary stats
- Startup validation catches missing tools
- Stale state cleaned up automatically
