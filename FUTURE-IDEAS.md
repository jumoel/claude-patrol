# Future Ideas

Things worth building eventually but not yet prioritized.

## Notification and alerting

The poller already detects CI failures, review requests, and merge conflicts. Hooking that into external channels (Slack webhooks, email, macOS notifications) would surface problems without needing the dashboard open. The `pollerEvents` EventEmitter in `src/poller.js` already emits `sync` events with PR counts - a notification module could subscribe to that same emitter and diff state between cycles to detect transitions (passing -> failing, no reviews -> changes requested, etc.). Slack's incoming webhook API is the lowest-friction integration point.

## Session transcript persistence

Terminal sessions use a 50KB ring buffer (`src/pty-manager.js` RingBuffer class) that gets garbage collected when the session ends. For post-mortem debugging or audit trails, the full session output should be persisted. Options: stream to a file on disk during the session (append-only, cheap), or snapshot the buffer to the DB on session exit. The DB approach is simpler but caps at 50KB per session. File-based streaming captures everything but needs a retention/cleanup policy. Either way, the `proc.onData` handler in `createSession()` is the hook point - add a second consumer alongside the WebSocket broadcast.

## Automation loop

The most valuable next step: auto-dispatch Claude Code when the poller detects an actionable state. For example, when CI fails on a PR that has a workspace, automatically start a session and send "investigate and fix the CI failures" as the initial prompt. The pieces exist - `createSession()` spawns Claude, `QuickActions` already constructs investigation prompts, and the poller knows which PRs have failures. What's missing is the orchestration: a rules engine that evaluates PR state transitions and decides when to act. Needs guardrails (max concurrent sessions, cooldown between retries, opt-in per repo/PR) to avoid runaway automation. The `pollerEvents` sync event is the trigger point, and the MCP server tools (`create_scratch_workspace`, etc.) give Claude the ability to act on its findings.

## Create scratch workspace from command palette

The command palette (Cmd+K) only searches and navigates to existing PRs and workspaces. It should also support creating a scratch workspace directly. Add an "action" item type that pins a "New Scratch Workspace" entry in results, fuzzy-matching against "new", "scratch", and "create". Selecting it switches the palette into a create form with a repo dropdown and branch input. Submits via the existing `POST /api/workspaces { repo, branch }` endpoint, closes the palette, and navigates to the new workspace. No backend changes needed - just `CommandPalette.jsx` (action item type, create-mode state, and form) and `CommandPalette.module.css` (form styles). Escape in create mode returns to search; a second Escape closes the palette entirely.
