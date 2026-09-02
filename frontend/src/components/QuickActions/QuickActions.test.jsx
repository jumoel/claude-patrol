import assert from 'node:assert/strict';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, test, vi } from 'vitest';
import { AgentProviderProvider } from '../../context/AgentProviderContext.jsx';
import { QuickActions } from './QuickActions.jsx';

const api = vi.hoisted(() => ({
  fetchPeerReviewState: vi.fn(),
  fetchProviderCapabilities: vi.fn(),
  requestPeerReview: vi.fn(),
}));
const terminal = vi.hoisted(() => ({ sendTerminalCommand: vi.fn() }));
const eventStream = vi.hoisted(() => ({
  handlers: /** @type {Set<(event: MessageEvent<string>) => void>} */ (new Set()),
}));

vi.mock('../../lib/api.js', () => api);
vi.mock('../../lib/terminal.js', () => terminal);
vi.mock('../../lib/event-stream.js', () => ({
  subscribeAppEvent: vi.fn((type, handler) => {
    if (type !== 'peer-review-state') return () => {};
    eventStream.handlers.add(handler);
    return () => eventStream.handlers.delete(handler);
  }),
}));

const PR_ID = 'acme/api#7';

/** @param {boolean} codexAvailable @param {string | null} [reason] */
function capabilities(codexAvailable, reason = null) {
  return {
    claude: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
    codex: {
      available: codexAvailable,
      checking: false,
      reason,
      version: codexAvailable ? 'test' : null,
      checkedAt: null,
    },
  };
}

/**
 * @param {Partial<import('../../types').PeerReviewStatusResponse>} [overrides]
 * @returns {import('../../types').PeerReviewStatusResponse}
 */
function peerState(overrides = {}) {
  return {
    review: null,
    presenterProvider: 'claude',
    reviewerProvider: 'codex',
    ready: true,
    reason: null,
    ...overrides,
  };
}

/**
 * @param {import('../../types').PeerReviewStatus} status
 * @param {{code: string, message: string} | null} [error]
 * @returns {import('../../types').PeerReview}
 */
function review(status, error = null) {
  return {
    id: 'review-1',
    workspaceId: 'ws-1',
    sessionId: 'session-1',
    prId: PR_ID,
    presenterProvider: 'claude',
    reviewerProvider: 'codex',
    status,
    requestedAt: '2026-08-30T10:00:00.000Z',
    startedAt: null,
    resultReadyAt: null,
    endedAt: null,
    error,
  };
}

/** @param {Record<string, unknown>} payload */
function emitPeerReviewState(payload) {
  act(() => {
    for (const handler of eventStream.handlers) {
      handler(new MessageEvent('peer-review-state', { data: JSON.stringify(payload) }));
    }
  });
}

/** @param {Parameters<typeof QuickActions>[0]} props */
function renderActions(props) {
  return render(
    <AgentProviderProvider>
      <QuickActions {...props} />
    </AgentProviderProvider>,
  );
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  terminal.sendTerminalCommand.mockReset();
  eventStream.handlers.clear();
  localStorage.clear();
  api.fetchProviderCapabilities.mockResolvedValue(capabilities(true));
  api.fetchPeerReviewState.mockResolvedValue(peerState());
});

test('renders the quick actions for the base branch and sends them through onSend or the terminal socket', async () => {
  const user = userEvent.setup();
  const onSend = vi.fn();
  const first = renderActions({ sessionProvider: 'claude', baseBranch: 'develop', onSend });

  assert.deepEqual(
    screen.getAllByRole('button').map((button) => button.textContent),
    ['Rebase onto develop', 'Fix lint errors', 'Update PR description'],
  );
  await user.click(screen.getByRole('button', { name: 'Rebase onto develop' }));
  await user.click(screen.getByRole('button', { name: 'Fix lint errors' }));
  assert.equal(onSend.mock.calls.length, 2);
  assert.match(onSend.mock.calls[0][0], /jj rebase -d develop@origin/);
  assert.match(onSend.mock.calls[1][0], /^Run the linter\./);
  assert.equal(terminal.sendTerminalCommand.mock.calls.length, 0);
  assert.equal(api.fetchPeerReviewState.mock.calls.length, 0, 'no PR means no peer review lookup');
  first.unmount();

  const socket = /** @type {WebSocket} */ (/** @type {unknown} */ ({ readyState: 1, send: vi.fn() }));
  renderActions({ sessionProvider: 'codex', wsRef: { current: socket } });
  await user.click(screen.getByRole('button', { name: 'Rebase onto main' }));
  assert.equal(terminal.sendTerminalCommand.mock.calls.length, 1);
  assert.equal(terminal.sendTerminalCommand.mock.calls[0][0], socket);
  assert.match(terminal.sendTerminalCommand.mock.calls[0][1], /jj rebase -d main@origin/);
});

