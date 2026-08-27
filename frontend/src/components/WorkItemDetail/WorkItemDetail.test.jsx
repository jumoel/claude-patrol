import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, test, vi } from 'vitest';
import { AgentProviderProvider } from '../../context/AgentProviderContext.jsx';
import { WorkItemDetail } from './WorkItemDetail.jsx';

const hook = vi.hoisted(() => ({
  workItem: /** @type {import('../../types').WorkItemDetail | null} */ (null),
  loading: false,
  error: /** @type {unknown} */ (null),
  reload: vi.fn(),
}));

const api = vi.hoisted(() => ({
  createSession: vi.fn(),
  destroyWorkItem: vi.fn(),
  fetchSessions: vi.fn(),
  fetchProviderCapabilities: vi.fn(),
  killSession: vi.fn(),
  reattachSession: vi.fn(),
  retryWorkItem: vi.fn(),
}));

vi.mock('../../hooks/useWorkItems.js', () => ({ useWorkItem: () => hook }));
vi.mock('../../lib/api.js', () => api);
vi.mock('../TerminalCard/TerminalCard.jsx', () => ({
  /** @param {{session: import('../../types').Session, presentation?: string}} props */
  TerminalCard: ({ session, presentation }) => (
    <div data-testid="root-terminal" data-session={session.id} data-presentation={presentation}>
      Terminal {session.id}
    </div>
  ),
}));
vi.mock('../SessionHistory/SessionHistory.jsx', () => ({
  /** @param {{target: import('../../types').SessionTarget}} props */
  SessionHistory: ({ target }) => <div data-testid="session-history">History {target.type}</div>,
}));
vi.mock('../LinkedPullRequests/LinkedPullRequests.jsx', () => ({
  LinkedPullRequests: () => <div data-testid="linked-pull-requests">Pull requests</div>,
}));

/** @returns {import('../../types').WorkItemDetail} */
function detail() {
  return {
    id: 'item-1',
    reference: 'ECO-3632',
    reference_display: 'ECO-3632',
    reference_system: 'linear.app',
    reference_url: 'https://linear.app/acme/issue/ECO-3632/title',
    title: 'Repair JavaScript CVEs',
    summary: 'Update both repositories.\nKeep their changes aligned.',
    work_provider: 'codex',
    resolver_provider: 'codex',
    state: 'ready',
    stage: 'complete',
    progress: { current: 0, total: 0 },
    repositories: ['acme/alpha', 'acme/beta'],
    pull_request_count: 0,
    pull_requests: [],
    updated_at: '2026-08-22T00:00:00.000Z',
    has_session_history: false,
    created_at: '2026-08-21T00:00:00.000Z',
    destroyed_at: null,
    root_path: '/tmp/work-item',
    session: null,
    error: null,
    repository_workspaces: [
      {
        identifier: 'acme/alpha',
        workspace_id: 'child-1',
        state: 'ready',
        path: '/tmp/work-item/repos/alpha',
        checkout_available: true,
        bookmark: 'patrol/work-item-123456789abc',
        start_revision: 'main@origin',
        base_commit: 'a'.repeat(64),
        warnings: [],
      },
      {
        identifier: 'acme/beta',
        workspace_id: null,
        state: 'pending',
        path: null,
        checkout_available: false,
        bookmark: 'patrol/work-item-123456789abc',
        start_revision: 'main@origin',
        base_commit: null,
        warnings: [],
      },
    ],
  };
}

/** @param {string} [workItemId] @param {string | null} [selectedPrId] */
function renderDetail(workItemId = 'item-1', selectedPrId = null) {
  return render(
    <AgentProviderProvider>
      <WorkItemDetail workItemId={workItemId} selectedPrId={selectedPrId} targetStates={new Map()} />
    </AgentProviderProvider>,
  );
}

beforeEach(() => {
  hook.workItem = detail();
  hook.loading = false;
  hook.error = null;
  hook.reload.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  localStorage.clear();
  api.fetchSessions.mockResolvedValue([]);
  api.fetchProviderCapabilities.mockResolvedValue({
    claude: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
    codex: { available: true, checking: false, reason: null, version: 'test', checkedAt: null },
  });
  api.retryWorkItem.mockResolvedValue({});
  api.destroyWorkItem.mockResolvedValue({});
});

