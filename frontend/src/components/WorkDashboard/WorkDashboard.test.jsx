import assert from 'node:assert/strict';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, test, vi } from 'vitest';
import { WorkDashboard } from './WorkDashboard.jsx';

const pullRequest = /** @type {import('../../types').DashboardPullRequestSummary} */ ({
  id: 'org/repo#1',
  number: 1,
  title: 'First PR',
  url: 'https://example.test/1',
  org: 'org',
  repo: 'repo',
  draft: false,
  mergeable: 'MERGEABLE',
  ci_status: 'pass',
  review_status: 'approved',
  updated_at: '2026-08-26T10:00:00.000Z',
  tracked: true,
  stack_root: null,
  stack_depth: 0,
  is_stacked: false,
});

const row = /** @type {import('../../types').DashboardWorkRow} */ ({
  kind: 'work_item',
  id: 'work-1',
  title: 'Grouped work',
  work_reference: { display: 'ONE-1', system: 'tracker', url: null },
  repositories: ['org/repo'],
  pull_requests: [pullRequest, { ...pullRequest, id: 'org/repo#2', number: 2, title: 'Second PR' }],
  sessions: [],
  workspace_count: 1,
  workspace_id: null,
  updated_at: '2026-08-26T10:00:00.000Z',
  state: 'ready',
});

const dashboard = {
  rows: [row],
  counts: { open_pull_requests: 2, work_items: 1, active_workspaces: 1, live_sessions: 0 },
  sources: {
    pull_requests: { status: /** @type {const} */ ('ready'), error: null },
    work_items: { status: /** @type {const} */ ('ready'), error: null },
    workspaces: { status: /** @type {const} */ ('ready'), error: null },
    sessions: { status: /** @type {const} */ ('ready'), error: null },
  },
  prSource: { reload: vi.fn() },
  workItemSource: { reload: vi.fn() },
  workspaceSource: { reload: vi.fn() },
  sessionSource: { allSessions: [], reload: vi.fn() },
};

const defaultProps = {
  dashboard,
  filters: {},
  onFilterChange: vi.fn(),
  sorting: [],
  onSortingChange: vi.fn(),
  stackView: true,
  onStackViewChange: vi.fn(),
  onOpenGlobalTerminal: vi.fn(),
};

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

test('renders a multi-PR work item once and keeps child PR links independent', () => {
  const { container } = render(<WorkDashboard {...defaultProps} />);
  assert.equal(screen.getAllByText('Grouped work').length, 1);
  assert.ok(screen.getByRole('link', { name: 'Open pull request #1: First PR' }));
  assert.ok(screen.getByRole('link', { name: 'Open pull request #2: Second PR' }));

  const primary = screen.getByRole('link', { name: 'Grouped work' });
  const primaryClick = vi.spyOn(primary, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByText('org/repo'));
  assert.equal(primaryClick.mock.calls.length, 1);

  fireEvent.click(screen.getByRole('link', { name: 'Open pull request #1: First PR' }));
  assert.equal(primaryClick.mock.calls.length, 1);
  assert.ok(screen.getByText('PR workspace'));
  assert.ok(screen.getByText('Ready'));
  assert.equal(container.querySelectorAll('[aria-label="PR Open"]').length, 0);
});

test('places a spinner beside working LLM state and a dot beside waiting state', () => {
  const workingSession = /** @type {import('../../types').DashboardSessionSummary} */ ({
    id: 'working-session',
    name: null,
    provider: 'codex',
    target: { type: 'work_item', id: row.id },
    status: 'active',
    activity_state: 'working',
    activity_changed_at: '2026-08-26T10:30:00.000Z',
    started_at: '2026-08-26T09:00:00.000Z',
  });
  const { container } = render(
    <WorkDashboard {...defaultProps} dashboard={{ ...dashboard, rows: [{ ...row, sessions: [workingSession] }] }} />,
  );

  assert.ok(screen.getByText('Working'));
  assert.ok(container.querySelector('[data-spinner="true"]'));
  assert.equal(container.querySelector('[data-state-marker="waiting"]'), null);
});

test('copies the currently visible rows in their rendered order', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<WorkDashboard {...defaultProps} />);
  fireEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
  await vi.waitFor(() => assert.equal(writeText.mock.calls.length, 1));
  assert.match(writeText.mock.calls[0][0], /Work item ONE-1 - Grouped work/);
  assert.match(writeText.mock.calls[0][0], /#2/);
});

