import assert from 'node:assert/strict';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { useGlobalSessions } from './useGlobalSessions.js';

const api = vi.hoisted(() => ({ fetchSessions: vi.fn() }));
vi.mock('../lib/api.js', () => api);

const first = /** @type {import('../types').Session} */ ({
  id: 'first',
  workspace_id: null,
  work_item_id: null,
  name: 'First',
  target: /** @type {const} */ ({ type: 'global' }),
  activity_state: null,
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

beforeEach(() => api.fetchSessions.mockReset());

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