test('ready detail renders one root terminal and no child controls', async () => {
  const liveSession = {
    id: 'session-1',
    workspace_id: null,
    work_item_id: 'item-1',
    target: { type: /** @type {'work_item'} */ ('work_item'), id: 'item-1' },
    pid: 123,
    provider: /** @type {'codex'} */ ('codex'),
    status: /** @type {'active'} */ ('active'),
    started_at: '2026-08-22T00:00:00.000Z',
    ended_at: null,
    activity_state: null,
    activity_changed_at: null,
  };
  hook.workItem = {
    ...detail(),
    has_session_history: true,
    session: { id: 'session-1', status: 'active', activity_state: null, activity_changed_at: null },
  };
  api.fetchSessions.mockResolvedValue([liveSession]);

  renderDetail();

  assert.equal((await screen.findAllByTestId('root-terminal')).length, 1);
  assert.equal(screen.getByTestId('root-terminal').getAttribute('data-session'), 'session-1');
  assert.equal(screen.getByTestId('root-terminal').getAttribute('data-presentation'), 'work-page');
  assert.ok(screen.getByText('Idle'));
  assert.equal(screen.queryByText('Live'), null);
  assert.ok(screen.getByText(/Update both repositories\.\s+Keep their changes aligned\./));
  assert.equal(screen.getAllByRole('button', { name: 'Copy path' }).length, 1);
  assert.equal(screen.queryByRole('link', { name: /acme\/alpha/ }), null);
  assert.ok(screen.getByTestId('session-history').textContent?.includes('work_item'));
});

test('overview stays visible while the repository pane remembers collapsed state per work item', async () => {
  const user = userEvent.setup();
  const first = renderDetail();

  assert.ok(screen.getByRole('heading', { name: 'Overview' }));
  await user.click(screen.getByRole('button', { name: 'Collapse Repositories' }));
  assert.ok(screen.getByRole('button', { name: 'Expand Repositories' }));
  first.unmount();

  const remembered = renderDetail();
  assert.ok(screen.getByRole('heading', { name: 'Overview' }));
  assert.ok(screen.getByRole('button', { name: 'Expand Repositories' }));
  remembered.unmount();

  hook.workItem = { ...detail(), id: 'item-2' };
  renderDetail('item-2');
  assert.ok(screen.getByRole('button', { name: 'Collapse Repositories' }));
});

test('terminal is the first work surface after the header', async () => {
  hook.workItem = {
    ...detail(),
    session: { id: 'session-1', status: 'active', activity_state: null, activity_changed_at: null },
  };
  api.fetchSessions.mockResolvedValue([
    {
      id: 'session-1',
      workspace_id: null,
      work_item_id: 'item-1',
      target: { type: 'work_item', id: 'item-1' },
      pid: 123,
      provider: 'codex',
      status: 'active',
      started_at: '2026-08-22T00:00:00.000Z',
      ended_at: null,
      activity_state: null,
      activity_changed_at: null,
    },
  ]);

  renderDetail();

  const terminal = await screen.findByTestId('root-terminal');
  const overview = screen.getByRole('heading', { name: 'Overview' }).closest('section');
  assert.ok(overview);
  assert.ok(terminal.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING);
});

test('missing or invalid PR selection is replaced with the first attached PR in the URL', async () => {
  hook.workItem = {
    ...detail(),
    pull_request_count: 2,
    pull_requests: [
      {
        id: 'acme/alpha#101',
        org: 'acme',
        repo: 'alpha',
        repository: 'acme/alpha',
        number: 101,
        title: 'First PR',
        url: 'https://github.com/acme/alpha/pull/101',
        branch: 'feature',
        base_branch: 'main',
        draft: false,
        mergeable: 'MERGEABLE',
        ci_status: 'pass',
        review_status: 'approved',
        updated_at: '2026-08-26T00:00:00.000Z',
        tracked: true,
        linked_at: '2026-08-26T00:00:00.000Z',
        link_source: 'explicit',
      },
      {
        id: 'acme/beta#102',
        org: 'acme',
        repo: 'beta',
        repository: 'acme/beta',
        number: 102,
        title: 'Second PR',
        url: 'https://github.com/acme/beta/pull/102',
        branch: 'feature-two',
        base_branch: 'main',
        draft: false,
        mergeable: 'UNKNOWN',
        ci_status: 'pending',
        review_status: 'pending',
        updated_at: '2026-08-26T00:00:00.000Z',
        tracked: true,
        linked_at: '2026-08-26T00:00:00.000Z',
        link_source: 'explicit',
      },
    ],
  };
  for (const selectedPrId of [null, 'missing']) {
    history.replaceState(null, '', selectedPrId ? '/#/work-item/item-1?pr=missing' : '/#/work-item/item-1');
    const rendered = renderDetail('item-1', selectedPrId);
    await waitFor(() => {
      assert.equal(window.location.hash, '#/work-item/item-1?pr=acme%2Falpha%23101');
    });
    rendered.unmount();
  }
});

