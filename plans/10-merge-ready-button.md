# 10 - Merge-Ready Button

## Goal

Show a prominent "Merge on GitHub" button when a PR meets all merge criteria: CI passing, no conflicts, and review approved. The button links directly to GitHub's merge UI rather than merging programmatically - keeps the human in the loop for the final action.

## Approach

Pure frontend logic. All the data needed to determine merge readiness already exists in the PR response (`ci_status`, `mergeable`, `review_status`, `draft`). No new backend endpoints.

Note: `ci_status` and `review_status` are derived at response time by `formatPR()` in `src/pr-status.js` (not stored as DB columns). They're always present in the API response.

## Merge-ready conditions

A PR is merge-ready when ALL of the following are true:
- `ci_status === 'pass'`
- `mergeable === 'MERGEABLE'`
- `review_status === 'approved'`
- `draft === false`

## Frontend

### PR detail page (`PRDetail.jsx`): Merge button

Add a "Merge on GitHub" button to the header card, next to the existing GitHub icon link.

When merge-ready:
- Green button with merge icon (git-merge SVG)
- Links to `{pr.url}` (GitHub shows the merge button at the bottom when you visit the PR page)

When NOT merge-ready:
- Button is hidden entirely (not disabled/greyed - that adds visual noise without value)

Implementation: inline in `PRDetail.jsx` next to the existing GitHub icon. This is a conditional anchor tag - no need for a separate component.

```jsx
{isMergeReady && (
  <a href={pr.url} target="_blank" rel="noopener noreferrer" className={styles.mergeButton}>
    Merge on GitHub
  </a>
)}
```

### PR table (`PRTable.jsx`): Merge-ready indicator

Add a small merge-ready icon to PR rows in the dashboard. A green checkmark or merge icon next to PRs that meet all criteria. Lets the user spot merge-ready PRs at a glance.

The `PRTable.jsx` component at `frontend/src/components/PRTable/PRTable.jsx` uses TanStack Table with a clear columns structure - add the indicator as part of the status column or as a new narrow column.

## Files

| File | Change |
|------|--------|
| `frontend/src/components/PRDetail/PRDetail.jsx` | Add merge button (inline, no new component) |
| `frontend/src/components/PRDetail/PRDetail.module.css` | Add `.mergeButton` styles |
| `frontend/src/components/PRTable/PRTable.jsx` | Add merge-ready indicator to rows |
| `frontend/src/components/PRTable/PRTable.module.css` | Add indicator styles |

## Dependencies

None. Pure frontend, uses existing PR data.

## Deliverable

- PR detail page shows green "Merge on GitHub" button when all criteria met
- Button links to the GitHub PR page
- PRTable shows merge-ready indicator on qualifying PR rows
- Button/indicator disappears when any criteria fails
