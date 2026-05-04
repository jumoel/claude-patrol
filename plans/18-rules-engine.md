# Plan: Rules Engine

## Context

Today, automating "wait for CI to finish, then tell Claude to do something" requires keeping a Claude session in the outer loop, polling via the `wait_for_checks` MCP tool. That ties up a whole session as a glorified timer. Users with their own automation (e.g. a personal `ecosystems-rebuilder.js`) end up writing custom scripts outside the patrol server.

The rules engine adds declarative reactions to PR-state transitions. A rule defines a trigger event, a predicate, and one or more actions. When the trigger fires and the predicate matches, the actions run. No multi-step state machines, no DSL, no JS modules - just JSON.

## Prerequisites

This plan depends on five precursor plans, each independently shippable:

- **Plan 13 - Actions Registry:** extracts MCP tool dispatch into `src/actions.js`. Rules `mcp` action calls `invokeAction(app, tool, args)` directly.
- **Plan 14 - SSE Array-Driven Registration:** cleanup that makes adding the `rule-run` SSE event a one-line change to an array.
- **Plan 15 - PTY Server-Side Helpers:** exports `writeToSession` and `waitForFirstIdle` from `src/pty-manager.js` so the rules engine doesn't reach into PTY internals.
- **Plan 16 - Zod Config Schema:** adds `.passthrough()` to the config schema so `cfg.rules` survives validation; rules-engine validation lives separately in `src/rules.js`.
- **Plan 17 - Poller Per-PR Change Events:** the poller emits semantic `pr-changed` events with `prev`/`changes` payloads. The rules engine becomes a stateless consumer (no in-memory cache, no warmup pass).

All 5 should land before this plan. Each is small enough to review independently.

---

## Scope (v1)

**In:**
- Two triggers: `ci.finalized`, `session.idle`
- Flat declarative `where` predicates (equality + array membership), implicit AND
- Two action types: `dispatch_claude` (workspace + Claude session + prompt), `mcp` (any rule-fireable MCP tool by name)
- Multiple actions per rule, sequential, stop-on-error
- Per-rule cooldown (default 10min)
- Rules defined inline in `config.json` under `"rules": [...]` with live-reload
- Persistent `rule_runs` table for observability and restart-survivable state
- UI: list of recent runs alongside the existing tasks panel

**Out (deferred unless asked):**
- Multi-step workflows (`wait_for` between steps, `branch`/`if`, `goto`)
- `review.*`, `label.*`, `mergeable.*` triggers
- Cron / time-based triggers
- `webhook` / `notify` / `run_command` action types
- Queueing prompts for busy sessions (v1: error and rely on cooldown to retry)
- Multi-line prompts with bracketed paste (v1: single-line + trailing `\r`)
- Templating beyond `{{pr.<field>}}` and `{{session.<field>}}`

---

## JSON shape

```json
{
  "rules": [
    {
      "id": "rebuild-on-green",
      "on": "ci.finalized",
      "where": {
        "repo": "myorg/api",
        "labels": ["needs-rebuild"],
        "ci_status": "pass",
        "draft": false
      },
      "actions": [
        { "type": "mcp", "tool": "retrigger_checks", "args": { "pr_id": "{{pr.id}}", "check_name": "lint" } },
        { "type": "dispatch_claude", "prompt": "PR {{pr.id}} just went green. Run the rebuild and report." }
      ],
      "cooldown_minutes": 10
    }
  ]
}
```

### Field semantics

**`id`** - unique per rule. Used for cooldown bucketing and run-row attribution.

**`on`** - one of:
- `"ci.finalized"` - PR's checks just transitioned from non-final to all-final this poll cycle. Fires once per transition; does not refire while still in final state.
- `"session.idle"` - a Claude session just emitted an `idle` state.

**`where`** - flat object, all keys must match. No nesting, no operators, no negation.

