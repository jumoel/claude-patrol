import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveCIStatus } from './pr-status.js';

test('CI status handles CheckRun conclusions and StatusContext states consistently', () => {
  assert.equal(deriveCIStatus([{ status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'pass');
  assert.equal(deriveCIStatus([{ status: 'SUCCESS', conclusion: null }]), 'pass');
  assert.equal(deriveCIStatus([{ status: 'COMPLETED', conclusion: 'FAILURE' }]), 'fail');
  assert.equal(deriveCIStatus([{ status: 'FAILURE', conclusion: null }]), 'fail');
  assert.equal(deriveCIStatus([{ status: 'ERROR', conclusion: null }]), 'fail');
  assert.equal(deriveCIStatus([{ status: 'PENDING', conclusion: null }]), 'pending');
});
