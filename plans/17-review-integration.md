# 17 - Review Integration

## Goal

Wire the review feature into the existing Claude Patrol UI, MCP tools, and keyboard shortcuts so it feels like a native part of the product rather than a bolt-on.

## Navigation

### App header

Add a "Review" link to the `AppShell` header, next to the existing dashboard title/nav area. The link navigates to `#/review`.

Visual treatment: same style as existing nav. When the review queue has items, show a count badge (e.g., "Review (3)"). The count updates live via SSE.

### Hash routing

New routes:

- `#/review` - Review queue view
- `#/review?repo=billing&size=small` - Review queue with filters (same pattern as dashboard)
- `#/pr/:id?from=review` - PR detail accessed from review context (back button returns to queue)

The existing `App.jsx` hash router adds a new branch for `#/review`.

### Command palette

Add to `CommandPalette.jsx`:

- **"Review Queue"** as a pinned navigation target (always appears when searching "review")
- PRs in the review queue appear with a review badge in command palette search results
- Consider: "Review next" action that navigates to the highest-priority unreviewed PR

## Dashboard Integration

### Quick filter

Add a "Needs review" quick filter to the existing dashboard `FilterBar`. This is a meta-filter (like "Needs work") that shows PRs where the authenticated user is a requested reviewer.

This lets users see review requests without leaving the dashboard. Clicking a PR from this filtered view navigates to `#/pr/:id?from=review` so the review actions are visible.

### PR table column

Consider adding a "Review requested" indicator to the PR table. A small icon (person with question mark?) in the row for PRs where the current user is a requested reviewer. This provides at-a-glance visibility without a separate view.

Keep this subtle - the dashboard is primarily for the user's own PRs.

### Dashboard summary

The `DashboardSummary` bar could show "X pending reviews" alongside the existing PR count. Clicking it navigates to the review queue.

## PR Detail Integration

### Review actions

The "Submit Review" button (plan 16) appears in the PR detail actions row. It's always visible for PRs that aren't authored by the current user, but it's more prominent when accessed from review context (`?from=review`).

### "Review with Claude" button

Appears next to "Open in Claude" in the actions row. Different icon and color to distinguish "analyze for review" from "work on this PR."

### Back navigation

When `?from=review` is in the hash, the back button returns to `#/review` instead of `#/`. The breadcrumb changes from "Back" to "Back to reviews."

## MCP Tool Updates

### New tool: submit_review

Covered in plan 16. Enables Claude to post reviews via MCP.

### New tool: list_review_queue

Returns PRs in the user's review queue (requested + watched), with review state computed per PR:

```
list_review_queue(state?: "needs_review" | "updated" | "reviewed")
```

Response includes `review_state` per PR: `needs_review`, `updated_since_review`, or `reviewed`. Also includes `your_last_review_commit` and `head_commit_oid` so Claude can understand staleness.

### New tools: watch / unwatch

```
watch_pr(pr_id: string)
unwatch_pr(pr_id: string)
watch_repo(repo: string)      -- "org/repo" format
unwatch_repo(repo: string)
```

### Updated system prompt

Update `src/patrol-system-prompt.md` with review workflow documentation:

```markdown
## Reviewing PRs

Use list_review_queue to see PRs that need your review. PRs with state
"updated_since_review" have new commits since your last review - prioritize these.

Use get_pr_diff to read what changed. Use get_pr_comments to see existing feedback.
Use submit_review to post your review to GitHub.

When reviewing:
1. Check list_review_queue for PRs needing attention
2. Read the diff with get_pr_diff (use name_only=true first to see scope)
3. Read existing reviews with get_pr_comments
4. Analyze the changes
5. Post your review with submit_review

submit_review takes: pr_id, event (APPROVE/REQUEST_CHANGES/COMMENT), and optional body text.

Use watch_pr or watch_repo to follow PRs/repos you want to review.
Use unwatch_pr or unwatch_repo to stop following them.
```

### list_prs filter

Add a `reviewer` filter to `list_prs` that filters PRs where a specific user is a requested reviewer. This lets Claude query "what PRs need my review?" via MCP.

## Keyboard Shortcuts

### Review queue shortcuts

| Key | Action |
|-----|--------|
| `j` / `Down` | Select next PR in queue |
| `k` / `Up` | Select previous PR in queue |
| `Enter` | Open selected PR for review |
| `s` | Skip (snooze) selected PR |
| `r` | Trigger "Review with Claude" for selected PR |

### PR detail review shortcuts (when in review context)

| Key | Action |
|-----|--------|
| `a` | Open review form with "Approve" pre-selected |
| `x` | Open review form with "Request Changes" pre-selected |
| `c` | Open review form with "Comment" pre-selected |
| `w` | Toggle watch on current PR |
| `Escape` | Close review form (if open) / Go back to queue |

### Implementation

Keyboard shortcuts use `useEffect` with `keydown` event listeners, same pattern as the existing `useEscapeKey` hook. Only active when the relevant view is mounted. Modal/form state suppresses shortcuts to avoid conflicts with text input.

