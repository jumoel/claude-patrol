# 08 - CI Failure Logs

## Goal

Surface the actual output of failed CI checks so Claude and the user can see why a check failed without clicking through to GitHub Actions.

## Approach - Why NOT `gh run view --log-failed`

`gh run view --log-failed` dumps the **entire log of every failed job** - including runner setup, checkout, harden-runner, teardown, etc. On a real run this is 8000+ lines where maybe 50 are the actual failure. Every line is also tagged `UNKNOWN STEP` because `gh` can't resolve step names from downloaded log archives. Taking the last N characters doesn't help either - teardown and post-job cleanup dominate the tail.

Instead, use a two-step approach via the GitHub REST API:

1. **Get failed jobs and their failed steps** via `GET /repos/{owner}/{repo}/actions/runs/{runId}/jobs` - this returns structured data including step names and step numbers for each failed step.
2. **Get the full job log** via `GET /repos/{owner}/{repo}/actions/jobs/{jobId}/logs` - this returns the log as plain text with `##[group]` markers delineating each step.
3. **Parse and extract** only the sections between `##[group]` markers that correspond to the failed step(s). This gives you the actual command output without setup/teardown noise.

The `##[group]`/`##[endgroup]` markers in the log don't match step names exactly (e.g., step name "Check formatting" appears in the log as `##[group]Run pnpm format`), so match by step order (the Nth `##[group]Run ...` block corresponds roughly to the Nth user-defined step). Alternatively, extract the section containing `##[error]` lines and a window of context around them - this is simpler and more reliable.

## Backend

### New route: `GET /api/prs/:id/check-logs`

Add to `src/routes/checks.js`.

Steps:
1. Read the PR row from DB to get org, repo, and checks JSON
2. Filter to failed checks (FAILURE, ERROR, TIMED_OUT)
3. Extract unique run IDs from check URLs (same pattern as `retrigger`)
4. For each run ID:
   a. Call `gh api repos/{org}/{repo}/actions/runs/{runId}/jobs` to get failed job IDs and failed step info
   b. For each failed job, call `gh api repos/{org}/{repo}/actions/jobs/{jobId}/logs` to get the raw log text
   c. Parse the log: find lines containing `##[error]` and extract a context window (200 lines before each error, up to the previous `##[group]` marker)
5. Truncate each extracted section to 20,000 characters if needed
6. Return structured response

Response shape:

```json
{
  "logs": [
    {
      "run_id": "123456",
      "job_name": "lint",
      "failed_steps": ["Check formatting"],
      "log": "... extracted error context ...",
      "truncated": false
    }
  ]
}
```

Error entry shape (when API call fails or times out):

```json
{
  "run_id": "123456",
  "job_name": "lint",
  "error": "Timed out fetching logs"
}
```

If no failed checks exist, return `{ logs: [] }`.

Timeout each `gh api` call at 30 seconds.

### Log extraction algorithm

```
1. Split log into lines
2. Find all lines containing ##[error]
3. For each error line:
   a. Walk backwards to find the nearest ##[group] marker (this is the step boundary)
   b. Take from that ##[group] line through the ##[error] line
4. Deduplicate overlapping ranges
5. Join extracted sections with "..." separators
```

This skips runner setup, checkout, harden-runner, node setup, post-job cleanup, etc. - all the noise that makes raw logs unusable.

### Optional query param: `run_id`

If the user/Claude only cares about one specific run, allow `GET /api/prs/:id/check-logs?run_id=123456` to fetch just that one. Skip step 3's loop.

### MCP tool: `get_check_logs`

Add to `src/mcp-server.js`:

```
get_check_logs(id: string) -> fetches GET /api/prs/:id/check-logs
```

Note: PR IDs are strings (format: `org/repo#number`), not numbers. This applies to all existing MCP tools too - they currently use `z.number()` which is wrong and should be fixed.

Update `src/patrol-system-prompt.md`:

```
## Diagnosing CI failures

Use get_check_logs to see the actual output of failed CI steps. Logs are extracted from the relevant failing sections only (not the full job output). Use this before creating a workspace to understand what needs fixing.
```

## Frontend

### PR detail page: Expandable log viewer per failed check

Modify the existing failed checks section in `PRDetail.jsx`. Each failed check row gets an expand button that fetches and shows the log inline.

Implementation:
- Add a "View log" button next to each failed check in `CheckRow`
- On click, fetch `/api/prs/:id/check-logs?run_id=<runId>`
- Show the log in a scrollable `<pre>` block below the check row
- Style with dark background, monospace font, max-height with scroll
- Show "Truncated" warning when `truncated: true`
- Loading state while fetching

### New component: `CheckLogViewer`

```
frontend/src/components/CheckLogViewer/
  CheckLogViewer.jsx
  CheckLogViewer.module.css
```

Props: `{ log, truncated, loading, error }`

Pre-formatted log viewer. Dark background, light monospace text, scrollable with max-height. Shows truncation warning at top if applicable. Shows error message if fetch failed.

## Files

| File | Change |
|------|--------|
| `src/routes/checks.js` | Add `GET /api/prs/:id/check-logs` route with log extraction |
| `src/mcp-server.js` | Add `get_check_logs` tool |
| `src/patrol-system-prompt.md` | Document CI log diagnosis workflow |
| `frontend/src/components/PRDetail/PRDetail.jsx` | Add log expand buttons to failed checks |
| `frontend/src/components/CheckLogViewer/CheckLogViewer.jsx` | New component |
| `frontend/src/components/CheckLogViewer/CheckLogViewer.module.css` | New styles |
| `frontend/src/lib/api.js` | Add `fetchCheckLogs` function |

## Dependencies

None. Uses `gh api` via `child_process.execFile`.

## Deliverable

- Click "View log" on a failed check in the UI, see the relevant failure output inline (not 8000 lines of setup)
- Claude can call `get_check_logs` and read the actual error messages
- Logs show only the failing step context, not runner/checkout/teardown noise
