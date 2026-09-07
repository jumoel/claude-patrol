import assert from 'node:assert/strict';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { useReviewRequests } from './useReviewRequests.js';

const state = vi.hoisted(() => ({ handlers: new Map(), fetch: vi.fn(), acknowledge: vi.fn(), refresh: vi.fn() }));
vi.mock('../lib/api.js', () => ({
  fetchReviewRequests: state.fetch,
  acknowledgeReviewRequest: state.acknowledge,
  refreshReviewRequests: state.refresh,
}));
vi.mock('../lib/event-stream.js', () => ({
  subscribeAppEvent: (/** @type {string} */ name, /** @type {() => void} */ handler) => {
    state.handlers.set(name, handler);
    return () => state.handlers.delete(name);
  },
}));

const row = (/** @type {string} */ id) =>
  /** @type {import('../types').ReviewRequestRow} */ ({ id, title: id, state_version: id, collapsed: false });
/** @param {string[]} ids @param {string} [version] @param {string | null} [cursor] */
const page = (ids, version = 'v1', cursor = null) => ({
  rows: ids.map(row),
  list_version: version,
  next_cursor: cursor,
  total_count: 3,
  source: { enabled: true, identity_verified: true, stale: false, incomplete: false, errors: [], synced_at: 'now' },
});
beforeEach(() => {
  state.handlers.clear();
  state.fetch.mockReset();
  state.acknowledge.mockReset();
  state.refresh.mockReset();
});

test('disabled review watching does not fetch or subscribe', () => {
  renderHook(() => useReviewRequests(false, 'plan'));
  assert.equal(state.fetch.mock.calls.length, 0);
  assert.equal(state.handlers.size, 0);
});

test('reconnecting reconciles local rows without starting a GitHub refresh', async () => {
  state.fetch.mockResolvedValue(page(['one']));
  const { result } = renderHook(() => useReviewRequests(true, 'plan'));
  await waitFor(() => assert.equal(result.current.rows.length, 1));
  await act(async () => state.handlers.get('open')());
  assert.equal(state.fetch.mock.calls.length, 3);
  assert.equal(state.refresh.mock.calls.length, 0);
});

test('a superseded acknowledgement cannot restore an error or busy state', async () => {
  let reject = (/** @type {Error} */ _error) => {};
  state.fetch.mockResolvedValue(page(['one']));
  state.acknowledge.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const { result, rerender } = renderHook(({ plan }) => useReviewRequests(true, plan), {
    initialProps: { plan: 'old' },
  });
  await waitFor(() => assert.equal(result.current.rows.length, 1));
  let pending = Promise.resolve();
  act(() => {
    pending = result.current.toggle(result.current.rows[0]);
  });
  rerender({ plan: 'new' });
  await waitFor(() => assert.equal(result.current.rows.length, 1));
  await act(async () => {
    reject(new Error('Old request failed'));
    await pending;
  });
  assert.equal(result.current.error, null);
  assert.equal(result.current.busy.size, 0);
  assert.equal(state.fetch.mock.calls.length, 2);
});

test('freshness events preserve loaded pages and never call remote refresh', async () => {
  state.fetch.mockResolvedValueOnce(page(['one'], 'v1', 'cursor')).mockResolvedValueOnce(page(['two']));
  const { result } = renderHook(() => useReviewRequests(true, 'plan'));
  await waitFor(() => assert.equal(result.current.rows.length, 1));
  await act(() => result.current.loadMore());
  assert.deepEqual(
    result.current.rows.map((item) => item.id),
    ['one', 'two'],
  );
  state.fetch.mockResolvedValueOnce(page([], 'v1')).mockResolvedValueOnce(page(['one', 'two']));
  await act(async () => {
    state.handlers.get('review-request-change')();
  });
  await waitFor(() => assert.equal(state.fetch.mock.calls.length, 4));
  assert.deepEqual(
    result.current.rows.map((item) => item.id),
    ['one', 'two'],
  );
  assert.equal(state.refresh.mock.calls.length, 0);
  assert.deepEqual(state.fetch.mock.calls[2][0], { status_only: 'true' });
  assert.deepEqual(state.fetch.mock.calls[3][0], { ids: 'one,two' });
});

test('an old load-more response cannot append after ordering is invalidated', async () => {
  let finish = (/** @type {ReturnType<typeof page>} */ _value) => {};
  state.fetch.mockResolvedValueOnce(page(['one'], 'v1', 'cursor')).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = renderHook(() => useReviewRequests(true, 'plan'));
  await waitFor(() => assert.equal(result.current.rows.length, 1));
  let pending = Promise.resolve();
  act(() => {
    pending = result.current.loadMore();
  });
  state.fetch.mockResolvedValueOnce(page([], 'v2')).mockResolvedValueOnce(page(['new'], 'v2'));
  act(() => state.handlers.get('review-request-change')());
  await waitFor(() => assert.equal(result.current.rows[0].id, 'new'));
  await act(async () => {
    finish(page(['old'], 'v1'));
    await pending;
  });
  assert.deepEqual(
    result.current.rows.map((item) => item.id),
    ['new'],
  );
});

test('a failed acknowledgement stays visible and does not optimistically collapse', async () => {
  state.fetch.mockResolvedValue(page(['one']));
  state.acknowledge.mockRejectedValue(new Error('Verification quota exhausted'));
  const { result } = renderHook(() => useReviewRequests(true, 'plan'));
  await waitFor(() => assert.equal(result.current.rows.length, 1));
  await act(() => result.current.toggle(result.current.rows[0]));
  assert.equal(result.current.rows[0].collapsed, false);
  assert.ok(result.current.error instanceof Error);
  assert.match(result.current.error.message, /quota/);
});
