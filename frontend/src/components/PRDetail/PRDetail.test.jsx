import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, test, vi } from 'vitest';
import { AgentProviderProvider } from '../../context/AgentProviderContext.jsx';
import { PRDetail } from './PRDetail.jsx';

const api = vi.hoisted(() => ({
  createSession: vi.fn(),
  createWorkspace: vi.fn(),
  destroyWorkspace: vi.fn(),
  fetchCheckLogs: vi.fn(),
  fetchPR: vi.fn(),
  fetchPRComments: vi.fn(),
  fetchProviderCapabilities: vi.fn(),
  fetchSessions: vi.fn(),
  fetchWorkspaces: vi.fn(),
  killSession: vi.fn(),
  reattachSession: vi.fn(),
  refreshPR: vi.fn(),
  setPRDraft: vi.fn(),
}));

vi.mock('../../lib/api.js', () => api);
vi.mock('../../hooks/useSyncEvents.js', () => ({ useSyncEvents: () => {} }));
vi.mock('../RuleControls/RuleControls.jsx', () => ({ RuleControls: () => <div>Rules</div> }));
vi.mock('../SessionHistory/SessionHistory.jsx', () => ({ SessionHistory: () => <div>Past sessions</div> }));
vi.mock('../CommentsList/CommentsList.jsx', () => ({ CommentsList: () => null }));
vi.mock('../TerminalCard/TerminalCard.jsx', () => ({
  /** @param {{session: import('../../types').Session, presentation?: string, onPopOut?: () => void, workspaceId?: string, prId?: string}} props */
  TerminalCard: ({ session, presentation, onPopOut, workspaceId, prId }) => (
    <div
      data-testid="terminal"
      data-session={session.id}
      data-presentation={presentation}
      data-popout={!!onPopOut}
      data-workspace={workspaceId}
      data-pr={prId}
    />
  ),
}));

/** @returns {import('../../types').PullRequest} */
function pullRequest() {
  return {
    id: 'acme/widgets#42',
    number: 42,
    title: 'Ship the widget fix',
    body: '',
    body_html: '',
    repo: 'widgets',
    org: 'acme',
    author: 'octocat',
    url: 'https://github.com/acme/widgets/pull/42',
    branch: 'widget-fix',
    base_branch: 'main',
    is_fork: false,
    draft: false,
    mergeable: 'MERGEABLE',
    checks: [],
    reviews: [],
    labels: [],
    comments: [],
    created_at: '2026-08-25T00:00:00.000Z',
    updated_at: '2026-08-26T00:00:00.000Z',
    synced_at: '2026-08-26T00:00:00.000Z',
    ci_status: 'pass',
    review_status: 'approved',
    stack_parent: null,
    stack_children: [],
    stack_depth: 0,
    stack_root: 'acme/widgets#42',
    is_stacked: false,
    stack_size: 1,
    stack_position: 1,
    work_item_id: null,
    work_item: null,
  };
}

/** @returns {import('../../types').Workspace} */
function workspace() {
  return {
    id: 'workspace-1',
    pr_id: 'acme/widgets#42',
    work_item_id: null,
    name: 'widget-fix',
    path: '/tmp/widget-fix',
    bookmark: 'widget-fix',
    repo: 'acme/widgets',
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
    workspace_id: 'workspace-1',
    work_item_id: null,
    name: null,
    target: { type: 'workspace', id: 'workspace-1' },
    activity_state: null,
    activity_changed_at: null,
    pid: 123,
    provider: 'codex',
    status: 'active',
    started_at: '2026-08-26T00:00:00.000Z',
    ended_at: null,
    claude_project_dir: null,
    transcript_path: null,
  };
}

function renderDetail(onBack = vi.fn()) {
  return {
    onBack,
    rendered: render(
      <AgentProviderProvider>
        <PRDetail prId="acme/widgets#42" onBack={onBack} workspaceStates={new Map()} />
      </AgentProviderProvider>,
    ),
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  localStorage.setItem('claude-patrol-agent-provider', 'codex');
  api.fetchProviderCapabilities.mockResolvedValue({
    claude: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
    codex: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
  });
  api.fetchPR.mockResolvedValue(pullRequest());
  api.fetchWorkspaces.mockResolvedValue([]);
  api.fetchPRComments.mockResolvedValue({ reviews: [], conversation: [] });
  api.fetchSessions.mockResolvedValue([]);
  api.createWorkspace.mockResolvedValue(workspace());
  api.createSession.mockResolvedValue(session());
  api.destroyWorkspace.mockResolvedValue({});
  api.fetchCheckLogs.mockResolvedValue({ logs: [] });
  api.refreshPR.mockResolvedValue({ ...pullRequest(), title: 'Refreshed widget fix' });
  api.setPRDraft.mockResolvedValue({ draft: true });
});

