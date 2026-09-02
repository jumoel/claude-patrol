import assert from 'node:assert/strict';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { useCopyFeedback } from './useCopyFeedback.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test('copy writes the clipboard, reports the marker, and resets after the delay', async () => {
  const written = /** @type {string[]} */ ([]);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (/** @type {string} */ text) => {
        written.push(text);
      },
    },
  });
  const { result } = renderHook(() => useCopyFeedback({ resetMs: 1000 }));
  assert.equal(result.current.status, 'idle');

  await act(async () => {
    await result.current.copy('/tmp/one', 'one');
  });
  assert.deepEqual(written, ['/tmp/one']);
  assert.equal(result.current.status, 'copied');
  assert.equal(result.current.marker, 'one');

  act(() => vi.advanceTimersByTime(1000));
  assert.equal(result.current.status, 'idle');
  assert.equal(result.current.marker, null);
});

test('a clipboard failure reports error and unmount clears the pending reset', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async () => Promise.reject(new Error('denied')) },
  });
  const { result, unmount } = renderHook(() => useCopyFeedback());
  await act(async () => {
    await result.current.copy('x');
  });
  assert.equal(result.current.status, 'error');
  unmount();
  assert.equal(vi.getTimerCount(), 0, 'the reset timer is cleared on unmount');
});
