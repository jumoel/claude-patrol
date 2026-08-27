import assert from 'node:assert/strict';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test } from 'vitest';
import { useWaitingAcknowledgements } from './useWaitingAcknowledgements.js';

const idleSession = /** @type {import('../types').Session} */ ({
  id: 'session-1',
  target: { type: 'global' },
  activity_state: 'idle',
  activity_changed_at: '2026-08-26T10:00:00.000Z',
  status: 'active',
  provider: 'codex',
  started_at: '2026-08-26T09:00:00.000Z',
});

beforeEach(() => localStorage.clear());

test('persists one acknowledgement per session idle transition', async () => {
  const { result, rerender } = renderHook(({ sessions }) => useWaitingAcknowledgements(sessions, true), {
    initialProps: { sessions: [idleSession] },
  });

  act(() => result.current.acknowledge(idleSession.id));
  assert.equal(result.current.acknowledgedIdle.get(idleSession.id), idleSession.activity_changed_at);
  assert.equal(
    JSON.parse(localStorage.getItem('claude-patrol-waiting-ack-v1') || '{}')[idleSession.id],
    idleSession.activity_changed_at,
  );

  rerender({ sessions: [{ ...idleSession, activity_state: 'working' }] });
  await waitFor(() => assert.equal(result.current.acknowledgedIdle.size, 0));
  rerender({
    sessions: [{ ...idleSession, activity_changed_at: '2026-08-26T11:00:00.000Z' }],
  });
  assert.equal(result.current.acknowledgedIdle.size, 0);
});

test('keeps an acknowledgement when restart restores the same idle timestamp', async () => {
  localStorage.setItem(
    'claude-patrol-waiting-ack-v1',
    JSON.stringify({ [idleSession.id]: idleSession.activity_changed_at }),
  );

  const { result } = renderHook(() => useWaitingAcknowledgements([idleSession], true));

  await waitFor(() =>
    assert.equal(result.current.acknowledgedIdle.get(idleSession.id), idleSession.activity_changed_at),
  );
});

test('synchronizes acknowledgements from another tab', async () => {
  const { result } = renderHook(() => useWaitingAcknowledgements([idleSession], true));
  localStorage.setItem(
    'claude-patrol-waiting-ack-v1',
    JSON.stringify({ [idleSession.id]: idleSession.activity_changed_at }),
  );
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'claude-patrol-waiting-ack-v1',
      newValue: localStorage.getItem('claude-patrol-waiting-ack-v1'),
    }),
  );
  await waitFor(() =>
    assert.equal(result.current.acknowledgedIdle.get(idleSession.id), idleSession.activity_changed_at),
  );
});

test('prunes acknowledgements after a reconciled session exits', async () => {
  const { result, rerender } = renderHook(({ sessions }) => useWaitingAcknowledgements(sessions, true), {
    initialProps: { sessions: [idleSession] },
  });
  act(() => result.current.acknowledge(idleSession.id));
  rerender({ sessions: [] });

  await waitFor(() => assert.equal(result.current.acknowledgedIdle.size, 0));
  assert.deepEqual(JSON.parse(localStorage.getItem('claude-patrol-waiting-ack-v1') || '{}'), {});
});
