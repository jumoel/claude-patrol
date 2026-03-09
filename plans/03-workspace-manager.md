# 03 - Workspace Manager

## Goal

Create and destroy persistent jj workspaces tied to PRs, with symlink setup and Docker cleanup on teardown.

## File structure

```
src/
  routes/
    workspaces.js    - workspace CRUD endpoints
  workspace.js       - workspace create/destroy/setup logic
  setup-workspace.sh - post-create setup script (symlinks)
```

## SQLite Schema Addition

```sql
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,           -- uuid
  pr_id TEXT NOT NULL REFERENCES prs(id),
  name TEXT NOT NULL,            -- jj workspace name: 'org-repo-number'
  path TEXT NOT NULL,            -- absolute path to workspace dir
  bookmark TEXT NOT NULL,        -- git branch / jj bookmark name
  status TEXT NOT NULL DEFAULT 'active',  -- active | destroyed
  created_at TEXT NOT NULL,
  destroyed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_workspaces_pr ON workspaces(pr_id);
```

## Workspace Lifecycle

### Create

1. Derive workspace name: `<org>-<repo>-<pr_number>` (e.g. `acme-api-42`)
2. Derive path: `<config.workspace_base_path>/<workspace_name>/`
3. Get the PR's branch name from GitHub (need to add `headRefName` to the GraphQL query in plan 01)
4. Run from the main repo directory:
   ```bash
   jj workspace add <path> --name <workspace_name> -r <bookmark> -R <config.main_repo_path>
   ```
5. Run post-create setup (see below)
6. Insert row into `workspaces` table

### Post-create setup

Symlinks are created inside the workspace directory. Source paths come from `config.symlinks`.

```bash
# Claude memory - symlink .claude dir into workspace root
ln -s <config.symlinks.claude_memory> <workspace_path>/.claude/memory

# JSGR token
ln -s <config.symlinks.jsgr_token> <workspace_path>/.jsgr-token
```

Before creating each symlink:
- Verify source path exists. If not, abort workspace creation entirely and return error.
- Create parent directories for the symlink target if needed.

This runs as JS code (fs.symlinkSync), not a shell script - fewer moving parts.

### Destroy

Sequential steps, each one must succeed before the next:

1. Kill any active sessions for this workspace. Query `sessions` table (from plan 04), send SIGTERM to each PID. Wait up to 5s for exit, then SIGKILL.
2. If `docker-compose.yml` or `compose.yml` exists in workspace: `docker compose down -v` (cwd set to workspace path).
3. `jj workspace forget <workspace_name> -R <config.main_repo_path>`
4. `rm -rf <workspace_path>`
5. Update SQLite: set status = 'destroyed', destroyed_at = now.

If step 3 fails (jj state inconsistent), log warning but continue with steps 4-5. The workspace dir should still be cleaned up.

No global Docker prune. `docker compose down -v` handles the workspace's own containers. Anything else is the user's problem.

## API Endpoints

**`POST /api/workspaces`**
Body: `{ pr_id: "org/repo#42" }`
Creates workspace, runs setup. Returns workspace object or error.

**`GET /api/workspaces`**
Returns all active workspaces. Optionally filter by `pr_id`.

**`DELETE /api/workspaces/:id`**
Runs full destroy sequence. Returns `{ ok: true }` or error with which step failed.

## Frontend Additions

- Workspace column in PR table: shows "Active" badge (links to workspace) or nothing
- "Create Workspace" button on PR row (only if no active workspace)
- "Destroy Workspace" button (red, with confirmation dialog)
- Workspace creation shows a loading state (jj workspace add can take a few seconds for large repos)

## Dependencies

No new dependencies. Uses `child_process.execFile` for jj and docker commands, `fs` for symlinks.

## Deliverable

- Create workspace from UI, verify symlinks exist and jj workspace is functional
- Destroy workspace from UI, verify directory gone and jj workspace forgotten
- Docker compose teardown works when applicable
