import { describe, expect, it } from 'vitest';
import {
  buildDashboardRows,
  buildWaitingSessions,
  dashboardSourceState,
  filterDashboardRows,
  serializeDashboardRowsMarkdown,
} from './work-dashboard.js';

const trackedPR = /** @type {import('../types').PullRequest} */ ({
  id: 'chainguard/mono#10',
  number: 10,
  title: 'Tracked pull request',
  url: 'https://example.test/pull/10',
  org: 'chainguard',
  repo: 'mono',
  draft: false,
  mergeable: 'MERGEABLE',
  ci_status: 'pass',
  review_status: 'approved',
  updated_at: '2026-08-26T12:00:00.000Z',
  work_item_id: 'work-1',
});

const standalonePR = /** @type {import('../types').PullRequest} */ ({
  ...trackedPR,
  id: 'chainguard/mono#11',
  number: 11,
  title: 'Standalone pull request',
  url: 'https://example.test/pull/11',
  updated_at: '2026-08-26T11:00:00.000Z',
  work_item_id: null,
});

const workItem = /** @type {import('../types').WorkItemListItem} */ ({
  id: 'work-1',
  reference: 'eco-1',
  reference_display: 'ECO-1',
  reference_system: 'linear',
  reference_url: 'https://example.test/ECO-1',
  title: 'Fix the thing',
  work_provider: 'codex',
  resolver_provider: 'codex',
  repositories: ['chainguard/mono'],
  state: 'ready',
  stage: 'complete',
  progress: { current: 2, total: 2 },
  pull_request_count: 2,
  updated_at: '2026-08-26T10:00:00.000Z',
  has_session_history: true,
  session: null,
  error: null,
  repository_workspaces: [
    {
      identifier: 'chainguard/mono',
      workspace_id: 'child-1',
      state: 'ready',
      path: '/tmp/child-1',
      checkout_available: true,
      bookmark: 'eco-1',
      start_revision: 'main',
      base_commit: null,
      warnings: [],
    },
  ],
  pull_requests: [
    {
      ...trackedPR,
      title: 'Stale linked title',
      ci_status: 'pending',
      review_status: 'pending',
      repository: 'chainguard/mono',
      branch: 'eco-1',
      base_branch: 'main',
      tracked: true,
      linked_at: '2026-08-26T10:00:00.000Z',
      link_source: 'explicit',
    },
    {
      ...trackedPR,
      id: 'other/repo#22',
      number: 22,
      title: 'Untracked pull request',
      org: 'other',
      repo: 'repo',
      repository: 'other/repo',
      branch: 'eco-1',
      base_branch: 'main',
      tracked: false,
      linked_at: '2026-08-26T10:00:00.000Z',
      link_source: 'explicit',
    },
  ],
});

const standaloneWorkspace = /** @type {import('../types').Workspace} */ ({
  id: 'workspace-1',
  pr_id: standalonePR.id,
  name: 'PR workspace',
  bookmark: 'pull-11',
  repo: null,
  created_at: '2026-08-26T09:00:00.000Z',
  operation_updated_at: null,
});

const scratchWorkspace = /** @type {import('../types').Workspace} */ ({
  id: 'scratch-1',
  pr_id: null,
  name: 'investigation',
  bookmark: 'investigation',
  repo: 'chainguard/wolfi-os',
  created_at: '2026-08-26T08:00:00.000Z',
  operation_updated_at: null,
});

const sessions = /** @type {import('../types').Session[]} */ ([
  {
    id: 'session-work',
    name: null,
    target: { type: 'work_item', id: workItem.id },
    activity_state: 'idle',
    activity_changed_at: '2026-08-26T12:30:00.000Z',
    provider: 'codex',
    status: 'active',
    started_at: '2026-08-26T08:00:00.000Z',
  },
  {
    id: 'session-child',
    name: null,
    target: { type: 'workspace', id: 'child-1' },
    activity_state: 'working',
    activity_changed_at: '2026-08-26T12:20:00.000Z',
    provider: 'claude',
    status: 'active',
    started_at: '2026-08-26T08:00:00.000Z',
  },
  {
    id: 'session-global',
    name: 'deploy',
    target: { type: 'global' },
    activity_state: 'idle',
    activity_changed_at: '2026-08-26T12:10:00.000Z',
    provider: 'codex',
    status: 'detached',
    started_at: '2026-08-26T08:00:00.000Z',
  },
]);