test('cleanup failure shows one retry, retained root, and copy feedback', async () => {
  const failed = detail();
  failed.state = 'error';
  failed.stage = 'child_destruction';
  failed.progress = { current: 1, total: 2 };
  failed.error = {
    code: 'cleanup_failed',
    detail: 'jj workspace forget failed',
    failed_provider: null,
    retry_action: 'cleanup',
    recovery_actions: [{ kind: 'command', label: 'Authenticate Codex', command: 'codex login' }],
  };
  hook.workItem = failed;
  const user = userEvent.setup();

  renderDetail();

  assert.ok(screen.getByRole('button', { name: 'Retry cleanup' }));
  assert.ok(screen.getByText('Remove repositories 1/2 failed'));
  assert.equal(screen.queryByRole('button', { name: 'Destroy' }), null);
  assert.ok(screen.getByText('Retained root: /tmp/work-item'));
  await user.click(screen.getByRole('button', { name: 'Authenticate Codex' }));
  assert.ok(await screen.findByRole('button', { name: 'Copied' }));
});

test('destroy uses the bookmark-preservation confirmation and keeps request failures inline', async () => {
  const user = userEvent.setup();
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.destroyWorkItem.mockRejectedValue(new Error('cleanup request rejected'));

  renderDetail();
  await user.click(screen.getByRole('button', { name: 'Destroy' }));

  assert.equal(
    confirm.mock.calls[0][0],
    'Remove 1 checkout directories and their jj workspace registrations. Patrol will leave repository bookmarks and commits in the source repositories.',
  );
  assert.ok(await screen.findByRole('alert'));
  assert.ok(screen.getByText('cleanup request rejected'));
  confirm.mockRestore();
});

test('destroyed detail retains history without terminal or repository actions', async () => {
  const destroyed = detail();
  destroyed.state = 'destroyed';
  destroyed.destroyed_at = '2026-08-22T01:00:00.000Z';
  destroyed.repository_workspaces = destroyed.repository_workspaces.map((repository) => ({
    ...repository,
    state: /** @type {'removed'} */ ('removed'),
    checkout_available: false,
  }));
  hook.workItem = destroyed;

  renderDetail();

  assert.ok(screen.getByText('Destroyed'));
  assert.equal(screen.queryByTestId('root-terminal'), null);
  assert.equal(screen.queryByRole('button', { name: /Open terminal with|Reopen terminal with/ }), null);
  assert.equal(screen.queryByRole('button', { name: 'Copy path' }), null);
  await waitFor(() => assert.equal(api.fetchSessions.mock.calls.length, 0));
  assert.ok(screen.getByTestId('session-history'));
});

test('a ready work item can switch providers before opening an idle terminal', async () => {
  const user = userEvent.setup();
  localStorage.setItem('claude-patrol-agent-provider', 'codex');
  const launched = {
    id: 'session-2',
    workspace_id: null,
    work_item_id: 'item-1',
    target: { type: /** @type {'work_item'} */ ('work_item'), id: 'item-1' },
    pid: 321,
    provider: /** @type {'claude'} */ ('claude'),
    status: /** @type {'active'} */ ('active'),
    started_at: '2026-08-22T01:00:00.000Z',
    ended_at: null,
    activity_state: null,
    activity_changed_at: null,
  };
  api.createSession.mockResolvedValue(launched);

  renderDetail();

  assert.ok(await screen.findByRole('button', { name: 'Open terminal with Codex' }));
  assert.equal(screen.queryByText('No LLM session is attached to this work item.'), null);
  assert.equal(document.querySelector('[data-state-marker="inactive"]'), null);
  await user.click(screen.getByRole('button', { name: /Choose agent provider, currently Codex/ }));
  await user.click(screen.getByRole('menuitemradio', { name: /Claude/ }));
  await user.click(screen.getByRole('button', { name: 'Open terminal with Claude' }));

  assert.deepEqual(api.createSession.mock.calls, [[{ type: 'work_item', id: 'item-1' }, 'claude']]);
  assert.ok(await screen.findByTestId('root-terminal'));
  assert.equal(hook.reload.mock.calls.length, 1);
});
