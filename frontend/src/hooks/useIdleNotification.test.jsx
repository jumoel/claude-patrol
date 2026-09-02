import assert from 'node:assert/strict';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { useIdleNotification } from './useIdleNotification.js';

const eventStream = vi.hoisted(() => ({
  handlers: /** @type {Map<string, Set<(event: MessageEvent<string>) => void>>} */ (new Map()),
  subscribed: /** @type {string[]} */ ([]),
}));

vi.mock('../lib/event-stream.js', () => ({
  subscribeAppEvent: vi.fn((type, handler) => {
    eventStream.subscribed.push(type);
    const handlers = eventStream.handlers.get(type) ?? new Set();
    eventStream.handlers.set(type, handlers);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) eventStream.handlers.delete(type);
    };
  }),
}));

/** @param {string} type @param {string} data */
function emitRaw(type, data) {
  act(() => {
    for (const handler of eventStream.handlers.get(type) ?? []) handler(new MessageEvent(type, { data }));
  });
}

/** @param {string} type @param {unknown} payload */
function emit(type, payload) {
  emitRaw(type, JSON.stringify(payload));
}

/**
 * @param {import('../types').SessionTarget} target
 * @param {string} state
 */
function sessionState(target, state) {
  return { sessionId: `session-${state}`, target, state };
}

/** The store is module-level, so each test clears it through the reconnect event after subscribing. */
function resetStore() {
  emit('open', {});
}

beforeEach(() => {
  eventStream.handlers.clear();
  eventStream.subscribed.length = 0;
});

test('subscribes nothing while disabled and tracks session-state per workspace or work item when enabled', () => {
  const disabled = renderHook(() => useIdleNotification(false));
  assert.deepEqual(eventStream.subscribed, []);
  assert.equal(disabled.result.current.targetStates.size, 0);
  disabled.unmount();

  const { result, unmount } = renderHook(() => useIdleNotification());
  assert.deepEqual([...eventStream.subscribed].sort(), ['local-change', 'open', 'session-state']);
  resetStore();
  assert.equal(result.current.targetStates.size, 0);

  emit('session-state', sessionState({ type: 'workspace', id: 'ws-1' }, 'working'));
  assert.deepEqual([...result.current.targetStates], [['workspace:ws-1', 'working']]);
  emit('session-state', sessionState({ type: 'work_item', id: 'wi-1' }, 'idle'));
  assert.equal(result.current.targetStates.get('work-item:wi-1'), 'idle');
  emit('session-state', sessionState({ type: 'workspace', id: 'ws-1' }, 'idle'));
  assert.equal(result.current.targetStates.get('workspace:ws-1'), 'idle');

  const before = result.current.targetStates;
  emit('session-state', sessionState({ type: 'global' }, 'working'));
  emit('session-state', sessionState({ type: 'workspace', id: 'ws-1' }, 'paused'));
  emit('session-state', sessionState({ type: 'workspace', id: 'ws-1' }, 'idle'));
  emit('session-state', sessionState({ type: 'workspace', id: 'ws-unknown' }, 'exited'));
  assert.equal(result.current.targetStates, before, 'global, unknown, and unchanged states keep the same snapshot');

  emit('session-state', sessionState({ type: 'workspace', id: 'ws-1' }, 'exited'));
  assert.deepEqual([...result.current.targetStates], [['work-item:wi-1', 'idle']]);

  unmount();
  assert.equal(eventStream.handlers.size, 0);
});

test('a reconnect clears stale states, local changes bump the counter, and malformed payloads are ignored', () => {
  const { result, unmount } = renderHook(() => useIdleNotification());
  resetStore();

  emit('session-state', sessionState({ type: 'workspace', id: 'ws-2' }, 'working'));
  assert.equal(result.current.targetStates.size, 1);
  const changes = result.current.localChangeCount;

  emit('local-change', {});
  assert.equal(result.current.localChangeCount, changes + 1);
  assert.equal(result.current.targetStates.size, 1, 'local changes leave session state alone');

  emitRaw('session-state', '{not json');
  assert.equal(result.current.targetStates.size, 1);

  emit('open', {});
  assert.equal(result.current.targetStates.size, 0);
  const cleared = result.current.targetStates;
  emit('open', {});
  assert.equal(result.current.targetStates, cleared, 'an already empty store is not replaced');

  unmount();
});

test('instances share one store and the stream stays subscribed until the last one unmounts', () => {
  const first = renderHook(() => useIdleNotification());
  const second = renderHook(() => useIdleNotification());
  resetStore();
  assert.equal(eventStream.handlers.get('session-state')?.size, 1, 'one subscription serves every instance');

  emit('session-state', sessionState({ type: 'workspace', id: 'ws-3' }, 'idle'));
  assert.equal(first.result.current.targetStates, second.result.current.targetStates);
  assert.equal(first.result.current.targetStates.get('workspace:ws-3'), 'idle');

  first.unmount();
  assert.equal(eventStream.handlers.get('session-state')?.size, 1);
  emit('session-state', sessionState({ type: 'workspace', id: 'ws-3' }, 'working'));
  assert.equal(second.result.current.targetStates.get('workspace:ws-3'), 'working');

  second.unmount();
  assert.equal(eventStream.handlers.size, 0);
});