| Field | Source | Match form |
|---|---|---|
| `repo` | PR `org/repo` | scalar or array (membership) |
| `org`, `branch`, `base_branch`, `author` | PR | scalar or array |
| `ci_status` | PR (`'pass'`/`'fail'`/`'pending'`, derived in `src/pr-status.js`) | scalar or array |
| `mergeable` | PR (`'MERGEABLE'`/`'CONFLICTING'`/`'UNKNOWN'`) | scalar or array |
| `draft` | PR | boolean |
| `labels` | PR (array) | array of strings, ALL must be present |
| `workspace_repo` | session-trigger context | scalar or array |

If you need OR, write two rules.

**`actions`** - array. Run sequentially. First failure stops the chain and marks the run `'error'`. Two types:

- `{ "type": "dispatch_claude", "prompt": "..." }`
  - For `ci.finalized` triggers: resolves the PR's active workspace (creates one if missing), then sends the prompt to the workspace's session (creates a session if missing). If the session is already `'working'`, the run errors with `error: 'session_busy'` - cooldown will retry on next trigger.
  - For `session.idle` triggers: rejected at rule-load time as a self-dispatch loop trap. Use an `mcp` action instead, or trigger off something else.
- `{ "type": "mcp", "tool": "<tool_name>", "args": { ... } }`
  - Looks up the tool in the registry from plan 13 (`src/actions.js`). **Templating runs first** (substitute `{{pr.<field>}}` against the trigger context), then `args` is validated against the tool's `zod` schema, then the in-process handler is called via `app.inject()`. Read-only tools (`list_*`, `get_*`) are flagged `ruleFireable: false` and rejected at rule-load time. `wait_for_checks` is intentionally not in the registry at all (it's a multi-call tool, not a single dispatch) - rules don't need a wait primitive because the triggers themselves replace it.

**`prompt` and `args` templating** - `{{pr.<field>}}` and `{{session.<field>}}` substitutions only. Missing field = empty string with a logged warning. No expressions. Always applied **before** schema validation so the validator sees the resolved value, not literal `{{...}}`.

**`cooldown_minutes`** - default 10. Per `(rule_id, pr_id ?? session_id ?? workspace_id)` bucket. Implemented as `WHERE rule_id = ? AND cooldown_key = ? AND started_at > ?` against `rule_runs` before firing. In v1 every trigger has at least one of pr_id/session_id/workspace_id, so the key is never null.

---

## Architecture

### Event sources (all from precursors)

- `pollerEvents.emit('pr-changed', { pr, prev, changes })` (plan 17) - the engine subscribes to this for `ci.finalized` derivation
- `appEvents.emit('session-state', { sessionId, workspaceId, state })` on PTY activity changes (`src/app-events.js:22`)
- `configEvents.emit('change', cfg)` when `config.json` is rewritten (`src/config.js:152`)

### Deriving `ci.finalized` from `pr-changed`

A `ci.finalized` event fires when `changes.ci_status` exists and the new value is in `{'pass', 'fail'}` (final states). The engine doesn't maintain its own PR cache - the poller's prev-row comparison already gives us the transition payload. Downtime transitions are caught for free because `prev` comes from the DB, which retains pre-shutdown state.

### Rule run lifecycle

```
config.json change -> rules.js per-rule validation -> swap in-memory rules atomically
server start       -> mark stale rule_runs (status='running') as 'error'
                      with error='server_restarted'
pr-changed event   -> if changes.ci_status indicates finalization,
                      for each rule with on='ci.finalized',
                      check where, check cooldown
                      -> insert rule_runs row (status='running')
                      -> execute actions sequentially
                      -> update row to 'success' or 'error'
session-state idle -> same path for on='session.idle'
```

---

## Changes

### 1. Database: `rule_runs` table

**File:** `src/db.js`

```sql
CREATE TABLE IF NOT EXISTS rule_runs (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  trigger TEXT NOT NULL,            -- 'ci.finalized' | 'session.idle'
  pr_id TEXT,                       -- nullable for session triggers without PR context
  workspace_id TEXT,
  session_id TEXT,
  cooldown_key TEXT NOT NULL,       -- pr_id ?? session_id ?? workspace_id (v1 always has one)
  status TEXT NOT NULL,             -- 'running' | 'success' | 'error'
  error TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX idx_rule_runs_cooldown ON rule_runs(rule_id, cooldown_key, started_at);
CREATE INDEX idx_rule_runs_started ON rule_runs(started_at DESC);
```

