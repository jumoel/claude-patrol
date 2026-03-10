# 06 - Codebase Cleanup

## Goal

Fix bugs, eliminate duplication, and tighten up patterns found during a full codebase review. This plan should be completed before plans 07-10.

## Already Fixed

- **MCP server PR ID types**: Changed `z.number()` to `z.string()` for all PR ID parameters. PR IDs are strings like `"org/repo#42"`, not numbers. Also added `encodeURIComponent` for the `get_pr` tool's URL path.

## Bugs to Fix

### 1. Failed check detection duplicated across 4 locations

The pattern `c.conclusion === 'FAILURE' || c.conclusion === 'ERROR' || c.conclusion === 'TIMED_OUT'` appears in:
- `src/routes/checks.js:25-26` (retrigger endpoint)
- `src/pr-status.js:10-11` (deriveCIStatus)
- `frontend/src/components/PRDetail/PRDetail.jsx:113-115` (investigate failures)
- `frontend/src/components/PRDetail/PRDetail.jsx:166-168` (failed checks list)

**Fix**: Export a `isFailedConclusion(conclusion)` helper from `pr-status.js`. Use it in `checks.js`. For the frontend, extract a `isFailedCheck(check)` utility in a shared frontend module.

### 2. Workspace cleanup route leaks workspace fields into formatPR output

`routes/workspaces.js:72` selects `w.id AS workspace_id, p.*`. When passed to `formatPR()`, the spread operator includes `workspace_id` as a stray field in the output. Not a functional bug (the code accesses the right fields) but a leak.

**Fix**: Select only PR columns explicitly: `SELECT w.id AS workspace_id, p.id, p.number, p.title, p.repo, p.org, p.author, p.url, p.branch, p.draft, p.mergeable, p.checks, p.reviews, p.labels, p.created_at, p.updated_at, p.synced_at`. Or extract the PR portion before passing to formatPR.

### 3. Race condition in createSession for global sessions

`pty-manager.js:116-120` checks if a global session exists in the DB and returns it if found in the sessions Map. But the process could have died between the DB query and the Map lookup. The `sessions.has()` check mitigates this partially, but if the process crashed without triggering the `onExit` handler (e.g., SIGKILL), the Map entry would be stale.

**Fix**: Before returning an existing session, verify the process is alive with `process.kill(proc.pid, 0)` wrapped in a try/catch. If the process is dead, clean up the stale entry and fall through to create a new session.

### 4. Unchecked null in destroyWorkspace

`workspace.js:190` queries PR data for the workspace but doesn't handle the case where the PR has been deleted (e.g., by the stale cleanup poller running concurrently).

**Fix**: Add a null check. If `pr` is null, use just `config.work_dir` as the main repo path (which the code already does as a fallback on line 193, but the ternary could NPE if someone refactors).

## Code Duplication to Eliminate

### 5. Shared execFile helper

`promisify(execFileCb)` is defined identically in 4 files: `poller.js`, `workspace.js`, `routes/checks.js`, `startup.js`.

**Fix**: Add to `utils.js`:
```js
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
export const execFile = promisify(execFileCb);
```

Update all 4 files to import from utils.

### 6. PR ID construction duplicated in poller

`poller.js` constructs `${org}/${repo}#${number}` in multiple places.

**Fix**: Add a `makePrId(org, repo, number)` helper to `utils.js`. Use it in the poller.

### 7. Duplicate "now" timestamp pattern

`new Date().toISOString()` is called inline 7+ times across multiple files.

**Fix**: Not worth extracting - it's a one-liner and extracting it would make the code less obvious. Skip.

## Quality Improvements

### 8. Config update pattern is fragile

Every route module has `let currentConfig = config` + `app.decorate('updateFooConfig', ...)`. Adding a new route means adding another decorator call in `index.js`.

**Fix**: Create a shared config store in `config.js` that routes import directly:
```js
let current = null;
export function getCurrentConfig() { return current; }
export function setCurrentConfig(cfg) { current = cfg; }
```

Routes import `getCurrentConfig()` instead of holding their own copy. The `configEvents.on('change')` handler in `index.js` calls `setCurrentConfig()` once. Remove all route-level `currentConfig` variables and `updateFooConfig` decorators.

### 9. Redundant syncedAtRef in usePRs.js

`syncedAtRef` duplicates `syncedAt` state. The ref exists to survive across re-renders for the config fetch callback, but `syncedAt` state already persists. However, the ref is used inside a `.then()` callback where the state closure would be stale. This is actually correct - the ref is needed. Skip.

## Files

| File | Change |
|------|--------|
| `src/utils.js` | Add `execFile`, `makePrId`, `isFailedConclusion` |
| `src/pr-status.js` | Export `isFailedConclusion` |
| `src/poller.js` | Use shared `execFile` and `makePrId` |
| `src/workspace.js` | Use shared `execFile`, add null check for PR in destroy |
| `src/routes/checks.js` | Use shared `execFile` and `isFailedConclusion` |
| `src/startup.js` | Use shared `execFile` |
| `src/routes/workspaces.js` | Fix cleanup query to not leak workspace fields |
| `src/pty-manager.js` | Add process liveness check for global session reuse |
| `src/config.js` | Add shared config store |
| `src/routes/sessions.js` | Use shared config store |
| `src/routes/workspaces.js` | Use shared config store |
| `src/routes/sync.js` | Use shared config store |
| `src/routes/config.js` | Use shared config store |
| `src/index.js` | Simplify config change handler |
| `frontend/src/components/PRDetail/PRDetail.jsx` | Extract isFailedCheck utility |

## Deliverable

- No functional changes visible to the user
- All bugs fixed (stale session, null PR, MCP types)
- Reduced duplication (execFile, check detection, config pattern)
- Cleaner abstraction boundaries
