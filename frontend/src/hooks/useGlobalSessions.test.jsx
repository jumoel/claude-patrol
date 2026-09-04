import assert from 'node:assert/strict';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { useGlobalSessions } from './useGlobalSessions.js';

const api = vi.hoisted(() => ({ fetchSessions: vi.fn() }));
const eventStream = vi.hoisted(() => ({ sessionStateHandlers: new Set() }));
vi.mock('../lib/api.js', () => api);
vi.mock('../lib/event-stream.js', () => ({
  subscribeAppEvent: vi.fn((type, handler) => {
    if (type !== 'session-state') return () => {};
    eventStream.sessionStateHandlers.add(handler);
    return () => eventStream.sessionStateHandlers.delete(handler);
  }),
}));

const first = /** @type {import('../types').Session} */ ({
  id: 'first',
  workspace_id: null,
  work_item_id: null,
  name: 'First',
  target: /** @type {const} */ ({ type: 'global' }),
  activity_state: null,
  activity_changed_at: null,
  activity_message: null,
  pid: 1,
  provider: 'claude',
  status: 'active',
  started_at: '2026-08-22T00:00:00.000Z',
  ended_at: null,
  claude_project_dir: null,
  transcript_path: null,
});
const second = { ...first, id: 'second', name: 'Second', started_at: '2026-08-22T00:00:01.000Z' };
const third = { ...first, id: 'third', name: 'Third', started_at: '2026-08-22T00:00:02.000Z' };
const workspace = {
  ...first,
  id: 'workspace-session',
  name: null,
  workspace_id: 'workspace-1',
  target: /** @type {const} */ ({ type: 'workspace', id: 'workspace-1' }),
};
const workItem = {
  ...first,
  id: 'work-item-session',
  name: null,
  work_item_id: 'work-item-1',
  target: /** @type {const} */ ({ type: 'work_item', id: 'work-item-1' }),
};

beforeEach(() => {
  api.fetchSessions.mockReset();
  eventStream.sessionStateHandlers.clear();
});

/** @param {Record<string, unknown>} payload */
function emitSessionState(payload) {
  const event = new MessageEvent('session-state', { data: JSON.stringify(payload) });
  for (const handler of eventStream.sessionStateHandlers) handler(event);
}

test('preserves the selected session across an update refresh', async () => {
  api.fetchSessions.mockResolvedValue([workspace, first, second]);
  const { result, rerender } = renderHook(({ changeToken }) => useGlobalSessions(true, changeToken), {
    initialProps: { changeToken: 0 },
  });
  await waitFor(() => assert.equal(result.current.activeSessionId, 'first'));
  assert.equal(result.current.allSessions.length, 3);
  assert.deepEqual(
    result.current.sessions.map((session) => session.id),
    ['first', 'second'],
  );

  act(() => result.current.selectSession('second'));
  assert.equal(result.current.activeSessionId, 'second');

  rerender({ changeToken: 1 });
  await waitFor(() => assert.equal(api.fetchSessions.mock.calls.length, 2));
  await waitFor(() => assert.equal(result.current.activeSessionId, 'second'));
});

test('keeps concurrent tab additions when another session exits', async () => {
  api.fetchSessions.mockResolvedValue([workspace, first, second]);
  const { result } = renderHook(() => useGlobalSessions(true, 0));
  await waitFor(() => assert.equal(result.current.sessions.length, 2));

  const removeFirst = result.current.removeSession;
  act(() => {
    result.current.upsertSession(third);
    removeFirst('first');
  });

  assert.deepEqual(
    result.current.sessions.map((session) => session.id),
    ['second', 'third'],
  );
  assert.deepEqual(
    result.current.allSessions.map((session) => session.id),
    ['workspace-session', 'second', 'third'],
  );
  assert.equal(result.current.activeSessionId, 'second');
});

