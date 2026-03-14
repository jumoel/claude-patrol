# 14 - Review Queue

## Goal

A dedicated view that answers "what should I review next?" - sorted by priority, filterable by repo, showing just enough context to triage without clicking through.

## How the User Gets Here

Two entry points:

1. **Navigation** - A "Review" link in the app header (alongside the existing dashboard). Route: `#/review`.
2. **Command Palette** - Cmd+K, type "review" to jump to the review queue.

The review queue is a peer of the dashboard, not a sub-view. It has its own URL, its own filters, and its own state.

## What Appears in the Queue

PRs enter the review queue through two mechanisms:

### 1. Requested reviews (automatic)

PRs where the authenticated GitHub user is a requested reviewer. These appear automatically - no configuration needed.

### 2. Watched PRs (explicit opt-in)

The user can "watch" any PR to review all changes on it, regardless of whether they're a requested reviewer. Use cases:

- You want to follow a PR in your area even though someone else is the assigned reviewer
- You want to review all PRs in a specific repo (watch the repo, not individual PRs)
- You're mentoring someone and want to review their work without being formally requested

Watch targets:

- **Individual PRs** - "Watch this PR" button on any PR detail page
- **Repos** - "Watch all PRs" toggle per repo in review settings. Every open PR in that repo appears in your queue.
- **Authors** - "Watch PRs by @author" - follow a specific contributor's work (future enhancement, not in v1)

Watched PRs show a "watching" indicator in the queue to distinguish them from requested reviews.

### Queue exclusions

The queue excludes:

