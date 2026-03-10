# 07 - Review Comments

## Goal

Make PR review comments visible in both the MCP tools and the web UI, so Claude and the user can see what reviewers actually asked for without leaving the dashboard.

## Approach

Fetch review comments via `gh api` at request time rather than polling them into the database. Reviews change frequently and the data is already available through the GitHub API.

Three separate GitHub REST API endpoints are needed:

1. **`GET /repos/{owner}/{repo}/pulls/{number}/reviews`** - Review summaries (state, body if present). Not all reviews have a body - many are just state markers (APPROVED with no text).
2. **`GET /repos/{owner}/{repo}/pulls/{number}/comments`** - Inline code review comments. Returns `path`, `position` (diff-relative, NOT absolute file line number), and `body`. Each has a `pull_request_review_id` for grouping under its parent review.
3. **`GET /repos/{owner}/{repo}/issues/{number}/comments`** - General PR conversation comments (note: `issues`, not `pulls`). These are the top-level discussion comments, not inline code comments.

## Backend

### New route: `GET /api/prs/:id/comments`

Add as `src/routes/comments.js` (prs.js is already busy enough).

Steps:
1. Read the PR row from DB to get org, repo, and number (ID is string like `org/repo#42`, extract number via `#` split)
2. Fetch all three endpoints in parallel via `gh api`
3. Handle pagination: use `--paginate` flag with `gh api` to get all pages automatically (`gh api --paginate repos/...`)
4. Group inline comments under their parent review using `pull_request_review_id`
5. Return structured response

Response shape:

```json
{
  "reviews": [
    {
      "id": 123,
      "author": "reviewer-login",
      "state": "CHANGES_REQUESTED",
      "body": "Review summary text (may be empty string)",
      "submitted_at": "2026-03-10T...",
      "comments": [
        {
          "path": "src/foo.js",
          "diff_position": 42,
          "body": "This should use a Map instead of an object",
          "created_at": "2026-03-10T..."
        }
      ]
    }
  ],
  "conversation": [
    {
      "author": "some-user",
      "body": "General PR comment...",
      "created_at": "2026-03-10T..."
    }
  ]
}
```

**Important notes:**
- The `diff_position` field is the line offset within the diff hunk, NOT the absolute line number in the source file. The frontend/MCP should present it as "diff position" to avoid confusion.
- Reviews with no body will have `body: ""`. Don't filter them out - they still carry state information and may have inline comments.
- `gh api --paginate` handles pagination automatically. Both reviews and comments endpoints default to 30 items per page.

### MCP tool: `get_pr_comments`

Add to `src/mcp-server.js`:

```
get_pr_comments(id: string) -> fetches GET /api/prs/:id/comments
```

Note: PR IDs are strings, not numbers.

Update `src/patrol-system-prompt.md`:

```
## Reading review feedback

Use get_pr_comments to see what reviewers said. The response includes:
- Review summaries with their state (approved, changes_requested, etc.)
- Inline code comments with file path and diff position
- General PR conversation comments

When addressing review feedback, read the comments first, then create a workspace to make the fixes.
```

## Frontend

### PR detail page: Comments section

Add a new card below the existing Reviews section in `PRDetail.jsx`.

Two sub-sections:

**Review comments** - grouped by review, showing:
- Reviewer name + review state badge (reuse existing badge styles)
- Review body (if non-empty)
- Inline comments as a list: file path (monospace), diff position, comment body

**Conversation** - chronological list of issue-level comments:
- Author + timestamp
- Comment body (plain text, not markdown-rendered - keep it simple)

Comments are fetched on demand when the PR detail page loads (add to the existing `loadData` function). Show a loading skeleton while fetching.

**No code snippet context.** The GitHub API does not return source code around inline comments. Don't pretend it does or try to fetch it separately - just show the file path, diff position, and comment body.

### New component: `CommentsList`

```
frontend/src/components/CommentsList/
  CommentsList.jsx
  CommentsList.module.css
```

Props: `{ reviews, conversation, loading }`

Styling: monospace for file paths and diff positions. Quote-style left border for comment bodies. Review state uses existing `StatusBadge` or similar colored badges.

## Files

| File | Change |
|------|--------|
| `src/routes/comments.js` | **New** - `GET /api/prs/:id/comments` route |
| `src/server.js` | Register the new comments route |
| `src/mcp-server.js` | Add `get_pr_comments` tool |
| `src/patrol-system-prompt.md` | Document the tool in the workflow |
| `frontend/src/components/PRDetail/PRDetail.jsx` | Fetch + render comments section |
| `frontend/src/components/CommentsList/CommentsList.jsx` | **New** component |
| `frontend/src/components/CommentsList/CommentsList.module.css` | **New** styles |
| `frontend/src/lib/api.js` | Add `fetchPRComments` function |

## Dependencies

None. Uses existing `gh api` via `child_process.execFile`.

## Deliverable

- Open a PR with review comments in the UI, see the full review feedback
- Claude can call `get_pr_comments` and read what reviewers asked for
- Inline code comments show file path and diff position so Claude knows where to look
- Pagination handled correctly for PRs with many comments
