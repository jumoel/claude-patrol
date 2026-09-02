import assert from 'node:assert/strict';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { useWorkItem, useWorkItems } from './useWorkItems.js';

const api = vi.hoisted(() => ({ fetchWorkItem: vi.fn(), fetchWorkItems: vi.fn() }));
const eventStream = vi.hoisted(() => ({
  handlers: /** @type {Map<string, Set<(event: MessageEvent<string>) => void>>} */ (new Map()),
}));

vi.mock('../lib/api.js', () => api);
vi.mock('../lib/event-stream.js', () => ({
  subscribeAppEvent: vi.fn((type, handler) => {
    const handlers = eventStream.handlers.get(type) ?? new Set();
    eventStream.handlers.set(type, handlers);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) eventStream.handlers.delete(type);
    };
  }),
}));

/** @param {string} id @returns {import('../types').WorkItemListItem} */
function listItem(id) {
  return /** @type {import('../types').WorkItemListItem} */ ({ id, title: `Work ${id}`, state: 'ready' });
}

/** @param {string} id @returns {import('../types').WorkItemDetail} */
function detail(id) {
  return /** @type {import('../types').WorkItemDetail} */ ({
    id,
    title: `Work ${id}`,
    state: 'ready',
    root_path: '/tmp',
  });
}

/** @param {string} type @param {unknown} payload */
function emit(type, payload) {
  act(() => {
    for (const handler of eventStream.handlers.get(type) ?? []) {
      handler(new MessageEvent(type, { data: JSON.stringify(payload) }));
    }
  });
}

/** A request that only ever settles by rejecting with AbortError once its signal aborts. */
/** @param {AbortSignal | undefined} signal @returns {Promise<never>} */
function abortable(signal) {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
}

/** @type {(AbortSignal | undefined)[]} */
let signals = [];

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  eventStream.handlers.clear();
  signals = [];
});

test('the list loads, exposes reload, and refreshes on local changes and work-item task events', async () => {
  const items = [listItem('wi-1')];
  api.fetchWorkItems.mockImplementation(async (signal) => {
    signals.push(signal);
    return { work_items: items };
  });
  const { result } = renderHook(() => useWorkItems());

  assert.equal(result.current.loading, true);
  assert.equal(result.current.loaded, false);
  await waitFor(() => assert.equal(result.current.loaded, true));
  assert.equal(result.current.loading, false);
  assert.equal(result.current.error, null);
  assert.deepEqual(result.current.workItems, items);
  assert.ok(signals[0] instanceof AbortSignal);

  emit('task-update', { kind: 'session.start' });
  emit('task-update', 'not an object');
  assert.equal(api.fetchWorkItems.mock.calls.length, 1, 'unrelated tasks do not reload');
  emit('task-update', { kind: 'work-item.create', context: {} });
  await waitFor(() => assert.equal(api.fetchWorkItems.mock.calls.length, 2));
  emit('local-change', {});
  await waitFor(() => assert.equal(api.fetchWorkItems.mock.calls.length, 3));
  act(() => result.current.reload());
  await waitFor(() => assert.equal(api.fetchWorkItems.mock.calls.length, 4));
});

test('the list reports a failed request, clears it on reload, and never fetches while disabled', async () => {
  api.fetchWorkItems
    .mockRejectedValueOnce(new Error('work items unavailable'))
    .mockResolvedValueOnce({ work_items: [] });
  const { result } = renderHook(() => useWorkItems());

  await waitFor(() => assert.ok(result.current.error instanceof Error));
  assert.equal(/** @type {Error} */ (result.current.error).message, 'work items unavailable');
  assert.equal(result.current.loading, false);
  assert.equal(result.current.loaded, false);

  act(() => result.current.reload());
  assert.equal(result.current.error, null);
  await waitFor(() => assert.equal(result.current.loaded, true));

  const disabled = renderHook(() => useWorkItems(false));
  assert.equal(api.fetchWorkItems.mock.calls.length, 2);
  assert.equal(eventStream.handlers.get('local-change')?.size, 1, 'only the enabled hook subscribes');
  act(() => disabled.result.current.reload());
  assert.equal(api.fetchWorkItems.mock.calls.length, 2);
  assert.equal(disabled.result.current.loading, false, 'a disabled list settles instead of loading forever');
  assert.equal(disabled.result.current.loaded, false);
});

test('the list aborts the in-flight request on reload and on unmount without surfacing AbortError', async () => {
  api.fetchWorkItems.mockImplementation((signal) => {
    signals.push(signal);
    return abortable(signal);
  });
  const { result, unmount } = renderHook(() => useWorkItems());
  await waitFor(() => assert.equal(signals.length, 1));

  act(() => result.current.reload());
  assert.equal(signals.length, 2);
  assert.equal(signals[0]?.aborted, true);
  assert.equal(signals[1]?.aborted, false);
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(result.current.error, null);
  assert.equal(result.current.loading, true, 'an aborted request does not settle loading');

  unmount();
  assert.equal(signals[1]?.aborted, true);
  assert.equal(eventStream.handlers.size, 0);
});

test('a single item loads, resets and aborts when the id changes, and reloads on matching task events', async () => {
  api.fetchWorkItem.mockImplementation(async (id, signal) => {
    signals.push(signal);
    return { work_item: detail(id) };
  });
  const { result, rerender } = renderHook(({ id }) => useWorkItem(id), { initialProps: { id: 'wi-1' } });

  assert.equal(result.current.loading, true);
  assert.equal(result.current.workItem, null);
  await waitFor(() => assert.equal(result.current.workItem?.id, 'wi-1'));
  assert.equal(result.current.loading, false);

  rerender({ id: 'wi-2' });
  assert.equal(result.current.workItem, null);
  assert.equal(result.current.loading, true);
  assert.equal(signals[0]?.aborted, true);
  await waitFor(() => assert.equal(result.current.workItem?.id, 'wi-2'));
  assert.deepEqual(
    api.fetchWorkItem.mock.calls.map((call) => call[0]),
    ['wi-1', 'wi-2'],
  );

  emit('task-update', { kind: 'work-item.update', context: { workItemId: 'wi-1' } });
  emit('task-update', { kind: 'work-item.update' });
  assert.equal(api.fetchWorkItem.mock.calls.length, 2, 'events for other items do not reload');
  emit('task-update', { kind: 'work-item.update', context: { workItemId: 'wi-2' } });
  await waitFor(() => assert.equal(api.fetchWorkItem.mock.calls.length, 3));
  emit('local-change', {});
  await waitFor(() => assert.equal(api.fetchWorkItem.mock.calls.length, 4));
});

test('a single item surfaces a failed load and aborts on unmount', async () => {
  api.fetchWorkItem.mockRejectedValueOnce(new Error('work item not found'));
  const { result, unmount } = renderHook(() => useWorkItem('wi-9'));

  await waitFor(() => assert.equal(/** @type {Error | null} */ (result.current.error)?.message, 'work item not found'));
  assert.equal(result.current.loading, false);
  assert.equal(result.current.workItem, null);

  api.fetchWorkItem.mockImplementation((_id, signal) => {
    signals.push(signal);
    return abortable(signal);
  });
  act(() => result.current.reload());
  assert.equal(result.current.error, null);
  assert.equal(signals.length, 1);
  assert.equal(signals[0]?.aborted, false);

  unmount();
  assert.equal(signals[0]?.aborted, true);
  assert.equal(eventStream.handlers.size, 0);
});
