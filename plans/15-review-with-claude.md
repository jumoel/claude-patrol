# 15 - Review with Claude

## Goal

Let Claude analyze a PR before the user reviews it. Claude reads the diff, comments, and context, then produces a structured analysis: what changed, why it matters, and what to watch out for.

## How It Works

Claude Patrol already has all the pieces:

1. **Global Terminal** - A persistent Claude Code session that survives navigation
2. **MCP tools** - `get_pr_diff`, `get_pr_comments`, `get_pr` give Claude full access to PR data
3. **QuickActions pattern** - Sending commands to terminal sessions via WebSocket

The review analysis flow composes these:

1. User clicks "Review with Claude" on a PR (in the queue or PR detail)
2. Global terminal opens (or is already open)
3. A structured prompt is sent to the terminal
4. Claude Code uses MCP tools to read the diff and comments
5. Claude produces a review analysis in the terminal output
6. User reads the analysis, then decides to approve, request changes, or dig deeper

No new AI integration, no API keys, no new infrastructure. Just a well-crafted prompt sent to an existing terminal.

## The Review Prompt

The prompt is the core of this feature. It needs to produce consistent, actionable output. Here's the structure:

```
Review PR {org}/{repo}#{number} - "{title}" by @{author}.

Use get_pr_diff to read the full diff. Use get_pr_comments to see existing review feedback. Use get_pr to see the PR description and metadata.

Analyze this PR and produce a structured review with these sections:

## Summary
What does this PR do? One paragraph, plain language.

## Risk Assessment
Rate as LOW / MEDIUM / HIGH with a one-line justification.
Consider: scope of changes, security implications, test coverage, backwards compatibility.

## Findings
List specific issues, concerns, or suggestions. For each:
- File and approximate location
- What the concern is
- Severity: blocker / warning / suggestion

If there are no findings, say so explicitly.

## Verdict
Based on your analysis, suggest: APPROVE / REQUEST_CHANGES / COMMENT
with a brief justification.

Be direct. Don't pad the output. If the PR looks good, say so and move on.
```

### Prompt construction

Build the prompt in the frontend (like `handleInvestigateFailures` already does). Include PR metadata directly so Claude doesn't need to fetch it separately:

- PR ID, title, author, branch
- CI status, review status, merge status
- Number of files changed, lines added/removed

This front-loads context so Claude can start analyzing the diff immediately.

### Prompt customization

The prompt above is the default. Users should be able to customize it:

- **Per-repo review guidelines** - If a repo has specific review standards (e.g., "all database migrations need a rollback plan"), those should be included in the prompt. Store as `review_prompt_suffix` in per-repo config (future enhancement).
- **Personal style** - Some reviewers want Claude to focus on security, others on performance. A global `review_style` config option could adjust the prompt. Also a future enhancement.

For v1, the default prompt is hardcoded. Customization comes later.

## Where the Analysis Appears

The analysis appears in the **Global Terminal**. This is deliberate:

- The terminal already supports scrollback, copy-paste, search
- Users can ask follow-up questions ("what does this function do?", "is this pattern used elsewhere?")
- Claude has full MCP access for deeper investigation
- No need to build a custom output renderer

The tradeoff: the analysis isn't structured data that the UI can parse. It's terminal text. This means:

- The UI can't extract Claude's verdict programmatically (to auto-fill the review form)
- The user has to read the terminal and manually transfer findings to the review form
- No "accept Claude's suggestion" button that auto-fills the form

This is acceptable for v1. The alternative (structured output parsed by the UI) requires either:
- A separate API-based analysis path (new infrastructure)
- Parsing terminal output (fragile and unreliable)

Both are worse than the simple terminal approach for an initial version.

## Interaction Flow

### From the Review Queue

1. User sees PR in queue, clicks "Review with Claude"
2. Global terminal opens at bottom (if not already open)
3. Prompt is sent to the terminal
4. Meanwhile, user can scroll up to read the PR detail (terminal is in a bottom drawer)
5. Claude's analysis appears in the terminal
6. User reads it, clicks "Submit Review" button on the PR detail page
7. Review form opens (covered in plan 16), user fills in verdict + comments
8. Review posts to GitHub

### From the PR Detail Page

Same flow, but initiated from the PR detail page's "Review with Claude" button instead of the queue. The button appears when the PR detail is accessed with review context (`?from=review` in the URL hash, or always visible if the user is a requested reviewer).

### When the Terminal Is Already Busy

If the global terminal has an active Claude Code session doing other work, sending a review prompt would interrupt it. Options:

A. **Warn and confirm** - "The global terminal is busy. Send the review prompt anyway?" - simplest, honest.
B. **Queue it** - Wait for the current session to be idle before sending. Complex.
C. **Create a PR-specific session** - Start a new terminal for the review. Creates workspace overhead.

Go with A for v1. The user decides whether to interrupt. If they need both, they can use a workspace terminal for one task and the global terminal for the other.

## "Review with Claude" Button Placement

The button appears in two places:

1. **Review Queue** - On each PR card, alongside "Skip"
2. **PR Detail page** - In the actions row, alongside "Open in Claude"

The button should be visually distinct from "Open in Claude" (which creates a workspace for development work). Use a different icon and label. Something like a magnifying glass or checklist icon, with the label "Review with Claude."

## What Claude Needs

For the analysis to be good, Claude needs context. The MCP tools already provide:

- **Full diff** via `get_pr_diff` - the actual code changes
- **PR description** via `get_pr` - the author's explanation of what/why
- **Existing reviews** via `get_pr_comments` - what other reviewers said
- **CI status** via `get_pr` - whether tests pass

What's missing (and could improve analysis in the future):

- **Repo conventions** - Linting rules, test patterns, architectural decisions. Could be provided via a repo-level `REVIEW_GUIDELINES.md` that Claude reads.
- **Related PRs** - Other open PRs that touch the same files. Could help detect conflicts or redundant changes.
- **Historical context** - Previous reviews by this author, common issues. Not worth building now.

## Files

| File | Change |
|------|--------|
| `frontend/src/components/ReviewQueue/ReviewQueue.jsx` | Add "Review with Claude" button per PR card |
| `frontend/src/components/PRDetail/PRDetail.jsx` | Add "Review with Claude" button in actions row |
| `frontend/src/components/PRDetail/PRDetail.jsx` | Build and send review prompt to global terminal |
| `frontend/src/App.jsx` | Wire "Review with Claude" to global terminal open + prompt send |

## Dependencies

- Plan 14 (review queue) for the queue view
- Existing `GlobalTerminal` component and WebSocket infrastructure
- Existing MCP tools (`get_pr_diff`, `get_pr_comments`, `get_pr`)
