# Future Ideas

Things worth building eventually but not yet prioritized. Two earlier entries
(session transcript persistence, the automation loop) shipped as
`src/transcripts.js` and `src/rules.js` and are gone from this list.

## External notifications

Browser notifications for idle sessions exist (`frontend/src/hooks/useIdleNotification.js`).
Nothing reaches you when the dashboard is closed. The poller emits `pr-changed`
events with computed transitions (`src/poller.js`, consumed by the rules
engine), so a notification module could subscribe to the same emitter and post
to Slack incoming webhooks, email, or macOS notifications when CI fails, a
review requests changes, or a merge conflict appears. A rule action type
(`notify`) would fit the existing engine better than a separate subscriber.

## Create a work item from the command palette

The command palette (Cmd+K) searches and navigates to existing PRs, work items
and scratch workspaces. It should also create manual work: an "action" item
type pinned in results, fuzzy-matching "new", "scratch" and "create", which
switches the palette into the Start work form (title, repositories, optional
bookmark) and submits through `POST /api/work-items` with `source: "manual"`.
Escape in create mode returns to search; a second Escape closes the palette.