test('applies live activity changes to dashboard sessions without refetching', async () => {
  api.fetchSessions.mockResolvedValue([workItem, first]);
  const { result } = renderHook(() => useGlobalSessions(true, 0));
  await waitFor(() => assert.equal(result.current.allSessions.length, 2));

  act(() => {
    emitSessionState({
      sessionId: workItem.id,
      state: 'working',
      activity_changed_at: '2026-08-27T13:44:49.723Z',
      activity_message: 'Investigating',
    });
  });

  const updated = result.current.allSessions.find((session) => session.id === workItem.id);
  assert.equal(updated?.activity_state, 'working');
  assert.equal(updated?.activity_changed_at, '2026-08-27T13:44:49.723Z');
  assert.equal(updated?.activity_message, 'Investigating');
  assert.equal(api.fetchSessions.mock.calls.length, 1);
});

test('applies message-only updates and clears without refetching', async () => {
  const working = {
    ...workItem,
    activity_state: /** @type {const} */ ('working'),
    activity_changed_at: '2026-08-27T13:44:49.723Z',
    activity_message: null,
  };
  api.fetchSessions.mockResolvedValue([working]);
  const { result } = renderHook(() => useGlobalSessions(true, 0));
  await waitFor(() => assert.equal(result.current.allSessions.length, 1));

  act(() => {
    emitSessionState({
      sessionId: working.id,
      state: 'working',
      activity_changed_at: working.activity_changed_at,
      activity_message: 'Watching CI',
    });
  });
  assert.equal(result.current.allSessions[0].activity_message, 'Watching CI');

  act(() => {
    emitSessionState({
      sessionId: working.id,
      state: 'working',
      activity_changed_at: working.activity_changed_at,
      activity_message: null,
    });
  });
  assert.equal(result.current.allSessions[0].activity_message, null);
  assert.equal(api.fetchSessions.mock.calls.length, 1);
});

test('keeps an activity event that arrives during an older refresh', async () => {
  const working = {
    ...workItem,
    activity_state: /** @type {const} */ ('working'),
    activity_changed_at: '2026-08-27T13:44:49.723Z',
    activity_message: null,
  };
  /** @type {(sessions: import('../types').Session[]) => void} */
  let resolveRefresh = () => {};
  api.fetchSessions.mockResolvedValueOnce([working]).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
  );
  const { result, rerender } = renderHook(({ changeToken }) => useGlobalSessions(true, changeToken), {
    initialProps: { changeToken: 0 },
  });
  await waitFor(() => assert.equal(result.current.allSessions.length, 1));

  rerender({ changeToken: 1 });
  await waitFor(() => assert.equal(api.fetchSessions.mock.calls.length, 2));
  act(() => {
    emitSessionState({
      sessionId: working.id,
      state: 'working',
      activity_changed_at: working.activity_changed_at,
      activity_message: 'Watching CI',
    });
  });
  assert.equal(result.current.allSessions[0].activity_message, 'Watching CI');

  await act(async () => {
    resolveRefresh([working]);
    await Promise.resolve();
  });
  assert.equal(result.current.allSessions[0].activity_message, 'Watching CI');
});

test('keeps an activity event received before the initial session response', async () => {
  const working = {
    ...workItem,
    activity_state: /** @type {const} */ ('working'),
    activity_changed_at: '2026-08-27T13:44:49.723Z',
    activity_message: null,
  };
  /** @type {(sessions: import('../types').Session[]) => void} */
  let resolveFetch = () => {};
  api.fetchSessions.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
  );
  const { result } = renderHook(() => useGlobalSessions(true, 0));
  await waitFor(() => assert.equal(eventStream.sessionStateHandlers.size, 1));

  act(() => {
    emitSessionState({
      sessionId: working.id,
      state: 'working',
      activity_changed_at: working.activity_changed_at,
      activity_message: 'Running tests',
    });
  });
  assert.equal(result.current.allSessions.length, 0);

  await act(async () => {
    resolveFetch([working]);
    await Promise.resolve();
  });
  assert.equal(result.current.allSessions[0].activity_message, 'Running tests');
});
