import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PrReadFence } from './pr-read-fence.js';
import { reviewRevision } from './review-revision.js';

test('review revisions distinguish coherent tuples and unknown values', () => {
  const revision = reviewRevision('abc', 'title', '');
  assert.match(revision, /^review-revision-v1:[a-f0-9]{64}$/);
  assert.equal(reviewRevision(null, 'title', ''), null);
  assert.equal(reviewRevision('abc', 'title', null), null);
  assert.notEqual(revision, reviewRevision('def', 'title', ''));
  assert.notEqual(revision, reviewRevision('abc', 'other', ''));
  assert.notEqual(revision, reviewRevision('abc', 'title', 'body'));
  assert.notEqual(reviewRevision('ab', 'c', 'd'), reviewRevision('a', 'bc', 'd'));
});

test('accepted no-ops and removals fence older reads until they settle', () => {
  const fence = new PrReadFence();
  const old = fence.begin();
  const recent = fence.begin();
  fence.accept(recent, ['pr:1', 'target:1']);
  fence.end(recent);
  assert.equal(fence.accepts(old, 'pr:1'), false);
  assert.equal(fence.accepts(old, 'target:1'), false);
  assert.equal(fence.accepts(old, 'unrelated'), true);
  fence.end(old);
  assert.equal(fence.accepts(old, 'pr:1'), false);
  const next = fence.begin();
  assert.equal(fence.accepts(next, 'pr:1'), true);
});

test('generation invalidation rejects every old observation', () => {
  const fence = new PrReadFence();
  const old = fence.begin();
  fence.invalidate();
  assert.equal(fence.current(old), false);
  fence.accept(old, ['pr:1']);
  assert.equal(fence.accepts(fence.begin(), 'pr:1'), true);
});