- Draft PRs (unless filter explicitly includes them)
- PRs authored by the current user (you don't review your own PRs)

Note: PRs you've already reviewed are NOT excluded. They remain in the queue but move to a "Reviewed" section (see "Post-review staleness tracking" below). If new commits arrive after your review, they move back to the active section with a "Updated since your review" badge.

### Identifying the current user

Claude Patrol doesn't currently track who the authenticated user is. It uses `gh api` which inherits the `gh` CLI auth. We need to fetch the authenticated user's login once at startup via `gh api /user` and store it in the config. This is the only new auth surface.

### Requested reviewer data

The poller's GraphQL query needs two new fields:

1. `requested_reviewers` - JSON column on `prs` table, populated from the `reviewRequests` connection in the GraphQL response. Shape: `["username1", "username2"]`.

2. `head_commit_oid` - TEXT column on `prs` table, populated from `headRefOid` on the PR node. This is the SHA of the current head commit, used for staleness detection (see below).

### Watch list storage

Watched PRs and repos are stored in a new `review_watches` table:

```sql
CREATE TABLE review_watches (
  id TEXT PRIMARY KEY,          -- UUID
  type TEXT NOT NULL,           -- 'pr' or 'repo'
  target TEXT NOT NULL,         -- PR ID ("org/repo#42") or repo ("org/repo")
  created_at TEXT NOT NULL,
  UNIQUE(type, target)
);
```

This is local state, not synced to GitHub. Watching a PR in Claude Patrol doesn't request you as a reviewer on GitHub.

## Post-Review Staleness Tracking

This is the most important data model addition. When you review a PR and the author pushes new commits afterward, you need to know.

### How it works

GitHub's review objects include a `commit` field with the `oid` (SHA) of the commit the review was made against. The poller already fetches reviews with `submittedAt`. We add `commit { oid }` to the reviews query so each review records which commit it was made against.

The poller also fetches `headRefOid` on each PR (the current head commit SHA).

Staleness check (computed client-side):

```
your_last_review = pr.reviews
  .filter(r => r.reviewer === current_user)
  .sort(r => r.submitted_at)
  .last()

is_stale = your_last_review
  && your_last_review.commit_oid !== pr.head_commit_oid
```

If `is_stale` is true, the PR has new commits since your last review.

### What the poller fetches (changes to GraphQL)

```graphql
reviews(last: 10) {
  nodes {
    author { login }
    state
    submittedAt
    commit { oid }           # NEW - which commit this review was against
  }
}
headRefOid                   # NEW - current head commit SHA
additions                    # NEW - diff stats
deletions                    # NEW - diff stats
changedFiles                 # NEW - diff stats
reviewRequests(first: 10) {  # NEW - who is requested to review
  nodes {
    requestedReviewer {
      ... on User { login }
      ... on Team { name }
    }
  }
}
```

### UI treatment

- **"Updated since your review"** - Yellow badge on the PR card in the queue. This is the most important signal in the entire review feature.
- **Commit count since review** - If possible, show "3 new commits since your review." This requires comparing commit timestamps, which we can derive from the PR's `updated_at` vs the review's `submitted_at` as a rough proxy, or fetch commit count between two SHAs on demand. Start with just the badge; add commit count later.
- **Queue section ordering** - PRs with new changes since your review sort to the TOP of the queue, above unreviewed PRs. Rationale: you already have context on this PR, re-reviewing is faster than starting fresh on something new.

### Review state categories (for queue grouping)

Each PR in the queue falls into one of these states relative to the current user:

1. **Needs review** - You haven't reviewed this PR yet (requested or watched)
2. **Updated since review** - You reviewed it, but new commits have landed. Needs re-review.
3. **Reviewed** - You reviewed it and no new commits since. Done (for now).

The queue shows these as visual groups, with "Updated since review" at the top, "Needs review" in the middle, and "Reviewed" collapsed at the bottom.

## Queue Layout

The queue is a vertical list, not a table. Each item is a card showing:

```
┌─────────────────────────────────────────────────────────┐
│ feat: Add payment retry logic              acme/billing │
│ @sarah-dev · +450/-120 · 12 files · waiting 3 days     │
│ CI: pass · Reviews: 1 approved, you requested           │
│ ⚠ Updated since your review (head: abc123)              │
│                                    [Review] [Skip]      │
└─────────────────────────────────────────────────────────┘
```

For watched (non-requested) PRs:

```
┌─────────────────────────────────────────────────────────┐
│ fix: Handle null in parser              acme/core       │
│ @junior-dev · +12/-3 · 2 files · 6h old · watching     │
│ CI: pass · Reviews: none                                │
│                                    [Review] [Skip]      │
└─────────────────────────────────────────────────────────┘
```

Fields:

- **Title** - PR title
- **Repo** - `org/repo` tag (same style as dashboard)
- **Author** - PR author login
- **Size** - Lines added/removed, files changed (computed from diff stats - needs new data, see below)
- **Wait time** - How long since the review was requested (or PR was created)
- **CI status** - Badge (reuse `StatusBadge`)
- **Review summary** - How many approvals, changes requested, and whether you're specifically requested
- **Source indicator** - "requested" or "watching" to show why this PR is in your queue
- **Staleness badge** - "Updated since your review" when new commits exist after your last review
- **Actions** - "Review" (opens PR review detail) and "Skip" (hides from queue temporarily)

### Diff stats

The poller doesn't currently fetch diff stats (additions/deletions/files changed). Two options:

A. **Add to GraphQL query** - GitHub's PR GraphQL has `additions`, `deletions`, `changedFiles` fields. Add them to the query and store on the `prs` table. This is the right approach - cheap, no extra API calls.

B. Fetch on demand when the queue loads - slower, more API calls.

Go with A. Add three integer columns to `prs`: `additions`, `deletions`, `changed_files`.

## Sorting and Prioritization

Default sort: **Review state group first, then wait time within each group.**

Group order:
1. Updated since your review (you have context, re-review is fast)
2. Needs review (not yet reviewed)
3. Reviewed (done, collapsed)

Within each group, sort by wait time descending (longest-waiting first).

Alternative sorts (available via sort controls, applied within groups):

- **Size ascending** - Smallest PRs first (quick wins)
- **Risk** - Highest risk first (once AI analysis is available; until then, use size as a proxy - larger = riskier)
- **Recently updated** - Most recently pushed PRs first

The sort controls should match the existing dashboard pattern (clickable column headers or a sort dropdown).

## Filtering

Filters bar (reuse `FilterBar` pattern):

- **Repo** - Multi-select dropdown of repos with pending reviews
- **Author** - Filter by PR author
- **Size** - Small (<100 lines), Medium (100-500), Large (500+)
- **CI** - Pass / Fail / Pending
- **Review state** - "Needs review" / "Updated since review" / "Reviewed" / "All"
- **Source** - "Requested" / "Watching" / "All"

Filters persist in the URL hash, same pattern as the dashboard: `#/review?repo=billing&size=small&state=needs_review`.

## Skip / Snooze

"Skip" temporarily hides a PR from the queue. Implementation:

- Store skipped PR IDs in `localStorage` with: timestamp, and the `head_commit_oid` at skip time
- Skipped PRs reappear when: (a) 24 hours pass (configurable), OR (b) the PR's `head_commit_oid` changes (new push invalidates the skip)
- A "Show skipped" toggle at the top reveals hidden PRs
- Skipping is local-only, not stored in the DB or on GitHub

The commit-aware snooze is important: if you skip a PR and the author pushes changes, the skip is automatically cleared. The author responded to something (maybe your earlier feedback, maybe CI), so the PR deserves another look.

### Unwatch

For watched PRs, "Skip" should also offer "Unwatch" as a secondary action. Unwatching removes the PR/repo from the watch list permanently (until re-watched). Skipping is temporary, unwatching is permanent.

## Empty States

- **No PRs to review**: "Nothing to review right now. PRs will appear here when you're requested as a reviewer." With a link to configure review-enabled repos.
- **All skipped**: "All review requests are snoozed. [Show skipped]"
- **Loading**: Skeleton cards (same pattern as dashboard loading state)

## Data Flow

1. Poller fetches PR data including `requested_reviewers`, `head_commit_oid`, diff stats, and review `commit.oid` (new fields)
2. Frontend `usePRs` hook already provides all PRs via SSE
3. Review queue fetches the watch list from the backend (`GET /api/review/watches`)
4. Client-side logic computes review state per PR:
   - Is the current user a requested reviewer?
   - Is this PR or its repo in the watch list?
   - Has the user reviewed this PR? If so, against which commit?
   - Has the head commit changed since the user's last review?
5. Queue view renders filtered/sorted/grouped list
6. Clicking "Review" navigates to `#/pr/:id?from=review`

New API endpoints:
- `GET /api/review/watches` - List active watches
- `POST /api/review/watches` - Add a watch (body: `{ type: "pr"|"repo", target: "org/repo#42" }`)
- `DELETE /api/review/watches/:id` - Remove a watch
- `GET /api/config/user` - Return authenticated GitHub user login

## Navigation Between Queue and PR Detail

Clicking a PR in the review queue navigates to the PR detail view (`#/pr/:id`), but with a "review context" flag in the URL hash (e.g., `#/pr/:id?from=review`). This does two things:

1. The "Back" button returns to the review queue instead of the dashboard
2. The PR detail page shows review-specific actions (covered in plan 16)

This avoids building a separate "review detail" view. The existing `PRDetail` component already shows everything needed - we just add review actions when the context is right.

## Files

| File | Change |
|------|--------|
| `src/poller.js` | Add `requested_reviewers`, `head_commit_oid`, `additions`, `deletions`, `changed_files` to GraphQL query; add `commit { oid }` to reviews; update DB upsert |
| `src/db.js` | Add columns to `prs` table: `requested_reviewers` (JSON), `head_commit_oid` (TEXT), `additions` (INTEGER), `deletions` (INTEGER), `changed_files` (INTEGER). Add `review_watches` table. Update reviews JSON shape to include `commit_oid`. |
| `src/routes/reviews.js` | **New** - Watch list CRUD routes (`GET/POST /api/review/watches`, `DELETE /api/review/watches/:id`) |
| `src/server.js` | Add `GET /api/config/user` route, register review routes |
| `frontend/src/App.jsx` | Add review queue route (`#/review`), fetch authenticated user |
| `frontend/src/hooks/useReviewState.js` | **New** - Hook that computes per-PR review state (needs review / updated since review / reviewed) from PR data + watches + current user |
| `frontend/src/components/ReviewQueue/ReviewQueue.jsx` | **New** - Queue view component |
| `frontend/src/components/ReviewQueue/ReviewQueue.module.css` | **New** - Queue styles |
| `frontend/src/components/AppShell/AppShell.jsx` | Add "Review" nav link with count badge |
| `frontend/src/components/FilterBar/FilterBar.jsx` | Extract reusable filter logic or create `ReviewFilterBar` |
| `frontend/src/components/CommandPalette/CommandPalette.jsx` | Add "Review Queue" as a navigation target |
| `frontend/src/components/PRDetail/PRDetail.jsx` | Add "Watch" button for opting into review on any PR |

## Dependencies

- Plan 13 (overview) for context, but no code dependency
- Existing `usePRs` hook and SSE infrastructure
- `gh api /user` for authenticated user detection
