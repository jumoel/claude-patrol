# Plan: Scratch Workspaces + MCP Tools for Starting New Work

## Context

Claude Patrol is entirely PR-centric. Workspaces have a `NOT NULL` FK to `prs`, and `prs` rows only exist via the GitHub poller. There's no way to start work on something without an existing PR.

This change decouples workspaces from PRs so users can create "scratch workspaces" - pick a repo, name a branch, start working. Once a PR is created from that branch, the workspace auto-adopts into the existing PR flow.

---

## Changes

### 1. Database: Make `pr_id` nullable, add `repo` column

**File:** `src/db.js`

- Alter `workspaces` table: `pr_id` becomes nullable, add `repo TEXT` column (stores `org/repo` for scratch workspaces)
- Add migration logic (same pattern as existing column additions around line 88-97): `ALTER TABLE workspaces ADD COLUMN repo TEXT`
- Update unique index `idx_workspaces_active_pr`: currently `UNIQUE(pr_id) WHERE status = 'active'`. Scratch workspaces have no `pr_id`, so this constraint still works (NULLs are unique in SQLite). No change needed.

### 2. Backend: `createScratchWorkspace` function

**File:** `src/workspace.js`

New function alongside existing `createWorkspace`:

```
createScratchWorkspace(repo, branch, config)
```

- `repo`: `"org/repo"` format (e.g. `"myorg/myrepo"`)
- `branch`: desired branch name (e.g. `"feat/dark-mode"`)
- Steps:
  1. Parse `org` and `repo` from the `repo` param
  2. Resolve `mainRepoPath` = `config.work_dir/org/repoName`
  3. Validate main repo exists, run `ensureJjInit`
  4. Generate `id` (UUID), `name` (`scratch-{branch-slug}`), `path` (`workspace_base_path/org/repoName/scratch-{branch-slug}`)
  5. Insert into DB with `pr_id = NULL`, `repo = "org/repo"`
  6. `jj workspace add {path} --name {name} -r main@origin -R {mainRepoPath}`
  7. `jj bookmark create {branch}` in the new workspace
  8. Run symlinks + init commands (reuse existing `symlinkMemory`, `setupRepoSymlinks`, `runInitCommands`)
  9. Return workspace object

### 3. Backend: PR adoption in poller

**File:** `src/poller.js`

After upserting PRs in `syncOnce`, add adoption logic:

- Query: `SELECT * FROM workspaces WHERE pr_id IS NULL AND status = 'active'`
- For each scratch workspace, check if any newly-synced PR's `branch` matches `workspace.bookmark`
- If match found: `UPDATE workspaces SET pr_id = ?, repo = NULL WHERE id = ?`
- Log adoption: `[poller] Adopted workspace {name} for PR {prId}`

### 4. Backend: Update `destroyWorkspace`

**File:** `src/workspace.js`

Currently reads `org, repo` from the `prs` table via `workspace.pr_id`. For scratch workspaces (`pr_id IS NULL`), parse `org/repo` from `workspace.repo` column instead. The fallback path already exists (lines 187-189) but should be made explicit.

### 5. API routes: New scratch workspace endpoint

**File:** `src/routes/workspaces.js`

- **`POST /api/workspaces`**: Extend to accept either `{ pr_id }` (existing) or `{ repo, branch }` (scratch). Route to `createWorkspace` or `createScratchWorkspace` accordingly.
- **`GET /api/workspaces`**: Update queries that JOIN on `prs` to use LEFT JOIN. Add `type` filter param (`pr`, `scratch`, or omit for all). The `repo` filter should also check `workspaces.repo` for scratch workspaces.

### 6. MCP: New `create_scratch_workspace` tool

**File:** `src/mcp-server.js`

New tool following the existing pattern:
- Name: `create_scratch_workspace`
- Params: `repo` (string, required, "org/repo" format), `branch` (string, required)
- POST to `/api/workspaces` with `{ repo, branch }`
- Returns workspace object with `path`

### 7. Frontend: "New Work" button on dashboard

**File:** `frontend/src/App.jsx`

- Add a "New Work" button next to the filter bar
- On click: opens a small modal/popover with repo selector + branch name input
- Repo options: derived from the existing PR list (unique `org/repo` values) or from config (expose `poll.repos`/`poll.orgs` via `/api/config`)
- Submit calls new `createScratchWorkspace(repo, branch)` API function
- On success: navigate to `#/workspace/{workspaceId}`

**File:** `frontend/src/lib/api.js`

- New function: `createScratchWorkspace(repo, branch)` - POST `/api/workspaces` with `{ repo, branch }`
- New function: `fetchWorkspace(id)` - GET `/api/workspaces/{id}` (new route, returns single workspace)

### 8. Frontend: Scratch workspace detail view

**File:** New `frontend/src/components/WorkspaceDetail/WorkspaceDetail.jsx`

Simpler version of PRDetail:
- Header: repo name, branch name, workspace status
- Terminal: Same Terminal component, same session creation flow
- Quick actions: Same QuickActions component
- Workspace controls: Destroy button
- No checks, reviews, comments sections (no PR yet)
- When the workspace gets adopted (pr_id becomes non-null), show a link to the PR detail view

### 9. Frontend: Hash routing for workspaces

**File:** `frontend/src/App.jsx`

- Add route: `#/workspace/{workspaceId}` -> render `WorkspaceDetail`
- Dashboard: show scratch workspaces in a section below the PR table (or as a separate small list)

### 10. Frontend: Scratch workspace list on dashboard

**File:** `frontend/src/App.jsx` (or new component)

- Fetch workspaces where `pr_id IS NULL AND status = 'active'`
- Display as a compact list below the PR table: branch name, repo, created time, link to detail view
- Auto-refresh alongside PR data (or via SSE)

---

## File Summary

| File | Change |
|------|--------|
| `src/db.js` | Nullable `pr_id`, add `repo` column, migration |
| `src/workspace.js` | New `createScratchWorkspace`, update `destroyWorkspace` |
| `src/poller.js` | PR adoption logic after sync |
| `src/routes/workspaces.js` | Extend POST, update GET queries, add GET /:id |
| `src/mcp-server.js` | New `create_scratch_workspace` tool |
| `frontend/src/lib/api.js` | New API functions |
| `frontend/src/App.jsx` | "New Work" button, workspace routing, scratch list |
| `frontend/src/components/WorkspaceDetail/WorkspaceDetail.jsx` | New component (simplified PRDetail) |

---

## Verification

1. **Backend**: Start server with `node src/index.js --no-open`, create a scratch workspace via `curl -X POST localhost:3000/api/workspaces -H 'Content-Type: application/json' -d '{"repo":"org/repo","branch":"test-branch"}'`. Verify workspace directory created, jj workspace exists, bookmark set.
2. **MCP**: Open global terminal, use `create_scratch_workspace` tool. Verify Claude can create and work in the new workspace.
3. **Adoption**: Create a PR from the scratch branch (via `gh pr create`), trigger sync, verify workspace's `pr_id` gets set and it appears in the PR table.
4. **Destroy**: Destroy a scratch workspace, verify cleanup (directory removed, jj workspace forgotten, sessions killed).
5. **UI**: Click "New Work", fill in repo + branch, verify navigation to workspace detail, verify terminal works, verify scratch workspace list on dashboard.