test('renders source failures and retained-data status without replacing available rows', () => {
  render(
    <WorkDashboard
      {...defaultProps}
      dashboard={{
        ...dashboard,
        counts: { open_pull_requests: null, work_items: null, active_workspaces: 1, live_sessions: null },
        sources: {
          ...dashboard.sources,
          pull_requests: { status: 'unavailable', error: 'offline' },
          work_items: { status: 'unavailable', error: 'offline' },
          workspaces: { status: 'stale', error: 'timeout' },
          sessions: { status: 'unavailable', error: 'offline' },
        },
      }}
    />,
  );

  assert.match(screen.getByRole('status').textContent || '', /Unavailable: Pull requests, Work items, Sessions/u);
  assert.match(screen.getByRole('status').textContent || '', /Showing retained data for: Workspaces/u);
  for (const { name, reload } of [
    { name: 'pull requests', reload: dashboard.prSource.reload },
    { name: 'work items', reload: dashboard.workItemSource.reload },
    { name: 'workspaces', reload: dashboard.workspaceSource.reload },
    { name: 'sessions', reload: dashboard.sessionSource.reload },
  ]) {
    fireEvent.click(screen.getByRole('button', { name: `Retry ${name}` }));
    assert.equal(reload.mock.calls.length, 1);
  }
  assert.ok(screen.getByText('Sessions are unavailable.'));
  assert.ok(screen.getByRole('link', { name: 'Grouped work' }));
});

test('shows waiting sessions as a list and acknowledges a global session when opened', () => {
  const idleSession = /** @type {import('../../types').Session} */ ({
    id: 'session-1',
    workspace_id: null,
    work_item_id: null,
    name: 'release follow-up',
    target: { type: 'global' },
    activity_state: 'idle',
    activity_changed_at: '2026-08-26T10:30:00.000Z',
    provider: 'codex',
    status: 'active',
    started_at: '2026-08-26T09:00:00.000Z',
    ended_at: null,
    pid: 123,
    claude_project_dir: null,
    transcript_path: null,
  });
  const { container } = render(
    <WorkDashboard
      {...defaultProps}
      dashboard={{ ...dashboard, sessionSource: { ...dashboard.sessionSource, allSessions: [idleSession] } }}
    />,
  );

  const waitingList = screen.getByRole('list');
  assert.ok(waitingList);
  assert.ok(container.querySelector('[data-state-marker="waiting"]'));
  fireEvent.click(screen.getByRole('button', { name: /release follow-up/u }));
  assert.deepEqual(defaultProps.onOpenGlobalTerminal.mock.calls, [['session-1']]);
  assert.equal(screen.queryByText('release follow-up'), null);
  assert.equal(
    JSON.parse(localStorage.getItem('claude-patrol-waiting-ack-v1') || '{}')['session-1'],
    idleSession.activity_changed_at,
  );
});

test('keeps the current filter set visible and applies quick filters from the work-list block', () => {
  render(<WorkDashboard {...defaultProps} />);

  for (const label of [
    'Merge Ready',
    'Needs Work',
    'Review Ready',
    'All orgs',
    'All repos',
    'All CI',
    'All reviews',
    'All merge',
    'All PRs',
  ]) {
    assert.ok(screen.getByText(label));
  }
  fireEvent.click(screen.getByRole('button', { name: 'Needs Work' }));
  assert.deepEqual(defaultProps.onFilterChange.mock.calls, [[{ needsWork: true }]]);
});

test('does not delegate a row click from interactive controls or selected text', () => {
  render(<WorkDashboard {...defaultProps} />);
  const primary = screen.getByRole('link', { name: 'Grouped work' });
  const primaryClick = vi.spyOn(primary, 'click').mockImplementation(() => {});

  fireEvent.click(screen.getByRole('link', { name: 'Open pull request #1: First PR' }));
  assert.equal(primaryClick.mock.calls.length, 0);

  vi.spyOn(window, 'getSelection').mockReturnValue(/** @type {Selection} */ ({ toString: () => 'selected text' }));
  fireEvent.click(screen.getByText('org/repo'));
  assert.equal(primaryClick.mock.calls.length, 0);
});

test('stores column preferences in the versioned dashboard key', () => {
  render(<WorkDashboard {...defaultProps} />);
  fireEvent.click(screen.getByText('Columns'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Work ref' }));

  assert.equal(screen.queryByRole('columnheader', { name: 'Work ref' }), null);
  const stored = JSON.parse(localStorage.getItem('claude-patrol-work-columns-v1') || '[]');
  assert.equal(stored.includes('work'), true);
  assert.equal(stored.includes('work_ref'), false);
});
