# 13 - Review Feature: Overview and UX Philosophy

## The Problem

Claude Patrol is currently an operations tool. You see your PRs, fix CI failures, resolve merge conflicts, address review feedback. The user is always the PR author.

Adding review support introduces a second persona: the reviewer. You see other people's PRs, evaluate their code, provide feedback, approve or request changes. These are fundamentally different mindsets:

- **Author mode**: "What's broken? How do I fix it?"
- **Reviewer mode**: "What changed? Is it correct? What feedback should I give?"

The UI needs to support both without muddling them together.

## Why Claude Patrol for Reviews

GitHub already shows review requests. What does Claude Patrol add?

1. **AI pre-analysis** - Claude reads the PR before you do, flags potential issues, summarizes changes
2. **Prioritization** - Risk-based ordering (security-sensitive changes first, typo fixes last), not just chronological
3. **Batch efficiency** - Review multiple small PRs quickly without context-switching between GitHub tabs
4. **Unified context** - CI status, merge status, existing reviews, PR description, and AI analysis all in one place
5. **Action without leaving** - Post reviews to GitHub directly from the dashboard

## What This Feature Is NOT

- **Not a GitHub diff viewer replacement.** GitHub's diff UI is excellent. We won't rebuild it. "View diff" links to GitHub for line-by-line reading.
- **Not an auto-approver.** Claude's analysis is always a suggestion. Humans confirm before anything posts to GitHub. No "approve all" without explicit per-PR confirmation.
- **Not a review policy engine.** No CODEOWNERS enforcement, no required-approval counting, no branch protection rules. GitHub handles that.

## Design Principles

### 1. Queue-first

The most valuable thing is answering "what should I review next?" The review queue is the primary entry point, not an afterthought bolted onto the dashboard.

### 2. Two entry paths into the queue

PRs reach your review queue through two mechanisms:

- **Requested reviews** - GitHub assigned you. These appear automatically.
- **Watched PRs/repos** - You opted in. "Watch" a specific PR to follow its progress, or watch an entire repo to see all its PRs.

The default for most users: review what you're requested on. Power users and team leads watch repos to see everything.

### 3. Staleness is the most important signal

When you review a PR and the author pushes new commits, you need to know immediately. "Updated since your review" is the single most important indicator in the review queue. It answers: "did anything change after I already looked at this?"

The system tracks which commit SHA your review was made against vs. the current head commit. If they differ, the PR is stale and needs re-review. These PRs sort to the top of the queue because you already have context - re-reviewing is faster than starting fresh.

### 4. Two-speed review

Most reviews should be fast. A dependency version bump or docs fix doesn't need deep analysis. The UX should support:

- **Quick triage**: Summary, risk level, one-click approve or skip
- **Deep dive**: Full AI analysis, existing comments, terminal access for investigation

The UI should make it obvious which speed is appropriate for each PR.

### 5. AI as first pass, human as final pass

Claude reads the PR before you do. You review Claude's review. This means:

- Claude's analysis is presented as "findings" or "suggestions", not "the review"
- The user always sees exactly what will be posted before confirming
- Disagreeing with Claude is easy and expected (dismiss a finding, edit a comment)

### 6. Don't fight the existing patterns

Claude Patrol already has a global terminal, MCP tools for reading diffs and comments, and workspace management. The review feature should compose these pieces rather than building parallel infrastructure.

Specifically: Claude analyzes PRs by using MCP tools (`get_pr_diff`, `get_pr_comments`) through the global terminal or a dedicated session. No new AI integration layer needed.

### 7. Keyboard-driven power use

Reviewing code is repetitive. Keyboard shortcuts should cover the full workflow:

- Navigate between PRs in the queue
- Trigger Claude analysis
- Approve / request changes / skip
- Move to next PR

## User Personas

### Persona A: Team Lead

Reviews 10-20 PRs per day across 3-4 repos. Needs to triage quickly: which PRs are simple, which need careful attention? Values batch efficiency and risk-based prioritization.

### Persona B: IC Reviewer

Reviews 3-5 PRs per day in their area. Wants to understand what changed and why. Values AI analysis that highlights non-obvious issues. Will go to GitHub for detailed line-by-line review but wants Claude Patrol for the initial pass.

### Persona C: On-call / Maintainer

Monitors repos for urgent changes. Needs to know when something risky lands. Values the "flag risky PRs" aspect more than the review workflow itself.

## High-Level Architecture

The review feature adds four things:

1. **Review Queue View** (plan 14) - New top-level view showing PRs that need review
2. **Review with Claude** (plan 15) - AI-powered PR analysis via the global terminal
3. **Review Actions** (plan 16) - Posting reviews to GitHub from the dashboard
4. **Integration** (plan 17) - How review connects to the existing dashboard, MCP tools, and keyboard shortcuts

## What Already Exists

The foundation is solid. These pieces are already built and working:

- `get_pr_diff` MCP tool - Fetches full diff or file list
- `get_pr_comments` MCP tool - Fetches reviews, inline comments, conversation
- `CommentsList` component - Renders review comments and conversation
- `PRDetail` page - Shows PR metadata, checks, reviews, workspace controls
- `GlobalTerminal` - Persistent terminal for Claude Code sessions
- `QuickActions` - Pattern for sending commands to terminal sessions
- `FilterBar` - Pattern for filtering PR lists
- `CommandPalette` - Cmd+K navigation to PRs and workspaces
- SSE-driven live updates via `usePRs` hook
- Hash-based routing with deep linking

## Phasing

### Phase 1: Review Queue + Actions

Get the queue view working with manual review (no AI analysis yet). The user sees what needs review, clicks through to see the diff/comments, and posts a review. This is valuable even without AI because it centralizes the review workflow.

### Phase 2: Review with Claude

Add Claude-powered analysis. "Review with Claude" sends a prompt to the global terminal, Claude uses MCP tools to analyze the diff, findings are displayed. This builds on the queue and actions from Phase 1.

### Phase 3: Batch Review + Keyboard Shortcuts

Optimize for throughput. Keyboard navigation through the queue, quick approve/skip, batch operations for low-risk PRs. This requires Phase 1 and 2 to be solid.