On engine init: `UPDATE rule_runs SET status = 'error', error = 'server_restarted', ended_at = ? WHERE status = 'running'`. Reconciles any rows that were mid-execution when the server died.

### 2. Rules engine

**File:** New `src/rules.js`

Single file. Responsibilities:

- **Load:** read `cfg.rules` from the loaded config (plan 16 leaves `cfg.rules` untouched as a passthrough). Each rule is parsed individually against a zod schema in `src/rules.js`; failures are collected per-rule into `ruleLoadErrors` (array of `{ rule_id, error }`). Valid rules go into the in-memory `rules` map. A bad rule never blocks valid ones.
- **Live-reload:** subscribe to `configEvents.on('change')`, re-parse rules per-rule, swap atomically. Errors surface via `ruleLoadErrors` for the UI/TUI.
- **Trigger handlers:** subscribe to `pollerEvents.on('pr-changed')` and `appEvents.on('session-state')`. For each event, find matching rules (by `on` + `where`), check cooldown, fire. No internal cache - the precursor poller emits all the diff info needed.
- **Execute:** insert `rule_runs` row, run actions sequentially via `invokeAction` (for `mcp`, imported from plan 13's `src/actions.js`) or the dispatch helper (for `dispatch_claude`), update row at end. Emit `appEvents.emit('rule-run')` on transitions for the SSE/UI.
- **Init reconciliation:** on engine start, mark stale `'running'` rule_runs rows as `'error'` with `error: 'server_restarted'`.

**dispatch_claude resolution logic:**

```
given pr_id (from trigger context):
  workspace = SELECT * FROM workspaces WHERE pr_id = ? AND status = 'active'
  if not workspace:
    workspace = await createWorkspace(pr_id, config)   // throws -> rule_run = 'error'
  session = SELECT * FROM sessions WHERE workspace_id = ? AND status = 'active'
  if session and session.state === 'working':
    throw new Error('session_busy')                    // cooldown will retry
  if not session:
    session = createSession(workspace.id, workspace.path)
    await waitForFirstIdle(session.id, BOOT_TIMEOUT_MS_DEFAULT)
  writeToSession(session.id, prompt + '\r')
```

`waitForFirstIdle`, `writeToSession`, and `BOOT_TIMEOUT_MS_DEFAULT` are imported from `src/pty-manager.js` (plan 15). Existing-session writes don't need to wait - they were already in `'idle'`, otherwise we errored above with `session_busy`.

Workspace creation can throw (jj errors, missing repo). The action lets it propagate; the rule_run becomes `'error'` with the underlying message.

**`workspace_repo` resolution for `session.idle` triggers.** A `session-state` event carries `{ sessionId, workspaceId, state }`. To match a `where: { workspace_repo: ... }` predicate, the engine reads `workspaces.repo` (set for scratch workspaces) or, if null, joins to `prs` via `workspaces.pr_id` and uses `prs.org/prs.repo`. This happens once per matching event, not per rule.

### 3. Predicate matching

**File:** `src/rules.js` (small helper, not its own file)

```js
function matches(where, predCtx) {
  for (const [key, expected] of Object.entries(where)) {
    const actual = predCtx[key];
    if (key === 'labels') {
      if (!Array.isArray(expected) || !expected.every((l) => actual?.includes(l))) return false;
    } else if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
    } else {
      if (actual !== expected) return false;
    }
  }
  return true;
}
```

**Two distinct ctx shapes:** keep them straight to avoid bugs.

- **Predicate ctx (`predCtx`)** - flat. For `ci.finalized`: the formatted PR fields directly (`predCtx.repo`, `predCtx.ci_status`, `predCtx.labels: string[]`). For `session.idle`: `{ workspace_repo, ... }` after the lookup described above.
- **Templating ctx (`tmplCtx`)** - nested. `{ pr: <formattedPR>, session: <sessionInfo> }`. The `template()` helper reads `tmplCtx.pr.<field>` / `tmplCtx.session.<field>`.

The engine builds both from the same trigger event. Don't pass the templating ctx to `matches()` or vice-versa.

### 4. Templating

**File:** `src/rules.js` (small helper)

```js
function template(str, ctx) {
  return str.replace(/\{\{(pr|session)\.([\w_]+)\}\}/g, (_, ns, field) => {
    const val = ctx[ns]?.[field];
    if (val == null) {
      console.warn(`[rules] template miss: ${ns}.${field}`);
      return '';
    }
    return String(val);
  });
}
```

No nesting, no expressions.

### 5. API routes

**File:** New `src/routes/rules.js`

- `GET /api/rules` - list of rule definitions (from in-memory) + `ruleLoadErrors`
- `GET /api/rules/runs?limit=50&rule_id=X&pr_id=Y` - recent runs from `rule_runs`
- `POST /api/rules/:id/run` - manually fire a rule. Body: `{ pr_id?: string, session_id?: string }` (one or the other, depending on the rule's trigger type). Query: `?force=true` to bypass cooldown. The handler loads the PR or session and synthesizes the same `predCtx`/`tmplCtx` shapes the trigger handler would produce, then invokes the rule. Returns the resulting `rule_run` row.

**File:** `src/server.js`

- Register the new route module.

### 6. SSE: rule-run events

**File:** `src/server.js`

- Add one entry to the `SSE_EVENTS` array (introduced by plan 14): `{ name: 'rule-run', emitter: appEvents }`. No other changes; the array-driven loop handles registration/cleanup.

### 7. Frontend

**File:** New `frontend/src/hooks/useRuleRuns.js`

- Mirror `useTasks`: fetch on mount, subscribe to SSE, prepend new runs.

**File:** `frontend/src/components/DashboardSummary/DashboardSummary.jsx`

- Add a "Rules" section alongside the existing tasks list. Same compact-list pattern. Each item: rule id, trigger, PR link, status, timestamp, link to session transcript on click (when `session_id` is set).

### 8. Documentation

**File:** `README.md`

- New "Rules" section under Configuration with an example, the field reference table, and the deferred-features list.

**File:** `BUILD_LOG.md`

- Per-commit entries.

---

## File Summary

Files touched only by this plan (precursor PRs handle the rest):

| File | Change |
|---|---|
| `src/db.js` | New `rule_runs` table |
| `src/rules.js` | New: load, validate, subscribe, fire (rules-engine logic lives here) |
| `src/routes/rules.js` | New routes |
| `src/server.js` | Register the routes module; add `rule-run` to the `SSE_EVENTS` array (plan 14) |
| `src/tui.js` | Show rule load errors in status line |
| `frontend/src/hooks/useRuleRuns.js` | New |
| `frontend/src/components/DashboardSummary/DashboardSummary.jsx` | Add Rules section |
| `README.md` | Document the feature |
| `BUILD_LOG.md` | Per-commit entries |

Files touched by precursor plans (cross-reference only):

- `src/actions.js`, `src/mcp-server.js` - plan 13
- `src/server.js` SSE block - plan 14 (this plan adds one array entry)
- `src/pty-manager.js` - plan 15 (this plan imports `writeToSession`, `waitForFirstIdle`)
- `src/config.js` - plan 16 (this plan relies on `.passthrough()` for `cfg.rules`)
- `src/poller.js` - plan 17 (this plan subscribes to `pr-changed`)

---

## Implementation phases

Five precursor PRs (plans 13-17), each independently shippable, then a single PR for this plan. Suggested commit order **within this plan's PR**:

1. `feat(db): add rule_runs table`
2. `feat(rules): load and validate rule definitions from config`
3. `feat(rules): wire ci.finalized (via pr-changed) + session.idle triggers`
4. `feat(rules): implement mcp + dispatch_claude actions`
5. `feat(api): rules and rule-runs endpoints, SSE rule-run event`
6. `feat(ui): rules section in dashboard summary`
7. `docs: rules engine in README`

---

## Verification

1. **End-to-end `ci.finalized`:** with a rule on `ci.finalized`, force a CI transition on a PR (real or simulated). The poller emits `pr-changed` with `changes.ci_status` (verified separately by plan 17); the rules engine fires the rule exactly once. No spurious fires for PRs whose CI status didn't transition.
2. **Cooldown:** set `cooldown_minutes: 1`. Force two CI transitions on the same PR within 60s. The second must be skipped with a logged "cooldown active" reason.
3. **Predicate:** rule with `where: { ci_status: ["fail", "pending"] }` fires on fail/pending but not on pass. Rule with `where: { labels: ["a", "b"] }` fires only when both labels are present.
4. **`mcp` action:** rule with `actions: [{ type: "mcp", tool: "trigger_sync" }]` causes a sync after the trigger event. Confirm via the poller log.
5. **`mcp` rejection:** rule with `actions: [{ type: "mcp", tool: "list_prs" }]` is rejected at load time with a visible error in `GET /api/rules`.
6. **Templating order:** rule with `args: { pr_id: "{{pr.id}}" }` validates against the schema after substitution; a malformed `{{pr.id}}` (e.g. missing field) substitutes to empty string, which then fails zod validation with a clear error on the rule_run.
7. **`dispatch_claude` happy path:** rule fires, no existing workspace -> workspace created, session started, prompt visible in the terminal UI after Claude finishes booting.
8. **`dispatch_claude` busy session:** rule fires while session is `'working'` -> `rule_runs` row is `'error'` with `error: 'session_busy'`. Next trigger after cooldown succeeds.
9. **`dispatch_claude` boot timeout:** simulate a session that never goes `'idle'` (e.g. kill claude inside tmux); rule_run errors with the `waitForFirstIdle` timeout message after 30s.
10. **`session.idle` self-dispatch refusal:** rule with `on: 'session.idle'` and `actions: [{ type: 'dispatch_claude', ... }]` is rejected at load time with a clear error.
11. **Restart survival:** kill the server during a `'working'` action sequence. On restart, the orphaned `rule_runs` row is updated to `status='error'`, `error='server_restarted'`. A new transition fires the rule again (subject to cooldown).
12. **End-to-end downtime catch:** stop the server, edit a PR's CI state in the DB to be non-final, restart. The next sync's `pr-changed` event (mechanism verified in plan 17) flows through to the rules engine and the rule fires.
13. **Live-reload:** edit `config.json`, add a typo'd rule. The valid rules keep firing; the typo'd rule shows as a load error in `GET /api/rules`. Fix the typo; the rule starts firing on next event.
14. **UI:** trigger a rule manually via `POST /api/rules/:id/run` with `{"pr_id":"..."}` body. Run appears in the dashboard panel within a poll cycle. Click links to the resulting session transcript.

---

## Known limitations (document in README)

- Single-line prompts only. Multi-line needs bracketed paste; deferred.
- Busy sessions error rather than queue. Cooldown is the retry mechanism.
- No OR / NOT in `where`. Use multiple rules or array membership.
- No `wait_for_checks`-style waits between actions. The triggers themselves replace that need; multi-step state machines are not in scope.
- `dispatch_claude` is not a valid action for `session.idle`-triggered rules (loop trap). Use `mcp` actions, or trigger off `ci.finalized` instead.
- Boot timeout for fresh sessions is `BOOT_TIMEOUT_MS_DEFAULT` from `src/pty-manager.js` (30s). Raise the constant if Claude takes longer to boot on slow machines.
- No cross-rule serialization for the same workspace. If two different rules fire `dispatch_claude` against the same workspace simultaneously, both prompts get written to the same Claude session back-to-back. Bounded by per-rule cooldown but not eliminated. v1 accepts this; if it bites, add a workspace-level mutex around `dispatch_claude` in v2.