describe('buildDashboardRows', () => {
  it('keeps attached pull requests inside their work item and overlays tracked status', () => {
    const rows = buildDashboardRows({
      pullRequests: [trackedPR, standalonePR],
      workItems: [workItem],
      workspaces: [standaloneWorkspace, scratchWorkspace],
      sessions,
    });

    expect(rows.map((row) => row.kind)).toEqual(['work_item', 'pull_request', 'scratch']);
    const owner = rows.find((row) => row.kind === 'work_item');
    expect(owner?.pull_requests).toHaveLength(2);
    expect(owner?.pull_requests[0]).toMatchObject({ title: 'Tracked pull request', ci_status: 'pass' });
    expect(owner?.pull_requests[1]).toMatchObject({ tracked: false, ci_status: null, review_status: null });
    expect(owner?.sessions.map((session) => session.id)).toEqual(['session-work', 'session-child']);
    expect(owner?.updated_at).toBe(trackedPR.updated_at);
  });
});

describe('buildWaitingSessions', () => {
  it('lists idle LLM sessions and respects acknowledged local targets', () => {
    expect(buildWaitingSessions(sessions, new Map()).map((session) => session.id)).toEqual([
      'session-work',
      'session-global',
    ]);
    expect(
      buildWaitingSessions(sessions, new Map([['session-work', '2026-08-26T12:30:00.000Z']])).map(
        (session) => session.id,
      ),
    ).toEqual(['session-global']);
  });
});

describe('filterDashboardRows', () => {
  const multiPRRow = /** @type {import('../types').DashboardWorkRow} */ ({
    kind: 'work_item',
    id: 'work-1',
    title: 'Grouped work',
    work_reference: { display: 'ONE-1', system: 'tracker', url: null },
    repositories: ['org/repo'],
    pull_requests: [
      {
        id: 'pr-pass',
        number: 1,
        title: 'Passing CI',
        url: 'https://example.test/1',
        org: 'org',
        repo: 'repo',
        draft: false,
        mergeable: 'MERGEABLE',
        ci_status: 'pass',
        review_status: 'pending',
        updated_at: null,
        tracked: true,
        stack_root: null,
        stack_depth: 0,
        is_stacked: false,
      },
      {
        id: 'pr-approved',
        number: 2,
        title: 'Approved review',
        url: 'https://example.test/2',
        org: 'org',
        repo: 'repo',
        draft: false,
        mergeable: 'MERGEABLE',
        ci_status: 'fail',
        review_status: 'approved',
        updated_at: null,
        tracked: true,
        stack_root: null,
        stack_depth: 0,
        is_stacked: false,
      },
    ],
    sessions: [],
    workspace_count: 0,
    workspace_id: null,
    updated_at: '2026-08-26T10:00:00.000Z',
    state: 'ready',
  });
  const scratchRow = /** @type {import('../types').DashboardWorkRow} */ ({
    kind: 'scratch',
    id: 'scratch',
    title: 'Scratch',
    work_reference: null,
    repositories: ['org/other'],
    pull_requests: [],
    sessions: [],
    workspace_count: 1,
    workspace_id: 'scratch',
    updated_at: '2026-08-26T09:00:00.000Z',
    state: null,
  });

  it('requires one PR to satisfy every active PR constraint', () => {
    expect(filterDashboardRows([multiPRRow], { ci: ['pass'], review: ['approved'] }).map((row) => row.id)).toEqual([]);
    expect(filterDashboardRows([multiPRRow], { ci: ['pass'], review: ['pending'] }).map((row) => row.id)).toEqual([
      'work-1',
    ]);
  });

  it('allows repository-only filters to match scratch work and excludes it from PR status filters', () => {
    expect(filterDashboardRows([multiPRRow, scratchRow], { org: ['org'] })).toHaveLength(2);
    expect(filterDashboardRows([multiPRRow, scratchRow], { ci: ['fail'] }).map((row) => row.id)).toEqual(['work-1']);
  });

  it('serializes the visible row order without inventing a work-reference URL', () => {
    expect(serializeDashboardRowsMarkdown([scratchRow, multiPRRow])).toContain('- Work item ONE-1 - Grouped work');
    expect(serializeDashboardRowsMarkdown([scratchRow, multiPRRow]).startsWith('- Scratch - Scratch')).toBe(true);
  });
});

describe('dashboardSourceState', () => {
  it('distinguishes stale retained data from an unavailable source', () => {
    expect(dashboardSourceState(new Error('offline'), false, true).status).toBe('stale');
    expect(dashboardSourceState(new Error('offline'), false, false).status).toBe('unavailable');
    expect(dashboardSourceState(null, true, false).status).toBe('loading');
    expect(dashboardSourceState(null, false, true).status).toBe('ready');
    expect(dashboardSourceState(null, false, false, false).status).toBe('disabled');
  });
});