test('calls the workspace and session API adapters and renders an in-flow terminal', async () => {
  const user = userEvent.setup();
  renderDetail();

  assert.ok(await screen.findByRole('heading', { name: 'Ship the widget fix' }));
  assert.ok(screen.getByRole('heading', { name: 'Terminal' }));
  await user.click(screen.getByRole('button', { name: 'Open in Codex' }));

  await waitFor(() => {
    assert.deepEqual(api.createWorkspace.mock.calls, [['acme/widgets#42']]);
    assert.deepEqual(api.createSession.mock.calls, [[{ type: 'workspace', id: 'workspace-1' }, 'codex']]);
  });
  const terminal = await screen.findByTestId('terminal');
  assert.equal(terminal.getAttribute('data-session'), 'session-1');
  assert.equal(terminal.getAttribute('data-presentation'), 'work-page');
  assert.equal(terminal.getAttribute('data-popout'), 'false');
});

test('refresh and draft actions call their real API adapters', async () => {
  const user = userEvent.setup();
  renderDetail();
  await screen.findByRole('heading', { name: 'Ship the widget fix' });

  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  assert.ok(await screen.findByRole('heading', { name: 'Refreshed widget fix' }));
  assert.deepEqual(api.refreshPR.mock.calls, [['acme/widgets#42']]);

  await user.click(screen.getByRole('button', { name: 'Mark draft' }));
  assert.deepEqual(api.setPRDraft.mock.calls, [['acme/widgets#42', true]]);
  assert.ok(await screen.findByRole('button', { name: 'Mark ready' }));
});

test('existing workspace session stays above PR detail content and back remains delegated', async () => {
  const onBack = vi.fn();
  api.fetchWorkspaces.mockResolvedValue([workspace()]);
  api.fetchSessions.mockResolvedValue([session()]);
  renderDetail(onBack);

  const terminal = await screen.findByTestId('terminal');
  const rules = screen.getByText('Rules');
  assert.ok(terminal.compareDocumentPosition(rules) & Node.DOCUMENT_POSITION_FOLLOWING);
  assert.equal(terminal.getAttribute('data-workspace'), 'workspace-1');
  assert.equal(terminal.getAttribute('data-pr'), 'acme/widgets#42');
  await userEvent.click(screen.getByRole('button', { name: '← Work' }));
  assert.equal(onBack.mock.calls.length, 1);
});

test('failed-check log and workspace cleanup actions keep their API contracts', async () => {
  const user = userEvent.setup();
  const failing = pullRequest();
  failing.checks = [
    {
      name: 'unit-tests',
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      url: 'https://github.com/acme/widgets/actions/runs/98765/job/1',
    },
  ];
  failing.ci_status = 'fail';
  api.fetchPR.mockResolvedValue(failing);
  api.fetchWorkspaces.mockResolvedValueOnce([workspace()]).mockResolvedValueOnce([]);
  api.fetchSessions.mockResolvedValue([session()]);

  renderDetail();
  await screen.findByRole('heading', { name: 'Ship the widget fix' });
  await user.click(screen.getByRole('button', { name: 'View log' }));
  await waitFor(() => {
    assert.deepEqual(api.fetchCheckLogs.mock.calls, [['acme/widgets#42', '98765']]);
  });

  await user.click(screen.getByRole('button', { name: 'Destroy' }));
  await user.click(screen.getByRole('button', { name: 'Yes, destroy' }));
  await waitFor(() => {
    assert.deepEqual(api.destroyWorkspace.mock.calls, [['workspace-1']]);
  });
});

test('load failures are rendered as truthful unavailable state', async () => {
  api.fetchPR.mockRejectedValue(new Error('GitHub source unavailable'));
  renderDetail();

  assert.ok(await screen.findByRole('alert'));
  assert.ok(screen.getByText('GitHub source unavailable'));
});
