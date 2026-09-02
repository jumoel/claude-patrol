import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { appEvents } from './app-events.js';
import { closeDb, getDb, initDb } from './db.js';
import { pollerEvents } from './poller.js';
import {
  getRuleLoadErrors,
  getRules,
  listRuleRuns,
  listSubscriptions,
  manualRunRule,
  runRuleForAll,
  startRulesEngine,
  stopRulesEngine,
  subscribeRule,
  subscribeRuleForAll,
  unsubscribeRule,
} from './rules.js';

const NOW = '2026-08-27T12:00:00.000Z';
let nowMs = Date.parse(NOW);
const clock = { now: () => nowMs };

/** Fake fastify app: records every dispatched action and answers 200. */
function fakeApp() {
  const calls = [];
  return {
    calls,
    appContext: {},
    async inject({ method, url, payload }) {
      calls.push({ method, url, payload: payload ? JSON.parse(payload) : undefined });
      return { statusCode: 200, body: '{}', json: () => ({ ok: true }) };
    },
  };
}

function insertPr(id, { org = 'acme', repo = 'widgets', branch = 'feature', labels = [], checks = [] } = {}) {
  getDb()
    .prepare(
      `INSERT INTO prs (id, number, title, repo, org, author, url, branch, labels, checks, created_at, updated_at, synced_at)
       VALUES (?, ?, ?, ?, ?, 'octocat', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      Number(id.split('#').at(-1)),
      `PR ${id}`,
      repo,
      org,
      `https://example.test/${id}`,
      branch,
      JSON.stringify(labels.map((name) => ({ name, color: 'fff' }))),
      JSON.stringify(checks),
      NOW,
      NOW,
      NOW,
    );
}

function formattedPr(id, overrides = {}) {
  const [orgRepo] = id.split('#');
  const [org, repo] = orgRepo.split('/');
  return {
    id,
    org,
    repo,
    branch: 'feature',
    base_branch: 'main',
    author: 'octocat',
    ci_status: 'fail',
    mergeable: 'MERGEABLE',
    draft: false,
    labels: [],
    updated_at: NOW,
    ...overrides,
  };
}

function emitCiFinalized(id, to = 'fail', overrides = {}) {
  pollerEvents.emit('pr-changed', {
    pr: formattedPr(id, { ci_status: to, ...overrides }),
    prev: {},
    changes: { ci_status: { from: 'pending', to } },
  });
}

