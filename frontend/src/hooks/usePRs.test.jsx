import assert from 'node:assert/strict';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { usePRs } from './usePRs.js';

const state = vi.hoisted(() => ({
  handlers: new Map(),
  fetchPRs: vi.fn(),
  fetchConfig: vi.fn(),
  triggerSync: vi.fn(),
}));

vi.mock('../lib/api.js', () => ({
  fetchPRs: state.fetchPRs,
  fetchConfig: state.fetchConfig,
  triggerSync: state.triggerSync,
}));

vi.mock('../lib/event-stream.js', () => ({
  subscribeAppEvent: vi.fn((name, handler) => {
    state.handlers.set(name, handler);
    return () => state.handlers.delete(name);
  }),
}));

/** @template T */
function deferred() {
  /** @type {(value: T) => void} */
  let resolve = /** @param {T} _value */ (_value) => {};
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

const firstPR = /** @type {import('../types').PullRequest} */ ({ id: 'first', number: 1, title: 'First' });
const secondPR = /** @type {import('../types').PullRequest} */ ({ id: 'second', number: 2, title: 'Second' });

beforeEach(() => {
  state.handlers.clear();
  state.fetchPRs.mockReset();
  state.fetchConfig.mockReset().mockResolvedValue({ poll: { interval_seconds: 600 } });
  state.triggerSync.mockReset();
});

test('does not let an older PR request overwrite a newer local-change refresh', async () => {
  const first = deferred();
  const second = deferred();
  state.fetchPRs.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result } = renderHook(() => usePRs({}, true));

  await waitFor(() => assert.equal(state.fetchPRs.mock.calls.length, 1));
  act(() => state.handlers.get('local-change')?.());
  await waitFor(() => assert.equal(state.fetchPRs.mock.calls.length, 2));

  await act(async () => {
    second.resolve({ prs: [secondPR], synced_at: null, freshness: null });
    await second.promise;
  });
  assert.deepEqual(result.current.prs, [secondPR]);

  await act(async () => {
    first.resolve({ prs: [firstPR], synced_at: null, freshness: null });
    await first.promise;
  });
  assert.deepEqual(result.current.prs, [secondPR]);
});

test('settles without requesting PRs when polling is disabled', async () => {
  const { result } = renderHook(() => usePRs({}, false));
  await waitFor(() => assert.equal(result.current.loading, false));
  assert.equal(result.current.loaded, false);
  assert.equal(state.fetchPRs.mock.calls.length, 0);
});
