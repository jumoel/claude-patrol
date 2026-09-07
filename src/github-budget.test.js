import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubBudget } from './github-budget.js';

const resetAt = new Date(Date.now() + 3600_000).toISOString();
test('optional work waits for a measured full cycle and valid telemetry', () => {
  const budget = new GitHubBudget();
  assert.equal(budget.admits(60, 1), false);
  budget.observe(budget.begin(), { cost: 3, remaining: 4900, resetAt });
  assert.equal(budget.admits(60, 1), false);
  budget.cycle(true, 3);
  assert.equal(budget.admits(60, 1), true);
  budget.observe(budget.begin(), null);
  assert.equal(budget.admits(60, 1), false);
  assert.equal(budget.remaining, 4899);
});

test('late balances cannot restore spent quota, in-flight reservations count', () => {
  const budget = new GitHubBudget();
  const first = budget.begin(5);
  const second = budget.begin(5);
  budget.observe(second, { cost: 3, remaining: 300, resetAt });
  budget.cycle(true, 3);
  assert.equal(budget.admits(60, 100), false);
  budget.observe(first, { cost: 3, remaining: 400, resetAt });
  assert.equal(budget.remaining, 300);
  const nextReset = new Date(Date.parse(resetAt) + 3600_000).toISOString();
  budget.observe(budget.begin(), { cost: 1, remaining: 4999, resetAt: nextReset });
  budget.observe(budget.begin(), { cost: 1, remaining: 200, resetAt });
  assert.equal(budget.remaining, 4999);
});
