import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  checkToStatus,
  isFailedCheck,
  isMergeReady,
  isPassedCheck,
  isRunningCheck,
  isScheduledCheck,
  statusColorGroup,
} from './checks.js';

/** @param {string} status @param {string | null} conclusion */
const check = (status, conclusion) => ({ name: 'ci', status, conclusion, url: null });

test('check classification covers CheckRun conclusions and StatusContext states', () => {
  assert.equal(isFailedCheck(check('COMPLETED', 'FAILURE')), true);
  assert.equal(isFailedCheck(check('COMPLETED', 'TIMED_OUT')), true);
  assert.equal(isFailedCheck(check('ERROR', null)), true, 'a StatusContext error state has no conclusion');
  assert.equal(isFailedCheck(check('COMPLETED', 'SUCCESS')), false);

  assert.equal(isPassedCheck(check('COMPLETED', 'SUCCESS')), true);
  assert.equal(isPassedCheck(check('COMPLETED', 'SKIPPED')), true);
  assert.equal(isPassedCheck(check('SUCCESS', null)), true);
  assert.equal(isPassedCheck(check('COMPLETED', 'FAILURE')), false);

  assert.equal(isRunningCheck(check('IN_PROGRESS', null)), true);
  assert.equal(isRunningCheck(check('IN_PROGRESS', 'SUCCESS')), false, 'a conclusion means it finished');

  assert.equal(isScheduledCheck(check('QUEUED', null)), true);
  assert.equal(isScheduledCheck(check('PENDING', null)), true);
  assert.equal(isScheduledCheck(check('IN_PROGRESS', null)), false);
  assert.equal(isScheduledCheck(check('COMPLETED', 'SUCCESS')), false);
});

test('checkToStatus prefers the conclusion and statusColorGroup maps every display status', () => {
  assert.equal(checkToStatus(check('COMPLETED', 'FAILURE')), 'FAILURE');
  assert.equal(checkToStatus(check('COMPLETED', 'NEUTRAL')), 'NEUTRAL');
  assert.equal(checkToStatus(check('QUEUED', null)), 'QUEUED');
  assert.equal(checkToStatus(check('', null)), 'PENDING');

  assert.equal(statusColorGroup('SUCCESS'), 'green');
  assert.equal(statusColorGroup('TIMED_OUT'), 'red');
  assert.equal(statusColorGroup('IN_PROGRESS'), 'blue');
  assert.equal(statusColorGroup('EXPECTED'), 'yellow');
  assert.equal(statusColorGroup('SOMETHING_ELSE'), 'gray');
});

test('isMergeReady requires passing CI, a clean merge, approval and a non-draft PR', () => {
  const ready = { ci_status: 'pass', mergeable: 'MERGEABLE', review_status: 'approved', draft: false };
  assert.equal(isMergeReady(/** @type {any} */ (ready)), true);
  for (const change of [
    { ci_status: 'pending' },
    { mergeable: 'CONFLICTING' },
    { review_status: 'changes_requested' },
    { draft: true },
  ]) {
    assert.equal(isMergeReady(/** @type {any} */ ({ ...ready, ...change })), false, JSON.stringify(change));
  }
});
