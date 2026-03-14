# 16 - Review Actions

## Goal

Post reviews to GitHub from within Claude Patrol. The user selects approve / request changes / comment, writes a review body, and submits. No context-switching to GitHub for the act of reviewing.

## The Review Form

A modal or slide-over panel that appears on the PR detail page. Not a separate route - the user should see the PR context (description, checks, comments) while writing their review.

### Form fields

1. **Verdict** - Radio buttons: Approve / Request Changes / Comment
   - Default: none selected (force explicit choice)
   - Visual treatment: green for approve, red for request changes, neutral for comment

2. **Review body** - Text area for the review comment
   - Markdown supported (rendered as markdown on GitHub)
   - Resizable, starts at ~4 lines tall
   - Placeholder text: "Write your review..."
   - Optional - GitHub allows reviews with no body (just a state change)

3. **Submit button** - "Submit Review" with the selected verdict shown
   - Disabled until a verdict is selected
   - Shows a confirmation state: "Submitting..." while the API call is in flight
   - On success: closes the form, refreshes PR data to show the new review
   - On error: shows error message inline, form stays open

### Form trigger

A "Submit Review" button in the PR detail actions row. Clicking it opens the review form (modal or slide-over). The button is visible when:

- The PR is not authored by the current user (don't review your own PRs)
- The PR is open (not closed/merged)

The button is always available when those conditions are met, not just in "review context." A user might navigate to a PR from the dashboard and decide to review it.

## Backend: POST /api/prs/:id/review

New route that posts a review to GitHub.

### Request body

```json
{
  "event": "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  "body": "Optional review body text"
}
```

### Implementation

Use `gh api` to post the review:

```bash
gh api repos/{owner}/{repo}/pulls/{number}/reviews \
  --method POST \
  --field event=APPROVE \
  --field body="Looks good, nice work on the error handling."
```

Steps:
1. Parse PR ID to extract org, repo, number
2. Validate the `event` field (must be one of the three values)
3. Call `gh api` with the review data
4. Return the created review (GitHub returns the review object)
5. Trigger a sync so the dashboard updates with the new review state

### Error handling

- If `gh api` fails (network, auth, permissions), return 500 with the error message
- If the PR is closed/merged, GitHub will reject the review - surface that error clearly
- Rate limiting: GitHub has a 5000 req/hour limit for authenticated users. A single review is one request, so this isn't a concern for normal use.

## MCP Tool: submit_review

Add to `src/mcp-server.js` so Claude can also post reviews via MCP:

```
submit_review(pr_id: string, event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT", body?: string)
```

This enables a future workflow where Claude analyzes a PR and posts a review directly (with human confirmation via the MCP permission system). Not the primary flow for v1, but the tool should exist.

## Inline Comments (Future Enhancement)

GitHub's review API supports inline comments (comments on specific lines in the diff). The API requires:

- `path` - File path relative to repo root
- `position` - Line position in the diff (not the source file)
- `body` - Comment text

This is powerful but requires either:
A. Building a diff viewer where users can click on lines to add comments
B. Having Claude generate structured inline comments that the UI posts

Both are significant work. For v1, reviews are body-only. Inline comments can be left on GitHub directly. The "View diff" link is always one click away.

If/when we add this, the approach would likely be B: Claude's analysis produces a structured list of `{path, line_hint, comment}` suggestions. The UI shows these as checkboxes. The user selects which ones to include, and the backend maps `line_hint` to `position` using the diff data from `get_pr_diff`. This mapping is the hard part - diff positions are offset-based, not absolute line numbers.

## Post-Review Flow

After submitting a review:

1. The form closes
2. PR data refreshes (via SSE or explicit fetch)
3. The review appears in the existing Reviews section on the PR detail page
4. If the user came from the review queue, the PR moves to "reviewed" state in the queue
5. A subtle success indicator ("Review submitted") appears briefly

### Moving to the next PR

After reviewing, the user probably wants to review the next PR. Two options:

A. **Manual** - User clicks "Back" to return to the queue, picks the next PR
B. **Auto-advance** - After submitting, automatically navigate to the next PR in the queue

Go with A for v1. Auto-advance is a nice optimization but adds complexity (what's "next"? what if the queue changed?). The keyboard shortcut plan (plan 17) will make manual navigation fast enough.

## Review State Tracking

The review queue needs to know which PRs the user has already reviewed. Two sources:

1. **GitHub data** - The poller fetches reviews. If the authenticated user has submitted a review, it shows in `pr.reviews`. This is authoritative but only updates on the next poll cycle.

2. **Local state** - When the user submits a review through Claude Patrol, immediately mark it in local state (React state or localStorage). This provides instant feedback without waiting for the poller.

Use both: local state for immediate UI updates, GitHub data as the source of truth on the next sync.

## Files

| File | Change |
|------|--------|
| `src/routes/reviews.js` | **New** - `POST /api/prs/:id/review` route |
| `src/server.js` | Register the reviews route |
| `src/mcp-server.js` | Add `submit_review` tool |
| `frontend/src/components/ReviewForm/ReviewForm.jsx` | **New** - Modal review form component |
| `frontend/src/components/ReviewForm/ReviewForm.module.css` | **New** - Form styles |
| `frontend/src/components/PRDetail/PRDetail.jsx` | Add "Submit Review" button that opens the form |
| `frontend/src/lib/api.js` | Add `submitReview(prId, event, body)` function |

## Dependencies

- Plan 14 (review queue) for the queue navigation context
- Existing `gh api` infrastructure in the backend
- Authenticated user detection (from plan 14)
