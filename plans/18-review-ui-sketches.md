# 18 - Review UI Sketches and Flow

## Screen Map

```
                         +------------------+
                         |   App Header     |
                         | [Dashboard]      |
                         | [Review (3)]     |  <-- new nav link w/ count
                         | [Global Claude]  |
                         | [Settings]       |
                         +--------+---------+
                                  |
                    +-------------+-------------+
                    |                           |
             #/ (dashboard)              #/review (queue)
                    |                           |
                    v                           v
          +------------------+       +--------------------+
          |   PR Dashboard   |       |   Review Queue     |
          |   (existing)     |       |   (new)            |
          +--------+---------+       +---------+----------+
                   |                           |
                   |   click PR row            |  click "Review"
                   |                           |
                   v                           v
          +------------------+       +--------------------+
          | PR Detail        |       | PR Detail          |
          | (author context) |       | (?from=review)     |
          |                  |       | + review actions    |
          |                  |       | + watch toggle      |
          +------------------+       +---------+----------+
                                               |
                              +----------------+----------------+
                              |                |                |
                     "Review with        "Submit          "Watch/
                      Claude"            Review"          Unwatch"
                              |                |
                              v                v
                    +------------------+  +------------------+
                    | Global Terminal  |  | Review Form      |
                    | (bottom drawer)  |  | (modal)          |
                    +------------------+  +------------------+
```

## 1. App Header (updated)

```
+-----------------------------------------------------------------------------------+
|  [logo] Claude Patrol        [Dashboard] [Review (3)]                             |
|                                                                                   |
|                   Last synced: 2:34 PM - Next in 45s                              |
|                   [Sync now] [> Global Claude] [bell] [settings]                  |
+-----------------------------------------------------------------------------------+
```

The "Review (3)" link shows a count of PRs needing attention (needs_review + updated_since_review). The count badge disappears when zero.

## 2. Review Queue (#/review)

### Full view with all three groups

```
+-----------------------------------------------------------------------------------+
|  [logo] Claude Patrol        [Dashboard] [Review (3)]   Synced 2:34 PM [Sync now] |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  Review Queue                                                                     |
|  Filters: [Repo v] [Author v] [Size v] [CI v] [State v] [Source v]               |
|                                                                                   |
|  --- Updated since your review (1) ----------------------------------------       |
|                                                                                   |
|  +-----------------------------------------------------------------------+        |
|  | feat: Add payment retry logic                          acme/billing   |        |
|  | @sarah-dev - +450/-120 - 12 files - requested 3d ago                  |        |
|  | CI: [pass]  Reviews: 1 approved, you requested                        |        |
|  | ! Updated since your review                                           |        |
|  |                                          [Review]  [Skip]             |        |
|  +-----------------------------------------------------------------------+        |
|                                                                                   |
|  --- Needs review (2) -----------------------------------------------------       |
|                                                                                   |
|  +-----------------------------------------------------------------------+        |
|  | fix: Handle null in parser                             acme/core      |        |
|  | @junior-dev - +12/-3 - 2 files - 6h ago - watching                    |        |
|  | CI: [pass]  Reviews: none                                             |        |
|  |                                 [Review with Claude]  [Review]  [Skip]|        |
|  +-----------------------------------------------------------------------+        |
|                                                                                   |
|  +-----------------------------------------------------------------------+        |
|  | chore: Bump dependencies                               acme/api      |        |
|  | @dependabot - +34/-22 - 4 files - 2d ago - requested                  |        |
|  | CI: [pass]  Reviews: none                                             |        |
|  |                                 [Review with Claude]  [Review]  [Skip]|        |
|  +-----------------------------------------------------------------------+        |
|                                                                                   |
|  --- Reviewed (1) -- [show] -----------------------------------------------       |
|                                                                                   |
+-----------------------------------------------------------------------------------+
|  [> Global Claude]                                              [collapse/expand] |
+-----------------------------------------------------------------------------------+
```

### Reviewed group expanded

```
|  --- Reviewed (1) -- [hide] -----------------------------------------------       |
|                                                                                   |
|  +-----------------------------------------------------------------------+        |
|  | docs: Update API reference                             acme/docs      |        |
|  | @teammate - +8/-2 - 1 file - 1d ago - requested                      |        |
|  | CI: [pass]  Reviews: you approved                                     |        |
|  | (check) Reviewed - no new changes                                     |        |
|  +-----------------------------------------------------------------------+        |
```

### Empty state

