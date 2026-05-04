# Plan: Poller Per-PR Change Events (precursor to rules engine)

## Context

`src/poller.js:576` performs `INSERT OR REPLACE` for every PR returned by the GraphQL fetch, with no comparison against the existing row. The only event emitted at the cycle level is a coarse `pollerEvents.emit('sync', { synced_at, pr_count })` at `poller.js:768,837`.

Plan 18 (rules engine) needs to know when a PR's CI just transitioned from non-final to all-final. Without poller-side diffing, the rules engine has to maintain its own in-memory cache keyed by PR id, populate it via a "warmup pass" on first sync after start, then diff against current DB state every subsequent sync. That's:

- ~50 LOC of cache management in `src/rules.js`
- A subtle "warmup" semantic that's easy to get wrong
- Transitions that happened during server downtime are lost (the cache loads current state on warmup, so any transition between shutdown and startup never fires)

If the poller computes diffs against the existing DB row before replacing, it can emit semantic transition events. The rules engine becomes a stateless consumer, downtime-transitions are caught (because the DB still has pre-shutdown state), and any other future consumer (notifications, etc.) gets the same primitive.

This plan is independent of the others and can land standalone.

---

## Scope (in)

- Before each upsert, SELECT the existing row (already partially done via `getExistingBodyStmt` for body diffing - same pattern, extend to all watched fields)
- Compute `changes` by comparing old vs new on a fixed set of fields
- If anything in the watched set changed, emit `pollerEvents.emit('pr-changed', { pr, prev, changes })` after the transaction commits
- Existing `'sync'` event keeps firing as the coarse cycle-end signal

Watched fields and how they're encoded in `changes`:

| Field | Source | Change shape |
|---|---|---|
| `ci_status` | derived from `checks` via `deriveCIStatus` | `{ from: 'pass'\|'fail'\|'pending', to: ... }` |
| `mergeable` | `prs.mergeable` column | `{ from, to }` |
| `labels` | `prs.labels` JSON | `{ added: string[], removed: string[] }` (only set if non-empty) |
| `draft` | `prs.draft` column | `{ from: boolean, to: boolean }` |

If none of those changed, no event. Newly-inserted PRs (no prev row) emit nothing - that's initial state, not a transition. Deletions don't emit `pr-changed`; cleanup uses the existing path.

## Scope (out)

- `review_status` transitions (no consumer asking; can be added when needed)
- Renaming or removing the existing `'sync'` event
- Per-event SSE forwarding (rules engine consumes `pr-changed` in-process; no need to bridge to clients in v1)
- Changing the GraphQL fetch shape

---

## Concerns

**Per-cycle SELECT cost.** Adds one prepared-statement SELECT per PR per cycle. SQLite indexed lookups on the primary key are cheap; a few hundred PRs is negligible. Validate empirically by measuring poll-cycle wall time before/after.

**Transaction boundary.** The existing upsert wraps in `BEGIN`/`COMMIT`. Two correctness rules:

1. SELECT the prev row inside the same transaction as the upsert (otherwise a concurrent write between SELECT and INSERT could miss a change). In practice the poller is single-threaded and there are no other writers to `prs`, but the in-transaction SELECT costs nothing and avoids the question.
2. Buffer events during the transaction; emit them only after `COMMIT`. If the transaction rolls back, we don't fire events for changes that didn't persist.

**Incremental sync caveat.** GitHub's incremental sync only returns PRs whose `updated_at` changed. CI transitions bump `updated_at` on GitHub's side, so the poller will see them. PRs untouched by the incremental sync don't get diffed (we don't fetch them), so no spurious events. This matches existing patrol behavior - same caveat applies to any state derived from the poller.

---

## Changes

### `src/poller.js`

Extend `getStatements()` to add a prep that fetches the watched fields:

```js
if (!getExistingPrevStmt) {
  getExistingPrevStmt = db.prepare('SELECT checks, mergeable, labels, draft FROM prs WHERE id = ?');
}
```

Add a `diff` helper next to the upsert:

