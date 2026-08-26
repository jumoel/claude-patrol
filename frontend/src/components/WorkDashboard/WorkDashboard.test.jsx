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
  sessionSource: { allSessions: [] },
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
  vi.restoreAllMocks();
});

test('renders a multi-PR work item once and keeps child PR links independent', () => {
  render(<WorkDashboard {...defaultProps} />);
  assert.equal(screen.getAllByText('Grouped work').length, 1);
  assert.ok(screen.getByRole('link', { name: 'Open pull request #1: First PR' }));
  assert.ok(screen.getByRole('link', { name: 'Open pull request #2: Second PR' }));

  const primary = screen.getByRole('link', { name: 'Grouped work' });
  const primaryClick = vi.spyOn(primary, 'click').mockImplementation(() => {});
  fireEvent.click(screen.getByText('org/repo'));
  assert.equal(primaryClick.mock.calls.length, 1);

  fireEvent.click(screen.getByRole('link', { name: 'Open pull request #1: First PR' }));
  assert.equal(primaryClick.mock.calls.length, 1);
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
