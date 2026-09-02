import assert from 'node:assert/strict';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';

const api = {
  fetchSessions: vi.fn(),
  createSession: vi.fn(),
  killSession: vi.fn(),
  reattachSession: vi.fn(),
};
vi.mock('../lib/api.js', () => api);

const { useTargetSession } = await import('./useTargetSession.js');

const target = { type: /** @type {const} */ ('workspace'), id: 'ws-1' };
const sessionA = { id: 'a', provider: 'claude', status: 'active' };
const sessionB = { id: 'b', provider: 'codex', status: 'detached' };

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

test('load picks the preferred session and start, kill and exit report through onChange', async () => {
  api.fetchSessions.mockResolvedValue([sessionA, sessionB]);
  api.createSession.mockResolvedValue(sessionA);
  api.killSession.mockResolvedValue({ ok: true });
  const acknowledged = /** @type {string[]} */ ([]);
  let changes = 0;
  const { result } = renderHook(() =>
    useTargetSession({ onAcknowledgeSession: (id) => acknowledged.push(id), onChange: () => (changes += 1) }),
  );

  await act(async () => {
    assert.equal(await result.current.load(target, { preferredId: 'b' }), sessionB);
  });
  assert.equal(result.current.session, sessionB);
  assert.deepEqual(acknowledged, ['b']);

  await act(async () => {
    await result.current.start(target, 'claude');
  });
  assert.equal(result.current.session, sessionA);
  assert.equal(changes, 1);
  assert.deepEqual(api.createSession.mock.calls[0], [target, 'claude']);

  await act(async () => {
    await result.current.kill();
  });
  assert.equal(result.current.session, null);
  assert.equal(changes, 2);

  act(() => result.current.handleExit());
  assert.equal(changes, 3);
});

test('a failed reattach or kill becomes actionError instead of a rejection', async () => {
  api.fetchSessions.mockResolvedValue([sessionA]);
  api.reattachSession.mockRejectedValue(new Error('tmux is gone'));
  api.killSession.mockRejectedValue(new Error('still alive'));
  const { result } = renderHook(() => useTargetSession());
  await act(async () => {
    await result.current.load(target);
  });

  await act(async () => {
    await result.current.reattach();
  });
  assert.equal(result.current.actionError, 'tmux is gone');
  assert.equal(result.current.session, sessionA, 'the session is kept when reattach fails');

  await act(async () => {
    await result.current.kill();
  });
  await waitFor(() => assert.equal(result.current.actionError, 'still alive'));
});
