import assert from 'node:assert/strict';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { useWorkDashboard } from './useWorkDashboard.js';

const state = vi.hoisted(() => ({
  fetchWorkspaces: vi.fn(),
  prSource: {},
  workItemSource: {},
  sessionSource: {},
}));

vi.mock('../lib/api.js', () => ({ fetchWorkspaces: state.fetchWorkspaces }));
vi.mock('./usePRs.js', () => ({ usePRs: () => state.prSource }));
vi.mock('./useWorkItems.js', () => ({ useWorkItems: () => state.workItemSource }));
vi.mock('./useGlobalSessions.js', () => ({ useGlobalSessions: () => state.sessionSource }));

const workItem = /** @type {import('../types').WorkItemListItem} */ ({
  id: 'work-1',
  creation_source: 'reference',
  reference: 'one',
  reference_display: 'ONE-1',
  reference_system: 'tracker',
  reference_url: null,
  title: 'Historical work',
  resolver_provider: 'codex',
  repositories: ['org/repo'],
  pull_request_count: 0,
  pull_requests: [],
  repository_workspaces: [],
  updated_at: '2026-08-26T10:00:00.000Z',
  state: 'destroyed',
  stage: 'complete',
  progress: { current: 1, total: 1 },
  has_session_history: true,
  session: null,
  error: null,
});

const scratch = /** @type {import('../types').Workspace} */ ({
  id: 'scratch-1',
  pr_id: null,
  name: 'scratch',
  bookmark: 'scratch',
  repo: 'org/repo',
  created_at: '2026-08-26T10:00:00.000Z',
  operation_updated_at: null,
});

beforeEach(() => {
  state.fetchWorkspaces.mockReset();
  state.prSource = {
    prs: [],
    loading: false,
    loaded: false,
    error: null,
  };
  state.workItemSource = {
    workItems: [workItem],
    loading: false,
    loaded: true,
    error: null,
  };
  state.sessionSource = {
    allSessions: [],
    loading: false,
    loaded: true,
    error: null,
  };
});

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])('reports the poll=%s work-items=%s configuration without hiding historical work', async (poll, workItems) => {
  state.fetchWorkspaces.mockResolvedValue([]);
  state.prSource = { ...state.prSource, loaded: poll };
  const { result } = renderHook(() =>
    useWorkDashboard({
      enabled: true,
      pollConfigured: poll,
      workItemsConfigured: workItems,
      changeToken: 0,
    }),
  );

  await waitFor(() => assert.equal(result.current.sources.workspaces.status, 'ready'));
  assert.equal(state.fetchWorkspaces.mock.calls.length, 1);
  assert.deepEqual(result.current.configured, { pull_requests: poll, work_items: workItems });
  assert.equal(result.current.sources.pull_requests.status, poll ? 'ready' : 'disabled');
  assert.equal(result.current.counts.open_pull_requests, poll ? 0 : null);
  assert.equal(result.current.rows[0]?.id, workItem.id);
});

test('keeps a loaded PR visible when the work-item batch is initially unavailable', async () => {
  state.fetchWorkspaces.mockResolvedValue([]);
  state.prSource = {
    ...state.prSource,
    prs: [
      {
        id: 'org/repo#1',
        number: 1,
        title: 'Owned PR with unavailable owner source',
        org: 'org',
        repo: 'repo',
        url: 'https://example.test/1',
        draft: false,
        mergeable: 'MERGEABLE',
        ci_status: 'pass',
        review_status: 'approved',
        updated_at: '2026-08-26T11:00:00.000Z',
        work_item_id: 'missing-owner',
      },
    ],
    loading: false,
    loaded: true,
  };
  state.workItemSource = {
    workItems: [],
    loading: false,
    loaded: false,
    error: new Error('work items offline'),
  };

  const { result } = renderHook(() =>
    useWorkDashboard({
      enabled: true,
      pollConfigured: true,
      workItemsConfigured: true,
      changeToken: 0,
    }),
  );

  await waitFor(() => assert.equal(result.current.sources.workspaces.status, 'ready'));
  assert.equal(result.current.sources.work_items.status, 'unavailable');
  assert.deepEqual(
    result.current.rows.map((dashboardRow) => dashboardRow.id),
    ['org/repo#1'],
  );
});

test.each(['pull request first', 'work item first'])(
  'reconciles ownership without duplicates when the %s source finishes first',
  async (firstSource) => {
    const ownedPR = {
      id: 'org/repo#2',
      number: 2,
      title: 'Eventually reconciled PR',
      org: 'org',
      repo: 'repo',
      url: 'https://example.test/2',
      draft: false,
      mergeable: 'MERGEABLE',
      ci_status: 'pass',
      review_status: 'approved',
      updated_at: '2026-08-26T11:00:00.000Z',
      work_item_id: workItem.id,
    };
    state.fetchWorkspaces.mockResolvedValue([]);
    state.prSource = {
      ...state.prSource,
      prs: firstSource === 'pull request first' ? [ownedPR] : [],
      loading: firstSource !== 'pull request first',
      loaded: firstSource === 'pull request first',
    };
    state.workItemSource = {
      ...state.workItemSource,
      workItems: firstSource === 'work item first' ? [workItem] : [],
      loading: firstSource !== 'work item first',
      loaded: firstSource === 'work item first',
    };

    const { result, rerender } = renderHook(() =>
      useWorkDashboard({
        enabled: true,
        pollConfigured: true,
        workItemsConfigured: true,
        changeToken: 0,
      }),
    );
    await waitFor(() => assert.equal(result.current.sources.workspaces.status, 'ready'));

    state.prSource = { ...state.prSource, prs: [ownedPR], loading: false, loaded: true };
    state.workItemSource = { ...state.workItemSource, workItems: [workItem], loading: false, loaded: true };
    rerender();

    assert.deepEqual(
      result.current.rows.map((dashboardRow) => dashboardRow.kind),
      ['work_item'],
    );
    assert.deepEqual(
      result.current.rows[0].pull_requests.map((pr) => pr.id),
      [ownedPR.id],
    );
  },
);

test('marks an initial workspace failure unavailable instead of returning a zero count', async () => {
  state.fetchWorkspaces.mockRejectedValue(new Error('offline'));
  const { result } = renderHook(() =>
    useWorkDashboard({
      enabled: true,
      pollConfigured: false,
      workItemsConfigured: true,
      changeToken: 0,
    }),
  );

  await waitFor(() => assert.equal(result.current.sources.workspaces.status, 'unavailable'));
  assert.equal(result.current.counts.active_workspaces, null);
});

test('retains workspace rows and marks them stale after a later failure', async () => {
  state.fetchWorkspaces.mockResolvedValueOnce([scratch]).mockRejectedValueOnce(new Error('offline'));
  const { result, rerender } = renderHook(
    ({ changeToken }) =>
      useWorkDashboard({
        enabled: true,
        pollConfigured: false,
        workItemsConfigured: true,
        changeToken,
      }),
    { initialProps: { changeToken: 0 } },
  );

  await waitFor(() => assert.equal(result.current.sources.workspaces.status, 'ready'));
  assert.equal(
    result.current.rows.some((row) => row.id === scratch.id),
    true,
  );
  rerender({ changeToken: 1 });
  await waitFor(() => assert.equal(result.current.sources.workspaces.status, 'stale'));
  assert.equal(
    result.current.rows.some((row) => row.id === scratch.id),
    true,
  );
});
