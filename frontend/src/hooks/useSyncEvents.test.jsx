import assert from 'node:assert/strict';
import { renderHook } from '@testing-library/react';
import { test, vi } from 'vitest';

const listeners = new Set();
vi.mock('../lib/event-stream.js', () => ({
  subscribeAppEvent: (/** @type {string} */ _type, /** @type {() => void} */ listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
}));

const { useSyncEvents } = await import('./useSyncEvents.js');

test('a cleanup returned by the callback runs before the next sync and on unmount', () => {
  const events = /** @type {string[]} */ ([]);
  let run = 0;
  const callback = () => {
    const id = ++run;
    events.push(`start ${id}`);
    return () => events.push(`cleanup ${id}`);
  };
  const { unmount } = renderHook(() => useSyncEvents(callback));
  assert.equal(listeners.size, 1);

  for (const listener of listeners) listener();
  for (const listener of listeners) listener();
  assert.deepEqual(events, ['start 1', 'cleanup 1', 'start 2']);

  unmount();
  assert.deepEqual(events, ['start 1', 'cleanup 1', 'start 2', 'cleanup 2']);
  assert.equal(listeners.size, 0);
});

test('callbacks without a cleanup are called once per sync', () => {
  let calls = 0;
  renderHook(() =>
    useSyncEvents(() => {
      calls += 1;
    }),
  );
  for (const listener of listeners) listener();
  assert.equal(calls, 1);
});
