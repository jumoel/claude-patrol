import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, test, vi } from 'vitest';
import { SessionHistory } from './SessionHistory.jsx';

const api = vi.hoisted(() => ({
  fetchSessionHistory: vi.fn(),
  fetchSessionTranscript: vi.fn(),
}));

vi.mock('../../lib/api.js', () => api);

/**
 * @param {Partial<import('../../types').Session>} [overrides]
 * @returns {import('../../types').Session}
 */
function session(overrides = {}) {
  return {
    id: 'session-1',
    workspace_id: 'ws-1',
    work_item_id: null,
    name: null,
    target: { type: 'workspace', id: 'ws-1' },
    activity_state: null,
    activity_changed_at: null,
    activity_message: null,
    pid: null,
    provider: 'claude',
    status: 'killed',
    started_at: '2026-08-30T10:00:00.000Z',
    ended_at: '2026-08-30T10:12:00.000Z',
    last_idle_at: null,
    claude_project_dir: null,
    transcript_path: '/tmp/session-1.jsonl',
    ...overrides,
  };
}

/** @type {import('../../types').TranscriptEntry[]} */
const TRANSCRIPT = [
  { role: 'user', isHuman: true, model: null, content: [{ type: 'text', text: 'Summarise the failing job' }] },
];

const codexSession = session({
  id: 'session-2',
  provider: 'codex',
  started_at: '2026-08-30T08:00:00.000Z',
  ended_at: '2026-08-30T09:05:00.000Z',
  transcript_path: null,
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchSessionHistory.mockResolvedValue([session(), codexSession]);
  api.fetchSessionTranscript.mockResolvedValue(TRANSCRIPT);
});

test('stays collapsed until asked, then loads history for the target once and renders each session', async () => {
  const user = userEvent.setup();
  render(<SessionHistory target={{ type: 'workspace', id: 'ws-1' }} />);

  const toggle = screen.getByRole('button', { name: 'Show past sessions' });
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(api.fetchSessionHistory.mock.calls.length, 0);

  await user.click(toggle);
  assert.deepEqual(api.fetchSessionHistory.mock.calls, [[{ type: 'workspace', id: 'ws-1' }]]);
  assert.ok(await screen.findByRole('button', { name: /Claude/ }));
  assert.equal(screen.getByRole('button', { name: 'Hide past sessions' }).getAttribute('aria-expanded'), 'true');
  assert.ok(screen.getByText('12m'));
  assert.ok(screen.getByText('Codex'));
  assert.ok(screen.getByText('1h 5m'));
  assert.ok(screen.getByText('Transcript unavailable'));
  assert.equal(screen.queryByRole('button', { name: /Codex/ }), null, 'Codex sessions have no transcript to open');

  await user.click(screen.getByRole('button', { name: 'Hide past sessions' }));
  assert.equal(screen.queryByText('Codex'), null);
  await user.click(screen.getByRole('button', { name: 'Show past sessions' }));
  assert.ok(await screen.findByText('Codex'));
  assert.equal(api.fetchSessionHistory.mock.calls.length, 1, 'history is cached across collapses');
});

test('viewing a transcript fetches it once and renders the TranscriptViewer', async () => {
  const user = userEvent.setup();
  render(<SessionHistory target={{ type: 'workspace', id: 'ws-1' }} />);
  await user.click(screen.getByRole('button', { name: 'Show past sessions' }));
  const row = await screen.findByRole('button', { name: /Claude/ });
  assert.equal(api.fetchSessionTranscript.mock.calls.length, 0);

  await user.click(row);
  assert.deepEqual(api.fetchSessionTranscript.mock.calls, [['session-1']]);
  assert.ok(await screen.findByText('Summarise the failing job'));
  assert.ok(screen.getByText('You'));

  await user.click(row);
  assert.equal(screen.queryByText('Summarise the failing job'), null);

  await user.click(row);
  assert.ok(await screen.findByText('Summarise the failing job'));
  assert.equal(api.fetchSessionTranscript.mock.calls.length, 1, 'a loaded transcript is reused');
});

test('history and transcript failures render inline', async () => {
  const user = userEvent.setup();
  api.fetchSessionHistory.mockRejectedValueOnce(new Error('history store offline'));
  const failedHistory = render(<SessionHistory target={{ type: 'work_item', id: 'wi-1' }} />);
  await user.click(screen.getByRole('button', { name: 'Show past sessions' }));
  assert.equal((await screen.findByRole('alert')).textContent, 'history store offline');
  assert.deepEqual(api.fetchSessionHistory.mock.calls, [[{ type: 'work_item', id: 'wi-1' }]]);
  assert.equal(screen.queryByText('No past sessions'), null);
  failedHistory.unmount();

  api.fetchSessionHistory.mockResolvedValueOnce([session()]);
  api.fetchSessionTranscript.mockRejectedValueOnce(new Error('transcript file is missing'));
  render(<SessionHistory target={{ type: 'workspace', id: 'ws-1' }} />);
  await user.click(screen.getByRole('button', { name: 'Show past sessions' }));
  await user.click(await screen.findByRole('button', { name: /Claude/ }));
  assert.ok(await screen.findByText('transcript file is missing'));
  assert.equal(screen.queryByText('You'), null);
});

test('a global target requests global history and an empty result says so', async () => {
  const user = userEvent.setup();
  api.fetchSessionHistory.mockResolvedValueOnce([]);
  render(<SessionHistory target={{ type: 'global' }} />);

  await user.click(screen.getByRole('button', { name: 'Show past sessions' }));
  assert.ok(await screen.findByText('No past sessions'));
  assert.deepEqual(api.fetchSessionHistory.mock.calls, [[{ type: 'global' }]]);
  assert.equal(screen.queryByRole('alert'), null);
});
