import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, test, vi } from 'vitest';
import { AgentProviderProvider } from '../../context/AgentProviderContext.jsx';
import { WorkspaceDetail } from './WorkspaceDetail.jsx';

const api = vi.hoisted(() => ({
  createSession: vi.fn(),
  destroyWorkspace: vi.fn(),
  fetchProviderCapabilities: vi.fn(),
  fetchSessions: vi.fn(),
  fetchWorkspace: vi.fn(),
  killSession: vi.fn(),
  reattachSession: vi.fn(),
}));

vi.mock('../../lib/api.js', () => api);
vi.mock('../../hooks/useSyncEvents.js', () => ({ useSyncEvents: () => {} }));
vi.mock('../SessionHistory/SessionHistory.jsx', () => ({ SessionHistory: () => <div>Past sessions</div> }));
vi.mock('../TerminalCard/TerminalCard.jsx', () => ({
  /** @param {{session: import('../../types').Session, presentation?: string}} props */
  TerminalCard: ({ session, presentation }) => (
    <div data-testid="terminal" data-session={session.id} data-presentation={presentation} />
  ),
}));

/** @returns {import('../../types').Workspace} */
function workspace() {
  return {
    id: 'scratch-1',
    pr_id: null,
    work_item_id: null,
    name: 'advisory-sync investigation',
    path: '/tmp/advisory-sync',
    bookmark: 'patrol/advisory-sync',
    repo: null,
    status: 'active',
    created_at: '2026-08-26T00:00:00.000Z',
    destroyed_at: null,
    operation_state: 'ready',
    operation_step: null,
    operation_error: null,
    operation_updated_at: null,
    start_revision: 'main@origin',
    base_commit: null,
    setup_warnings_json: '[]',
  };
}

/** @returns {import('../../types').Session} */
function session() {
  return {
    id: 'session-1',
    workspace_id: 'scratch-1',
    work_item_id: null,
    name: null,
    target: { type: 'workspace', id: 'scratch-1' },
    activity_state: null,
    activity_changed_at: null,
    pid: 123,
    provider: 'codex',
    status: 'active',
    started_at: '2026-08-26T00:00:00.000Z',
    ended_at: null,
    last_idle_at: null,
    claude_project_dir: null,
    transcript_path: null,
  };
}

function renderDetail(onBack = vi.fn()) {
  render(
    <AgentProviderProvider>
      <WorkspaceDetail
        workspaceId="scratch-1"
        onBack={onBack}
        workspaceStates={new Map()}
        acknowledgedSessionIds={new Set()}
        onAcknowledgeSession={vi.fn()}
      />
    </AgentProviderProvider>,
  );
  return onBack;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  localStorage.setItem('claude-patrol-agent-provider', 'codex');
  api.fetchProviderCapabilities.mockResolvedValue({
    claude: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
    codex: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
  });
  api.fetchWorkspace.mockResolvedValue(workspace());
  api.fetchSessions.mockResolvedValue([]);
  api.createSession.mockResolvedValue(session());
  api.destroyWorkspace.mockResolvedValue({});
});

test('calls the scratch session API adapter and renders an in-flow terminal', async () => {
  const user = userEvent.setup();
  renderDetail();

  assert.ok(await screen.findByRole('heading', { name: 'advisory-sync investigation' }));
  assert.ok(document.querySelector('[data-state-marker="active"]'));
  assert.equal(document.querySelector('[data-state-marker="inactive"]'), null);
  assert.equal(screen.queryByText('No LLM session is attached to this workspace.'), null);
  await user.click(screen.getByRole('button', { name: 'Start Codex session' }));

  await waitFor(() => {
    assert.deepEqual(api.createSession.mock.calls, [[{ type: 'workspace', id: 'scratch-1' }, 'codex']]);
  });
  const terminal = await screen.findByTestId('terminal');
  assert.equal(terminal.getAttribute('data-session'), 'session-1');
  assert.equal(terminal.getAttribute('data-presentation'), 'work-page');
  assert.ok(screen.getByText('Idle'));
  assert.equal(screen.queryByText('Live'), null);
});

test('destroy waits for the API and navigates back only after success', async () => {
  const user = userEvent.setup();
  const onBack = renderDetail();
  await screen.findByRole('heading', { name: 'advisory-sync investigation' });

  await user.click(screen.getByRole('button', { name: 'Destroy' }));

  assert.deepEqual(api.destroyWorkspace.mock.calls, [['scratch-1']]);
  await waitFor(() => assert.equal(onBack.mock.calls.length, 1));
});

test('destroy and load failures stay visible on the page', async () => {
  const user = userEvent.setup();
  api.destroyWorkspace.mockRejectedValueOnce(new Error('workspace is busy'));
  renderDetail();
  await screen.findByRole('heading', { name: 'advisory-sync investigation' });
  await user.click(screen.getByRole('button', { name: 'Destroy' }));
  assert.ok(await screen.findByRole('alert'));
  assert.ok(screen.getByText('workspace is busy'));

  api.fetchWorkspace.mockRejectedValueOnce(new Error('workspace source unavailable'));
  renderDetail();
  assert.ok(await screen.findByText('workspace source unavailable'));
});

test('an existing session is the first work surface without duplicate page navigation', async () => {
  api.fetchSessions.mockResolvedValue([session()]);
  renderDetail();

  const terminal = await screen.findByTestId('terminal');
  const history = screen.getByText('Past sessions');
  assert.ok(terminal.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(screen.queryByRole('button', { name: '← Work' }), null);
  assert.equal(screen.getByRole('button', { name: 'Destroy' }).hasAttribute('disabled'), true);
});

test('redirects an adopted workspace to its pull request when the workspace retains its repository', async () => {
  window.location.hash = '#/workspace/scratch-1';
  api.fetchWorkspace.mockResolvedValue({
    ...workspace(),
    pr_id: 'chainguard-dev/ecosystems-rebuilder.js#1452',
    repo: 'chainguard-dev/ecosystems-rebuilder.js',
  });

  renderDetail();

  await waitFor(() => {
    assert.equal(window.location.hash, '#/pr/chainguard-dev%2Fecosystems-rebuilder.js%231452');
  });
});