Guard: shortcuts only fire when no input/textarea is focused. Check `document.activeElement.tagName` before acting.

## Settings

### Review configuration

Add a "Review" section to the setup/settings view:

- **Your GitHub username** - Auto-detected via `gh api /user`, shown as read-only. Needed to identify "your" review requests.
- **Watched repos** - Multi-select of monitored repos. All open PRs in these repos appear in your review queue (regardless of whether you're a requested reviewer). This is the "review all changes" mechanism.
- **Watched PRs** - List of individually watched PRs, with "unwatch" buttons. PRs are added via "Watch" buttons on PR detail pages.
- **Auto-skip drafts** - Toggle (default: on). Draft PRs don't appear in the review queue.
- **Skip my PRs** - Toggle (default: on). PRs authored by you don't appear in the review queue.

Store in the existing `config.json` under a `review` key:

```json
{
  "review": {
    "github_user": "julian",
    "skip_drafts": true,
    "skip_own": true
  }
}
```

Watched repos and PRs are stored in the `review_watches` DB table (not config.json) so they can be managed via API and MCP tools. The config only holds preferences; the watch list is data.
```

## SSE Events

No new SSE event types needed. The existing `sync` event already triggers UI refreshes. When the poller fetches new review request data, the review queue updates automatically through the existing `usePRs` hook.

## Files Summary (Across All Review Plans)

### New files

| File | Purpose |
|------|---------|
| `frontend/src/components/ReviewQueue/ReviewQueue.jsx` | Review queue view |
| `frontend/src/components/ReviewQueue/ReviewQueue.module.css` | Queue styles |
| `frontend/src/components/ReviewForm/ReviewForm.jsx` | Review submission modal |
| `frontend/src/components/ReviewForm/ReviewForm.module.css` | Form styles |
| `frontend/src/hooks/useReviewState.js` | Hook computing per-PR review state from PR data + watches + current user |
| `src/routes/reviews.js` | POST review endpoint + watch list CRUD |

### Modified files

| File | Changes |
|------|---------|
| `src/poller.js` | Add `requested_reviewers`, `head_commit_oid`, `additions`, `deletions`, `changed_files` to GraphQL; add `commit { oid }` to reviews query |
| `src/db.js` | New columns on `prs` table (`requested_reviewers`, `head_commit_oid`, `additions`, `deletions`, `changed_files`); update reviews JSON shape to include `commit_oid`; add `review_watches` table |
| `src/server.js` | Register reviews route, add `/api/config/user` endpoint |
| `src/mcp-server.js` | Add `submit_review`, `list_review_queue`, `watch_pr`, `unwatch_pr`, `watch_repo`, `unwatch_repo` tools; add `reviewer` filter to `list_prs` |
| `frontend/src/App.jsx` | Review queue route, authenticated user state, review context routing |
| `frontend/src/components/AppShell/AppShell.jsx` | "Review" nav link with count badge |
| `frontend/src/components/PRDetail/PRDetail.jsx` | "Submit Review" + "Review with Claude" + "Watch" buttons |
| `frontend/src/components/FilterBar/FilterBar.jsx` | "Needs review" quick filter |
| `frontend/src/components/DashboardSummary/DashboardSummary.jsx` | Pending review count |
| `frontend/src/components/CommandPalette/CommandPalette.jsx` | Review queue navigation target |
| `frontend/src/lib/api.js` | `submitReview()`, `fetchAuthenticatedUser()`, `fetchWatches()`, `addWatch()`, `removeWatch()` |

## Implementation Order

1. **Poller changes** - Add `requested_reviewers`, `head_commit_oid`, diff stats, and review `commit_oid` to GraphQL query and DB schema. This is the foundation - nothing else works without the data.

2. **Authenticated user detection** - `GET /api/config/user` endpoint + frontend fetch. Needed for filtering "my" review requests and computing staleness.

3. **Watch list backend** - `review_watches` table + CRUD routes. Lightweight, no frontend yet.

4. **Review state computation** - `useReviewState` hook that takes PR data, watches, and current user, and returns per-PR state (needs_review / updated_since_review / reviewed). This is the core logic that the queue and dashboard both use.

5. **Review queue view** - `ReviewQueue` component with routing, filtering, sorting, grouped by review state. Test with real data from the poller.

6. **Watch UI** - "Watch" button on PR detail pages, "Watch all PRs" toggle in review settings, watch management in settings.

7. **Review submission** - `POST /api/prs/:id/review` backend route + `ReviewForm` frontend component. Test by posting actual reviews to GitHub.

8. **Claude analysis** - "Review with Claude" button that sends prompt to global terminal. Iterate on the prompt based on real PR analysis results.

9. **Dashboard integration** - Nav link, quick filter, summary count, command palette, staleness badges.

10. **MCP tools** - `submit_review`, `list_review_queue`, watch/unwatch tools. Done late because the API routes they wrap need to exist first.

11. **Keyboard shortcuts** - Add once the views are stable. Don't optimize the interaction before the interaction exists.

12. **Settings UI** - Review configuration panel with watched repos/PRs management. Can use API/MCP directly until this is built.