/** Poll rule_runs until `count` runs have left the running state. */
async function settledRuns(count, { ruleId } = {}) {
  for (let i = 0; i < 200; i++) {
    const runs = listRuleRuns({ rule_id: ruleId, limit: 100 }).filter((run) => run.status !== 'running');
    if (runs.length >= count) return runs;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${count} settled run(s)`);
}

const refreshRule = (id, extra = {}) => ({
  id,
  on: 'ci.finalized',
  actions: [{ type: 'mcp', tool: 'refresh_pr', args: { id: '{{pr.id}}' } }],
  ...extra,
});

let app;

beforeEach(() => {
  initDb(':memory:');
  nowMs = Date.parse(NOW);
  app = fakeApp();
});

afterEach(async () => {
  await stopRulesEngine({ drain: true });
  closeDb();
});

test('rule loading rejects invalid rules individually and keeps the valid ones', () => {
  startRulesEngine(
    app,
    {
      rules: [
        refreshRule('ok'),
        { id: 'loop', on: 'session.idle', actions: [{ type: 'dispatch_claude', prompt: 'go' }] },
        { id: 'unknown-tool', on: 'ci.finalized', actions: [{ type: 'mcp', tool: 'no_such_tool' }] },
        { id: 'read-only', on: 'ci.finalized', actions: [{ type: 'mcp', tool: 'get_pr', args: { id: 'x' } }] },
        refreshRule('dangling-consume', { consume_on: 'fire' }),
        {
          id: 'bad-where',
          on: 'session.idle',
          where: { repo: 'acme/widgets' },
          actions: [{ type: 'mcp', tool: 'trigger_sync' }],
        },
        {
          id: 'sub-on-idle',
          on: 'session.idle',
          requires_subscription: true,
          actions: [{ type: 'mcp', tool: 'trigger_sync' }],
        },
        refreshRule('ok'),
      ],
    },
    clock,
  );

  assert.deepEqual(
    getRules().map((rule) => rule.id),
    ['ok'],
  );
  const errors = Object.fromEntries(getRuleLoadErrors().map((entry) => [entry.rule_id, entry.error]));
  assert.match(errors.loop, /self-dispatch loop/);
  assert.match(errors['unknown-tool'], /unknown tool: no_such_tool/);
  assert.match(errors['read-only'], /not rule-fireable|mcp-only/);
  assert.match(errors['dangling-consume'], /consume_on requires requires_subscription/);
  assert.match(errors['bad-where'], /where field 'repo' is not valid for trigger 'session.idle'/);
  assert.match(errors['sub-on-idle'], /requires_subscription is only supported on PR triggers/);
  assert.equal(errors.ok, 'duplicate rule id');
  assert.equal(getRules()[0].cooldown_minutes, 10, 'defaults are applied by the schema');
});

test('a ci.finalized rule fires its templated action once and then respects the cooldown window', async () => {
  insertPr('acme/widgets#1');
  startRulesEngine(
    app,
    { rules: [refreshRule('refresh', { where: { repo: 'acme/widgets', ci_status: 'fail' } })] },
    clock,
  );

  emitCiFinalized('acme/widgets#1', 'fail');
  const [run] = await settledRuns(1);
  assert.equal(run.status, 'success');
  assert.equal(run.trigger, 'ci.finalized');
  assert.equal(run.pr_id, 'acme/widgets#1');
  assert.equal(run.started_at, NOW, 'run timestamps come from the injected clock');
  assert.equal('cooldown_key' in run, false, 'internal fields are stripped from the public row');
  assert.deepEqual(app.calls, [{ method: 'POST', url: '/api/prs/acme%2Fwidgets%231/refresh', payload: undefined }]);

  // Same PR, inside the 10 minute cooldown: no new run.
  emitCiFinalized('acme/widgets#1', 'fail');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(listRuleRuns().length, 1);

  // A pass does not match where.ci_status, even after the window.
  nowMs += 11 * 60_000;
  emitCiFinalized('acme/widgets#1', 'pass');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(listRuleRuns().length, 1);

  // Same event key again is deduped even outside the window; a fresh GitHub
  // update (new updated_at) is what makes it a new trigger.
  emitCiFinalized('acme/widgets#1', 'fail');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(listRuleRuns().length, 1);

  emitCiFinalized('acme/widgets#1', 'fail', { updated_at: new Date(nowMs).toISOString() });
  const runs = await settledRuns(2);
  assert.equal(runs.length, 2);
  assert.equal(app.calls.length, 2);
});

test('subscription rules fire only for subscribed PRs and consume_on=trigger drops the subscription on the next event', async () => {
  insertPr('acme/widgets#1');
  insertPr('acme/widgets#2');
  startRulesEngine(
    app,
    {
      rules: [
        refreshRule('watch', {
          requires_subscription: true,
          consume_on: 'trigger',
          where: { ci_status: 'fail' },
          cooldown_minutes: 0,
        }),
      ],
    },
    clock,
  );

  assert.deepEqual(subscribeRule('watch', 'acme/widgets#1'), {
    rule_id: 'watch',
    pr_id: 'acme/widgets#1',
    created: true,
  });
  assert.equal(subscribeRule('watch', 'acme/widgets#1').created, false, 'subscribe is idempotent');
  assert.throws(() => subscribeRule('watch', 'acme/widgets#9'), /pr not found/);
  assert.throws(() => subscribeRule('nope', 'acme/widgets#1'), /unknown rule/);

  // Unsubscribed PR: nothing fires.
  emitCiFinalized('acme/widgets#2', 'fail');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(listRuleRuns().length, 0);

  // Subscribed PR with a non-matching where: the trigger still consumes the subscription.
  emitCiFinalized('acme/widgets#1', 'pass');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(listRuleRuns().length, 0);
  assert.deepEqual(listSubscriptions({ rule_id: 'watch' }), []);

  // Re-subscribe, matching event: fires and consumes.
  subscribeRule('watch', 'acme/widgets#1');
  emitCiFinalized('acme/widgets#1', 'fail');
  const [run] = await settledRuns(1);
  assert.equal(run.status, 'success');
  assert.deepEqual(listSubscriptions({ pr_id: 'acme/widgets#1' }), []);

  subscribeRule('watch', 'acme/widgets#1');
  assert.deepEqual(unsubscribeRule('watch', 'acme/widgets#1'), { rule_id: 'watch', pr_id: 'acme/widgets#1' });
  assert.deepEqual(listSubscriptions(), []);
});

test('manual runs enforce cooldown unless forced and validate their target', async () => {
  insertPr('acme/widgets#1');
  startRulesEngine(
    app,
    {
      rules: [
        refreshRule('refresh'),
        { id: 'idle', on: 'session.idle', actions: [{ type: 'mcp', tool: 'trigger_sync' }] },
      ],
    },
    clock,
  );

  await assert.rejects(manualRunRule('missing'), /unknown rule/);
  await assert.rejects(manualRunRule('refresh'), /pr_id required/);
  await assert.rejects(manualRunRule('refresh', { pr_id: 'acme/widgets#9' }), /pr not found/);
  await assert.rejects(manualRunRule('idle'), /session_id required/);
  await assert.rejects(manualRunRule('idle', { session_id: 'nope' }), /session not found/);

  const first = await manualRunRule('refresh', { pr_id: 'acme/widgets#1' });
  assert.equal(first.status, 'success');
  await assert.rejects(manualRunRule('refresh', { pr_id: 'acme/widgets#1' }), /cooldown active/);
  const forced = await manualRunRule('refresh', { pr_id: 'acme/widgets#1', force: true });
  assert.equal(forced.status, 'success');
  assert.equal(app.calls.length, 2);
});

test('session.idle rules fire for scratch workspaces that match and ignore work-item sessions', async () => {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, pr_id, name, path, bookmark, repo, status, created_at, operation_state)
     VALUES ('scratch', NULL, 'scratch', '/tmp/scratch', 'feature', 'acme/widgets', 'active', ?, 'ready')`,
  ).run(NOW);
  db.prepare(
    "INSERT INTO sessions (id, workspace_id, pid, status, started_at) VALUES ('s1', 'scratch', 1, 'active', ?)",
  ).run(NOW);
  startRulesEngine(
    app,
    {
      rules: [
        {
          id: 'on-idle',
          on: 'session.idle',
          where: { workspace_repo: 'acme/widgets' },
          cooldown_minutes: 0,
          actions: [{ type: 'mcp', tool: 'trigger_sync' }],
        },
      ],
    },
    clock,
  );

  appEvents.emit('session-state', { sessionId: 's1', workspaceId: 'scratch', state: 'working' });
  appEvents.emit('session-state', { sessionId: 's1', workspaceId: 'scratch', state: 'idle', confirmed: false });
  appEvents.emit('session-state', { sessionId: 'wi', workItemId: 'item', state: 'idle' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(listRuleRuns().length, 0);

  appEvents.emit('session-state', { sessionId: 's1', workspaceId: 'scratch', state: 'idle' });
  const [run] = await settledRuns(1);
  assert.equal(run.status, 'success');
  assert.equal(run.session_id, 's1');
  assert.equal(run.workspace_id, 'scratch');
  assert.deepEqual(app.calls, [{ method: 'POST', url: '/api/sync/trigger', payload: undefined }]);

  const manual = await manualRunRule('on-idle', { session_id: 's1' });
  assert.equal(manual.status, 'success');
});

test('run-all and subscribe-all report fired, skipped and already-subscribed PRs', async () => {
  insertPr('acme/widgets#1', { checks: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] });
  insertPr('acme/widgets#2', { checks: [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }] });
  insertPr('acme/gadgets#3', { repo: 'gadgets', checks: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  startRulesEngine(
    app,
    {
      rules: [
        refreshRule('bulk', { requires_subscription: true, where: { ci_status: 'fail' } }),
        { id: 'idle', on: 'session.idle', actions: [{ type: 'mcp', tool: 'trigger_sync' }] },
      ],
    },
    clock,
  );

  assert.throws(() => runRuleForAll('idle'), /only supported on PR triggers/);
  assert.throws(() => subscribeRuleForAll('nope'), /unknown rule/);

  subscribeRule('bulk', 'acme/widgets#1');
  const bulk = subscribeRuleForAll('bulk');
  assert.deepEqual(bulk, {
    subscribed: [{ pr_id: 'acme/widgets#2' }],
    already_subscribed: [{ pr_id: 'acme/widgets#1' }],
    skipped: [],
  });

  unsubscribeRule('bulk', 'acme/widgets#2');
  const first = runRuleForAll('bulk');
  assert.deepEqual(first.skipped, [{ pr_id: 'acme/widgets#2', reason: 'not_subscribed' }]);
  assert.deepEqual(
    first.fired.map((entry) => entry.pr_id),
    ['acme/widgets#1'],
  );
  await settledRuns(1);

  const second = runRuleForAll('bulk', { subscribe: true });
  assert.deepEqual(second.skipped, [{ pr_id: 'acme/widgets#1', reason: 'cooldown' }]);
  assert.deepEqual(
    second.fired.map((entry) => entry.pr_id),
    ['acme/widgets#2'],
  );
  const runs = await settledRuns(2, { ruleId: 'bulk' });
  assert.deepEqual(
    runs.map((run) => run.status),
    ['success', 'success'],
  );
  assert.equal(listRuleRuns({ pr_id: 'acme/widgets#1' }).length, 1);
  assert.equal(listRuleRuns({ limit: 1 }).length, 1);
});