test('requests a peer review for the PR and follows status events until delivery', async () => {
  const user = userEvent.setup();
  api.requestPeerReview.mockResolvedValue({ review: review('requested'), dispatchedAt: 1 });
  renderActions({ sessionProvider: 'claude', prId: PR_ID, workspaceId: 'ws-1', sessionState: 'idle' });

  const button = /** @type {HTMLButtonElement} */ (await screen.findByRole('button', { name: 'Review with Codex' }));
  await waitFor(() => assert.equal(button.disabled, false));
  assert.deepEqual(api.fetchPeerReviewState.mock.calls, [[{ type: 'workspace', id: 'ws-1' }, PR_ID]]);
  assert.equal(button.getAttribute('title'), 'Review the full effective PR diff with Codex');
  assert.equal(screen.queryByRole('status'), null);

  await user.click(button);
  assert.deepEqual(api.requestPeerReview.mock.calls, [[{ type: 'workspace', id: 'ws-1' }, PR_ID]]);
  assert.ok(await screen.findByText('Asking Claude to start Codex...'));
  const status = screen.getByRole('status');
  assert.equal(button.disabled, true);

  emitPeerReviewState({ workspaceId: 'ws-1', review: review('running') });
  assert.equal(status.textContent, 'Codex is reviewing the full diff...');
  emitPeerReviewState({ workspaceId: 'ws-other', review: review('failed') });
  assert.equal(status.textContent, 'Codex is reviewing the full diff...', 'other workspaces are ignored');
  emitPeerReviewState({ workspaceId: 'ws-1', review: review('delivering') });
  assert.equal(status.textContent, 'Claude is presenting the review...');
  emitPeerReviewState({ workspaceId: 'ws-1', review: review('complete') });
  assert.equal(status.textContent, 'Review delivered in Claude.');
  assert.equal(button.disabled, false);
});

test('disables the review button with a reason for an unavailable reviewer, a working session, or an unready workspace', async () => {
  api.fetchProviderCapabilities.mockResolvedValue(capabilities(false, 'codex binary not found'));
  const unavailable = renderActions({ sessionProvider: 'claude', prId: PR_ID, workspaceId: 'ws-1' });
  const button = /** @type {HTMLButtonElement} */ (await screen.findByRole('button', { name: 'Review with Codex' }));
  await waitFor(() => assert.equal(button.getAttribute('title'), 'codex binary not found'));
  assert.equal(button.disabled, true);
  unavailable.unmount();

  api.fetchProviderCapabilities.mockResolvedValue(capabilities(true));
  const working = renderActions({
    sessionProvider: 'claude',
    prId: PR_ID,
    workspaceId: 'ws-1',
    sessionState: 'working',
  });
  await waitFor(() =>
    assert.equal(
      screen.getByRole('button', { name: 'Review with Codex' }).getAttribute('title'),
      'Wait for Claude to become idle',
    ),
  );
  assert.equal(
    /** @type {HTMLButtonElement} */ (screen.getByRole('button', { name: 'Review with Codex' })).disabled,
    true,
  );
  working.unmount();

  api.fetchPeerReviewState.mockResolvedValue(peerState({ ready: false, reason: 'session_restart_required' }));
  const restart = renderActions({ sessionProvider: 'claude', prId: PR_ID, workspaceId: 'ws-1' });
  await waitFor(() =>
    assert.equal(
      screen.getByRole('button', { name: 'Review with Codex' }).getAttribute('title'),
      'Restart this Claude session to enable peer review',
    ),
  );
  restart.unmount();

  api.fetchPeerReviewState.mockResolvedValue(peerState({ ready: false }));
  renderActions({ sessionProvider: 'claude', prId: PR_ID, workspaceId: 'ws-1' });
  await waitFor(() =>
    assert.equal(
      screen.getByRole('button', { name: 'Review with Codex' }).getAttribute('title'),
      'The workspace is not ready for peer review',
    ),
  );
  assert.equal(
    /** @type {HTMLButtonElement} */ (screen.getByRole('button', { name: 'Review with Codex' })).disabled,
    true,
  );
});

test('prefers the work item target over the workspace and reports a failed request in the status region', async () => {
  const user = userEvent.setup();
  api.fetchPeerReviewState.mockResolvedValue(peerState({ presenterProvider: 'codex', reviewerProvider: 'claude' }));
  api.requestPeerReview.mockRejectedValue(new Error('presenter session is busy'));
  renderActions({ sessionProvider: 'codex', prId: PR_ID, workspaceId: 'ws-1', workItemId: 'wi-1' });

  const button = /** @type {HTMLButtonElement} */ (await screen.findByRole('button', { name: 'Review with Claude' }));
  await waitFor(() => assert.equal(button.disabled, false));
  assert.deepEqual(api.fetchPeerReviewState.mock.calls, [[{ type: 'work_item', id: 'wi-1' }, PR_ID]]);

  await user.click(button);
  assert.deepEqual(api.requestPeerReview.mock.calls, [[{ type: 'work_item', id: 'wi-1' }, PR_ID]]);
  const status = await screen.findByRole('status');
  await waitFor(() => assert.equal(status.textContent, 'presenter session is busy'));
  assert.equal(button.disabled, false, 'a failed request can be retried');
});
