import assert from 'node:assert/strict';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, test, vi } from 'vitest';
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
  killSession: vi.fn(),
  reattachSession: vi.fn(),
  retryWorkItem: vi.fn(),
}));

vi.mock('../../hooks/useWorkItems.js', () => ({ useWorkItem: () => hook }));
vi.mock('../../lib/api.js', () => api);
vi.mock('../TerminalCard/TerminalCard.jsx', () => ({
  /** @param {{session: import('../../types').Session}} props */
  TerminalCard: ({ session }) => <div data-testid="root-terminal">Terminal {session.id}</div>,
}));
vi.mock('../SessionHistory/SessionHistory.jsx', () => ({
  /** @param {{target: import('../../types').SessionTarget}} props */
  SessionHistory: ({ target }) => <div data-testid="session-history">History {target.type}</div>,
}));

/** @returns {import('../../types').WorkItemDetail} */
function detail() {
  return {
    id: 'item-1',
    reference: 'ECO-3632',
    title: 'Repair JavaScript CVEs',
    summary: 'Update both repositories.\nKeep their changes aligned.',
    work_provider: 'codex',
    resolver_provider: 'codex',
    state: 'ready',
    stage: 'complete',
    progress: { current: 0, total: 0 },
    repositories: ['acme/alpha', 'acme/beta'],
    updated_at: '2026-08-22T00:00:00.000Z',
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

beforeEach(() => {
  hook.workItem = detail();
  hook.loading = false;
  hook.error = null;
  hook.reload.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchSessions.mockResolvedValue([]);
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
  };
  hook.workItem = { ...detail(), session: { id: 'session-1', status: 'active', activity_state: null } };
  api.fetchSessions.mockResolvedValue([liveSession]);

  render(<WorkItemDetail workItemId="item-1" onBack={vi.fn()} targetStates={new Map()} />);

  assert.equal((await screen.findAllByTestId('root-terminal')).length, 1);
  assert.ok(screen.getByText(/Update both repositories\.\s+Keep their changes aligned\./));
  assert.equal(screen.getAllByRole('button', { name: 'Copy path' }).length, 1);
  assert.equal(screen.queryByRole('link', { name: /acme\/alpha/ }), null);
  assert.ok(screen.getByTestId('session-history').textContent?.includes('work_item'));
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

  render(<WorkItemDetail workItemId="item-1" onBack={vi.fn()} targetStates={new Map()} />);

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

  render(<WorkItemDetail workItemId="item-1" onBack={vi.fn()} targetStates={new Map()} />);
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

  render(<WorkItemDetail workItemId="item-1" onBack={vi.fn()} targetStates={new Map()} />);

  assert.ok(screen.getByText('Destroyed'));
  assert.equal(screen.queryByTestId('root-terminal'), null);
  assert.equal(screen.queryByRole('button', { name: 'Restart terminal' }), null);
  assert.equal(screen.queryByRole('button', { name: 'Copy path' }), null);
  await waitFor(() => assert.equal(api.fetchSessions.mock.calls.length, 0));
  assert.ok(screen.getByTestId('session-history'));
});
