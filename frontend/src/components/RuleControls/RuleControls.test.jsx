import assert from 'node:assert/strict';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, test, vi } from 'vitest';
import { RuleControls } from './RuleControls.jsx';

const api = vi.hoisted(() => ({
  fetchPRRuleSubscriptions: vi.fn(),
  fetchRules: vi.fn(),
  runRuleManually: vi.fn(),
  subscribeRuleForPR: vi.fn(),
  unsubscribeRuleForPR: vi.fn(),
}));
const eventStream = vi.hoisted(() => ({
  ruleRunHandlers: /** @type {Set<(event: MessageEvent<string>) => void>} */ (new Set()),
}));

vi.mock('../../lib/api.js', () => api);
vi.mock('../../lib/event-stream.js', () => ({
  subscribeAppEvent: vi.fn((type, handler) => {
    if (type !== 'rule-run') return () => {};
    eventStream.ruleRunHandlers.add(handler);
    return () => eventStream.ruleRunHandlers.delete(handler);
  }),
}));

const PR_ID = 'acme/api#7';

/** @type {import('../../types').RuleDefinition[]} */
const RULES = [
  {
    id: 'auto-fix-ci',
    on: 'ci.finalized',
    manual: false,
    requires_subscription: true,
    consume_on: 'fire',
    cooldown_minutes: 0,
    actions: [],
  },
  {
    id: 'label-triage',
    on: 'labels.changed',
    manual: false,
    requires_subscription: false,
    cooldown_minutes: 10,
    actions: [],
  },
  {
    id: 'idle-nudge',
    on: 'session.idle',
    manual: false,
    requires_subscription: false,
    cooldown_minutes: 0,
    actions: [],
  },
];

/** @type {import('../../types').RuleSubscription[]} */
let subscriptions = [];

/** @param {Partial<import('../../types').RuleRun>} run */
function emitRuleRun(run) {
  act(() => {
    for (const handler of eventStream.ruleRunHandlers) {
      handler(new MessageEvent('rule-run', { data: JSON.stringify(run) }));
    }
  });
}

/** @template T */
function deferred() {
  /** @type {(value: T) => void} */
  let resolve = /** @param {T} _value */ (_value) => {};
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  eventStream.ruleRunHandlers.clear();
  subscriptions = [];
  api.fetchRules.mockResolvedValue({ rules: RULES, errors: [] });
  api.fetchPRRuleSubscriptions.mockImplementation(async () => subscriptions);
  api.subscribeRuleForPR.mockImplementation(async (ruleId, prId) => {
    subscriptions = [{ rule_id: ruleId, pr_id: prId, created_at: '2026-08-30T10:00:00.000Z' }];
    return { rule_id: ruleId, pr_id: prId, created: true };
  });
  api.unsubscribeRuleForPR.mockImplementation(async (ruleId, prId) => {
    subscriptions = [];
    return { rule_id: ruleId, pr_id: prId };
  });
});

test('loads PR rules collapsed and offers a subscription toggle only for rules that require one', async () => {
  const user = userEvent.setup();
  render(<RuleControls prId={PR_ID} />);

  assert.ok(await screen.findByText('2 available'));
  assert.ok(screen.getByText('0 subscribed'));
  assert.equal(api.fetchRules.mock.calls.length, 1);
  assert.deepEqual(api.fetchPRRuleSubscriptions.mock.calls, [[PR_ID]]);
  const disclosure = screen.getByRole('button', { name: /Rules/ });
  assert.equal(disclosure.getAttribute('aria-expanded'), 'false');
  assert.equal(screen.queryByText('auto-fix-ci'), null);

  await user.click(disclosure);
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
  assert.ok(screen.getByText('auto-fix-ci'));
  assert.ok(screen.getByText('on ci.finalized'));
  assert.ok(screen.getByText('Not subscribed'));
  assert.ok(screen.getByRole('button', { name: 'Arm' }));
  assert.ok(screen.getByText('label-triage'));
  assert.ok(screen.getByText('Auto on all'));
  assert.equal(screen.getAllByRole('button', { name: 'Run now' }).length, 2);
  assert.equal(screen.queryByRole('button', { name: 'Subscribe' }), null);
  assert.equal(screen.queryByText('idle-nudge'), null, 'session-triggered rules are not PR rules');
});

