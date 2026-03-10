# 09 - PR Diff (MCP Only)

## Goal

Let Claude see what a PR changes without creating a workspace. This enables triage - Claude can read the diff, assess complexity, and decide whether it needs a full workspace or can give advice directly.

## Approach

Fetch the diff on demand via `gh pr diff`. No UI component - the web UI links to GitHub's diff view instead.

## Backend

### New route: `GET /api/prs/:id/diff`

Add to `src/routes/prs.js` (or a new `src/routes/diff.js`).

Steps:
1. Read the PR row from DB to get org, repo, and number
2. The PR ID is a string like `"org/repo#42"` - extract the number by splitting on `#`
3. Call `gh pr diff <number> -R org/repo` (note: the flag is `-R` or `--repo`, not `--repo=`)
4. Truncate to 100,000 characters if needed (large diffs can be massive)
5. Return as structured response

Response shape:

```json
{
  "diff": "diff --git a/src/foo.js b/src/foo.js\n...",
  "truncated": false,
  "pr_number": 42,
  "repo": "org/repo"
}
```

Optional query param:
- `name_only=true` - calls `gh pr diff <number> -R org/repo --name-only` instead, returns only filenames. Much smaller output, useful for triage.

When `name_only=true`, response shape:

```json
{
  "files": ["src/foo.js", "src/bar.js"],
  "pr_number": 42,
  "repo": "org/repo"
}
```

**Important:** `gh pr diff --stat` does NOT exist. The available flags are `--color`, `--name-only`, `--patch`, and `--web`. Do not use `--stat`.

### MCP tool: `get_pr_diff`

Add to `src/mcp-server.js`:

```
get_pr_diff(id: string, name_only?: boolean) -> fetches GET /api/prs/:id/diff[?name_only=true]
```

Single tool with an optional `name_only` parameter. Set `name_only: true` for triage (which files changed), omit it for the full diff.

Note: PR IDs are strings (format: `org/repo#number`), not numbers. The existing MCP tools incorrectly use `z.number()` for PR IDs - this should be fixed across the board.

Update `src/patrol-system-prompt.md`:

```
## Reviewing PR changes

Use get_pr_diff with name_only=true to see which files changed (fast triage). Use get_pr_diff without name_only for the full diff. These work without creating a workspace.
```

## Frontend

No new UI components. The existing GitHub link button in the PR detail header already takes the user to the PR page.

Add a "View diff" link in the PR detail header area that goes directly to `{pr.url}/files`. This is a minor tweak to `PRDetail.jsx` - an additional anchor tag next to the existing GitHub icon button.

## Files

| File | Change |
|------|--------|
| `src/routes/prs.js` (or `src/routes/diff.js`) | Add `GET /api/prs/:id/diff` route |
| `src/mcp-server.js` | Add `get_pr_diff` tool |
| `src/patrol-system-prompt.md` | Document diff review workflow |
| `frontend/src/components/PRDetail/PRDetail.jsx` | Add "View diff" link to GitHub files tab |

## Dependencies

None. Uses `gh pr diff` via `child_process.execFile`.

## Deliverable

- Claude can call `get_pr_diff(id, name_only: true)` to triage, then `get_pr_diff(id)` for full details
- PR detail page has a direct link to the GitHub diff view
- Large diffs are truncated with a warning