```
|                                                                                   |
|                    Nothing to review right now.                                    |
|                                                                                   |
|         PRs will appear here when you're requested as a reviewer                  |
|         or when you watch a repo.                                                 |
|                                                                                   |
|                    [Watch a repo in Settings]                                     |
|                                                                                   |
```

## 3. PR Detail in Review Context (#/pr/acme/billing%2342?from=review)

```
+-----------------------------------------------------------------------------------+
|  [logo] Claude Patrol        [Dashboard] [Review (3)]   Synced 2:34 PM [Sync now] |
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  [< Back to reviews]                     [Watch] [View diff] [GitHub]             |
|                                                                                   |
|  feat: Add payment retry logic                                                    |
|  acme/billing #42 - [branch: feat/payment-retry] - Updated 2h ago                |
|                                                                                   |
|  CI: [pass]   Review: [changes requested]   Merge: [mergeable]   PR: [open]      |
|                                                                                   |
|  > Description (click to expand)                                                  |
|                                                                                   |
|  +-- Review Actions --------------------------------------------------------+     |
|  |                                                                          |     |
|  |  ! Updated since your review (your review: abc123, head now: def456)     |     |
|  |                                                                          |     |
|  |  [Review with Claude]   [Submit Review]                                  |     |
|  |                                                                          |     |
|  +--------------------------------------------------------------------------+     |
|                                                                                   |
|  +-- Workspace -----+                                                             |
|  | [Create Workspace] [Open in Claude]                                            |
|  +-------------------+                                                            |
|                                                                                   |
|  +-- Checks (8 passed, 0 failed) -------------------------------------------+    |
|  |  (check) lint ............... success                                     |    |
|  |  (check) test-unit ......... success                                     |    |
|  |  Show 6 more passed checks                                               |    |
|  +--------------------------------------------------------------------------+    |
|                                                                                   |
|  +-- Reviews ---------------------------------------------------------------+    |
|  |  @alice  approved                                                         |    |
|  |  @bob    changes requested                                                |    |
|  +--------------------------------------------------------------------------+    |
|                                                                                   |
|  +-- Comments ---------------------------------------------------------------+   |
|  |  Review Comments                                                          |   |
|  |  +-- @bob - changes requested - 2h ago ---+                               |   |
|  |  |  src/payment.js  diff:42                |                               |   |
|  |  |  "This should validate the amount       |                               |   |
|  |  |   before calling Stripe"                |                               |   |
|  |  +----------------------------------------+                               |   |
|  +--------------------------------------------------------------------------+    |
|                                                                                   |
+-----------------------------------------------------------------------------------+
|  [> Global Claude]                                              [collapse/expand] |
+-----------------------------------------------------------------------------------+
```

### Differences from author-context PR detail:

- Back button says "Back to reviews" and navigates to #/review
- "Review Actions" card appears prominently (above workspace/checks)
- Staleness indicator with commit SHAs
- "Watch" toggle button in header
- "Review with Claude" and "Submit Review" buttons

### Without review context (author view, existing behavior):

- No "Review Actions" card
- No "Watch" button
- No staleness indicator
- Back goes to dashboard

## 4. Review Form (modal overlay)

Triggered by "Submit Review" button.

```
+-----------------------------------------------------------------------------------+
|                                                                                   |
|           +-- Submit Review ------------------------------------+                 |
|           |                                                     |                 |
|           |  acme/billing #42                                   |                 |
|           |  feat: Add payment retry logic                      |                 |
|           |                                                     |                 |
|           |  Verdict:                                           |                 |
|           |  ( ) Approve    (x) Request changes    ( ) Comment  |                 |
|           |                                                     |                 |
|           |  Review body:                                       |                 |
|           |  +-----------------------------------------------+  |                 |
|           |  | The amount validation is missing in the       |  |                 |
|           |  | retry path. See inline comment from @bob.     |  |                 |
|           |  | Also, the retry count should be configurable  |  |                 |
|           |  | rather than hardcoded to 3.                   |  |                 |
|           |  |                                               |  |                 |
|           |  +-----------------------------------------------+  |                 |
|           |  Markdown supported                                 |                 |
|           |                                                     |                 |
|           |              [Cancel]  [Submit: Request changes]     |                 |
|           |                                                     |                 |
|           +-----------------------------------------------------+                 |
|                                                                                   |
+-----------------------------------------------------------------------------------+
```

Submit button label changes to match the selected verdict:
- "Submit: Approve"
- "Submit: Request changes"
- "Submit: Comment"

## 5. Global Terminal with Review Analysis

After clicking "Review with Claude":