```js
function computeChanges(prev, next) {
  if (!prev) return null;
  const changes = {};
  const prevCi = deriveCIStatus(JSON.parse(prev.checks));
  const nextCi = deriveCIStatus(next.checks);
  if (prevCi !== nextCi) changes.ci_status = { from: prevCi, to: nextCi };
  if (prev.mergeable !== next.mergeable) changes.mergeable = { from: prev.mergeable, to: next.mergeable };
  if (prev.draft !== (next.draft ? 1 : 0)) changes.draft = { from: !!prev.draft, to: !!next.draft };
  const prevLabels = new Set(JSON.parse(prev.labels).map((l) => l.name));
  const nextLabels = new Set(next.labels.map((l) => l.name));
  const added = [...nextLabels].filter((l) => !prevLabels.has(l));
  const removed = [...prevLabels].filter((l) => !nextLabels.has(l));
  if (added.length || removed.length) changes.labels = { added, removed };
  return Object.keys(changes).length ? changes : null;
}
```

In `upsertPRs`, inside the transaction, capture each prev row and its change-set. After commit, re-read each changed row from the DB and pass it through `formatPR` before emitting (cheaper and simpler than rebuilding the formatted shape from the raw GraphQL node):

```js
const pendingDiffs = [];
db.exec('BEGIN');
try {
  for (const pr of prs) {
    const prev = getExistingPrev.get(pr.id);
    upsert.run(/* ... */);
    const changes = computeChanges(prev, pr);
    if (changes) pendingDiffs.push({ id: pr.id, prev, changes });
  }
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
const formatRow = db.prepare('SELECT * FROM prs WHERE id = ?');
for (const { id, prev, changes } of pendingDiffs) {
  const row = formatRow.get(id);
  pollerEvents.emit('pr-changed', { pr: formatPR(row), prev, changes });
}
```

**`pr` in the emitted event is always the `formatPR` output** - consumers get derived fields (`ci_status`, `review_status`) and a flat string array of label names. `prev` is the raw DB row as stored before upsert (consumers typically don't need it formatted - `changes` already encodes the diff). Add `formatRow` to `getStatements()` if cycle profiling shows the lookup matters, otherwise the inline prepare is fine since it's only run for changed PRs.

`getExistingPrev` is exposed via the existing `getStatements()` helper - add it to the returned object alongside `getExistingBody`, following the existing pattern.

---

## File Summary

| File | Change |
|---|---|
| `src/poller.js` | Add prev-row SELECT, diff logic, post-commit `pr-changed` emission |

---

## Verification

1. **Initial sync:** clear the DB, start the server, run a sync. Every PR is new (no prev row) → no `pr-changed` events emitted. Only the existing `'sync'` event fires.
2. **No-op sync:** run a second sync with no upstream changes. No `pr-changed` events.
3. **CI transition:** force a CI status flip on a real PR (or simulate by editing the `checks` JSON in the DB to a non-final shape, then triggering a sync that re-fetches). The next sync emits one `pr-changed` event with `changes.ci_status: { from: 'pending', to: 'pass' }` for that PR.
4. **Label add/remove:** add a label on GitHub, sync. Event with `changes.labels: { added: ['new-label'], removed: [] }`.
5. **Mergeable change:** create a merge conflict, sync. Event with `changes.mergeable: { from: 'MERGEABLE', to: 'CONFLICTING' }`.
6. **Multi-field change:** force CI flip + label remove in the same sync. One event per PR with both fields populated.
7. **Downtime transition:** stop the server. Edit the DB to set a PR's `checks` JSON to a non-final state (simulate it being non-final at shutdown). Restart the server. The next sync (where GitHub returns the actual final state) emits `pr-changed` for that PR. The "warmup" hole is closed.
8. **Rollback safety:** simulate a sqlite write failure mid-transaction (e.g. inject an error in a test). No `pr-changed` events fire.
9. **Poll-cycle timing:** instrument `pollOnce` to log wall time before/after. On a representative config (e.g. ~100 PRs), record the median across 5 cycles on `main` and on this branch. Acceptance: no observable regression. The added work is one indexed PK lookup per PR via a cached prepared statement; the expectation is sub-millisecond per PR, but verify rather than assume.

---

## Out-of-scope reminders

- Don't add `review_status` transitions yet. Plan 18 doesn't need them.
- Don't bridge `pr-changed` to SSE. Internal-only event.
- Don't bake rules-engine logic into the poller - the poller emits raw transition events, the rules engine decides what to do.
- Don't remove or rename the existing `'sync'` event - other consumers (the SSE bridge, future cycle-level metrics) rely on it.