test('Arm subscribes the PR and Unsubscribe removes it, refreshing the badge each time', async () => {
  const user = userEvent.setup();
  render(<RuleControls prId={PR_ID} />);
  await screen.findByText('2 available');
  await user.click(screen.getByRole('button', { name: /Rules/ }));

  await user.click(screen.getByRole('button', { name: 'Arm' }));
  assert.deepEqual(api.subscribeRuleForPR.mock.calls, [['auto-fix-ci', PR_ID]]);
  assert.ok(await screen.findByText('Armed (fires once)'));
  assert.ok(screen.getByText('1 subscribed'));
  assert.equal(api.fetchPRRuleSubscriptions.mock.calls.length, 2);

  await user.click(screen.getByRole('button', { name: 'Unsubscribe' }));
  assert.deepEqual(api.unsubscribeRuleForPR.mock.calls, [['auto-fix-ci', PR_ID]]);
  assert.ok(await screen.findByText('Not subscribed'));
  assert.ok(screen.getByRole('button', { name: 'Arm' }));
  assert.ok(screen.getByText('0 subscribed'));
});

test('starts expanded when the PR is already subscribed and reloads after a successful rule run', async () => {
  subscriptions = [{ rule_id: 'auto-fix-ci', pr_id: PR_ID, created_at: '2026-08-30T10:00:00.000Z' }];
  render(<RuleControls prId={PR_ID} />);

  assert.ok(await screen.findByText('Armed (fires once)'));
  assert.equal(screen.getByRole('button', { name: /Rules/ }).getAttribute('aria-expanded'), 'true');
  assert.equal(api.fetchPRRuleSubscriptions.mock.calls.length, 1);

  subscriptions = [];
  emitRuleRun({ pr_id: 'acme/api#8', status: 'success', ended_at: '2026-08-30T10:05:00.000Z' });
  emitRuleRun({ pr_id: PR_ID, status: 'running', ended_at: null });
  emitRuleRun({ pr_id: PR_ID, status: 'error', ended_at: '2026-08-30T10:05:00.000Z' });
  assert.equal(api.fetchPRRuleSubscriptions.mock.calls.length, 1, 'other PRs and unfinished runs do not reload');

  emitRuleRun({ pr_id: PR_ID, status: 'success', ended_at: '2026-08-30T10:05:00.000Z' });
  await waitFor(() => assert.equal(api.fetchPRRuleSubscriptions.mock.calls.length, 2));
  assert.ok(await screen.findByText('Not subscribed'));
});

test('Run now fires the rule with force, locks the row while running, and surfaces a failed run', async () => {
  const user = userEvent.setup();
  const pending = /** @type {ReturnType<typeof deferred<import('../../types').RuleRun>>} */ (deferred());
  api.runRuleManually.mockReturnValueOnce(pending.promise);
  render(<RuleControls prId={PR_ID} />);
  await screen.findByText('2 available');
  await user.click(screen.getByRole('button', { name: /Rules/ }));

  await user.click(screen.getAllByRole('button', { name: 'Run now' })[0]);
  assert.deepEqual(api.runRuleManually.mock.calls, [['auto-fix-ci', { pr_id: PR_ID, force: true }]]);
  const running = /** @type {HTMLButtonElement} */ (screen.getByRole('button', { name: 'Running...' }));
  assert.equal(running.disabled, true);
  assert.equal(/** @type {HTMLButtonElement} */ (screen.getByRole('button', { name: 'Arm' })).disabled, true);

  await act(async () => {
    pending.resolve(
      /** @type {import('../../types').RuleRun} */ ({ id: 'run-1', rule_id: 'auto-fix-ci', status: 'success' }),
    );
    await pending.promise;
  });
  assert.equal(screen.getAllByRole('button', { name: 'Run now' }).length, 2);
  assert.equal(/** @type {HTMLButtonElement} */ (screen.getByRole('button', { name: 'Arm' })).disabled, false);

  api.runRuleManually.mockRejectedValueOnce(new Error('session_busy'));
  await user.click(screen.getAllByRole('button', { name: 'Run now' })[1]);
  assert.deepEqual(api.runRuleManually.mock.calls[1], ['label-triage', { pr_id: PR_ID, force: true }]);
  assert.ok(await screen.findByText('Could not load rules: session_busy'));
});

test('a failed load expands the section and shows the error', async () => {
  api.fetchRules.mockRejectedValue(new Error('rules.json is invalid'));
  render(<RuleControls prId={PR_ID} />);

  assert.ok(await screen.findByText('Could not load rules: rules.json is invalid'));
  const disclosure = screen.getByRole('button', { name: /Rules/ });
  assert.equal(disclosure.getAttribute('aria-expanded'), 'true');
  assert.ok(screen.getByText('Could not load rules'));
  assert.equal(screen.queryByRole('button', { name: 'Run now' }), null);
});