```
+-----------------------------------------------------------------------------------+
|                                                                                   |
|  (PR detail content scrollable above)                                             |
|                                                                                   |
+-----------------------------------------------------------------------------------+
|  Global Claude                                        [maximize] [x]              |
|  +-----------------------------------------------------------------------+        |
|  | $ Review PR acme/billing#42 - "feat: Add payment retry logic"         |        |
|  |   by @sarah-dev.                                                      |        |
|  |                                                                       |        |
|  | Use get_pr_diff to read the full diff. Use get_pr_comments to         |        |
|  | see existing review feedback...                                       |        |
|  |                                                                       |        |
|  | > Reading diff... (get_pr_diff)                                       |        |
|  | > Reading comments... (get_pr_comments)                               |        |
|  |                                                                       |        |
|  | ## Summary                                                            |        |
|  | Adds automatic retry logic for failed Stripe payment calls.           |        |
|  | Retries up to 3 times with exponential backoff. Includes a new        |        |
|  | PaymentRetryQueue class and updates the checkout flow.                 |        |
|  |                                                                       |        |
|  | ## Risk Assessment                                                    |        |
|  | HIGH - Payment processing path, no input validation on retry          |        |
|  | amounts, hardcoded retry count.                                       |        |
|  |                                                                       |        |
|  | ## Findings                                                           |        |
|  | 1. src/payment.js:42 - BLOCKER - No amount validation before          |        |
|  |    Stripe call. Negative or zero amounts would hit the API.           |        |
|  | 2. src/payment.js:67 - WARNING - Retry count hardcoded to 3.          |        |
|  |    Should be configurable per payment type.                           |        |
|  | 3. test/payment.test.js - SUGGESTION - No test for the retry          |        |
|  |    backoff timing. Flaky in CI if timing-sensitive.                   |        |
|  |                                                                       |        |
|  | ## Verdict                                                            |        |
|  | REQUEST_CHANGES - The missing amount validation is a real bug.        |        |
|  | The retry logic itself looks correct.                                 |        |
|  |                                                                       |        |
|  | >                                                                     |        |
|  +-----------------------------------------------------------------------+        |
+-----------------------------------------------------------------------------------+
```

The user reads this, then clicks "Submit Review" on the PR detail above the terminal to open the review form. They can copy/paste or rewrite Claude's findings.

## 6. Watch States on PR Detail

### Not watched, not requested (dashboard context)

```
|  [< Back]                                     [View diff] [GitHub]                |
```

No watch button, no review actions. Standard author view.

### Watched (review context)

```
|  [< Back to reviews]              [Unwatch] [View diff] [GitHub]                  |
```

### Requested reviewer (review context)

```
|  [< Back to reviews]                [Watch] [View diff] [GitHub]                  |
```

Watch is available so the PR stays in your queue even after you're removed as requested reviewer.

## User Flow Diagrams

### Flow A: Requested review, quick approve

```
Open Claude Patrol
        |
        v
  See "Review (3)" badge in header
        |
        v
  Click "Review" nav link
        |
        v
  +-- Review Queue --+
  |  See 3 PRs       |
  |  #156: bump deps  |  <-- small, CI passing
  |  #142: payment    |
  |  #139: parser fix |
  +-------------------+
        |
        | click "Review" on #156
        v
  +-- PR Detail (?from=review) --+
  |  chore: Bump dependencies     |
  |  +34/-22, 4 files, CI pass    |
  |  [Review with Claude]         |
  |  [Submit Review]              |
  +-----------+-------------------+
              |
              | click "Submit Review"
              v
  +-- Review Form (modal) --+
  |  (o) Approve             |
  |  Review body: (empty)    |
  |  [Submit: Approve]       |
  +----------+---------------+
             |
             | submit
             v
  Review posted to GitHub
  PR moves to "Reviewed" group
  Back to review queue
```

### Flow B: Deep review with Claude assistance

```
  +-- Review Queue --+
  |  #142: payment    |  <-- large, HIGH risk
  +-------------------+
        |
        | click "Review with Claude"
        v
  +-- PR Detail + Global Terminal opens --+
  |                                        |
  |  PR Detail (top):                      |
  |  feat: Add payment retry logic         |
  |  +450/-120, 12 files                   |
  |                                        |
  |  Terminal (bottom):                    |
  |  Claude analyzing diff...              |
  |  ...                                   |
  |  ## Findings                           |
  |  1. BLOCKER: No amount validation      |
  |  2. WARNING: Hardcoded retry count     |
  |  ## Verdict: REQUEST_CHANGES           |
  +-----------+----------------------------+
              |
              | read Claude's analysis
              | click "Submit Review"
              v
  +-- Review Form (modal) --+
  |  (o) Request changes     |
  |  Body: "Missing amount   |
  |  validation in retry     |
  |  path, see Claude's      |
  |  analysis."              |
  |  [Submit: Request changes]|
  +----------+---------------+
             |
             v
  Review posted to GitHub
```

### Flow C: Watched repo, post-review staleness

```
  Settings: Watch repo "acme/core"
        |
        v
  All acme/core PRs appear in queue
        |
        v
  +-- Review Queue --+
  |  #139: parser fix |  <-- new, needs review
  +-------------------+
        |
        | review and approve
        v
  PR moves to "Reviewed" group
        |
        | (time passes, author pushes new commits)
        v
  Poller detects head_commit_oid changed
  PR's review commit_oid != head_commit_oid
        |
        v
  +-- Review Queue --+
  |  --- Updated since your review ---     |
  |  #139: parser fix                      |
  |  ! Updated since your review           |
  +-----------+----------------------------+
              |
              | click "Review" to re-review
              v
  See what changed, submit new review
```

### Flow D: Skip and auto-resurface

```
  +-- Review Queue --+
  |  #150: WIP refactor |  <-- not ready, skip it
  +---------------------+
        |
        | click "Skip"
        v
  PR hidden from queue
  Stored: { pr: #150, skipped_at: now, head_oid: "abc123" }
        |
        | (author pushes new commits, head_oid changes to "def456")
        v
  Poller detects head_commit_oid changed
  Skip invalidated (stored oid != current oid)
        |
        v
  +-- Review Queue --+
  |  #150: WIP refactor |  <-- back in queue, new commits
  +---------------------+
```

### Flow E: Watch a specific PR from dashboard

```
  +-- Dashboard (existing) --+
  |  PR table                 |
  |  #142: payment retry      |  <-- not your PR, but you're curious
  +---------------------------+
        |
        | click PR row
        v
  +-- PR Detail (author context) --+
  |  feat: Add payment retry logic  |
  |  (no review actions shown)      |
  |  [Watch]  [View diff]  [GitHub] |
  +----------+----------------------+
             |
             | click "Watch"
             v
  PR added to review_watches table
  Now appears in Review Queue
  Button changes to [Unwatch]
```

## Queue Card Anatomy (detailed)

```
+-----------------------------------------------------------------------+
| line 1:  {title}                                    {org}/{repo}      |
| line 2:  @{author} - +{add}/-{del} - {files} files - {wait} - {src} |
| line 3:  CI: [{ci}]  Reviews: {review summary}                       |
| line 4:  {staleness indicator, if applicable}                         |
| line 5:                      [Review with Claude]  [Review]  [Skip]  |
+-----------------------------------------------------------------------+

Where:
  {title}    = PR title, truncated with ellipsis if needed
  {org/repo} = right-aligned repo tag
  {author}   = PR author login, prefixed with @
  {add/del}  = additions/deletions from diff stats
  {files}    = changed file count
  {wait}     = relative time since review requested or PR created
  {src}      = "requested" | "watching" (why this PR is in your queue)
  {ci}       = pass | fail | pending (colored badge)
  {review summary} = "none" | "1 approved" | "you approved" | etc.
  {staleness} = "! Updated since your review" (yellow) or
                "(check) Reviewed - no new changes" (green, only in Reviewed group)

Line 4 only appears when relevant:
  - "Updated since review" group: always shows staleness warning
  - "Reviewed" group: shows "no new changes" confirmation
  - "Needs review" group: line 4 absent, card is shorter

Actions:
  - [Review with Claude]: opens global terminal + sends analysis prompt
  - [Review]: navigates to PR detail in review context
  - [Skip]: hides from queue (with commit-aware auto-resurface)
  - [Unwatch]: appears instead of Skip for watched PRs (secondary action)
```

## Keyboard Navigation Map

```
Review Queue (#/review):

  j / Down    = highlight next card
  k / Up      = highlight previous card
  Enter       = open highlighted PR (same as clicking "Review")
  r           = "Review with Claude" on highlighted PR
  s           = skip highlighted PR
  /           = focus filter bar
  Cmd+K       = command palette (existing)

PR Detail (?from=review):

  a           = open review form, pre-select "Approve"
  x           = open review form, pre-select "Request changes"
  c           = open review form, pre-select "Comment"
  w           = toggle watch on this PR
  Escape      = close review form if open, else back to queue

Review Form (modal):

  Tab         = cycle between verdict options
  Cmd+Enter   = submit review
  Escape      = close form without submitting

All shortcuts suppressed when a text input or textarea is focused.
```
