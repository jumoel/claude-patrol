import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';
import { PRTable } from './PRTable.jsx';

/** @type {import('../../types').PullRequest} */
const pr = {
  id: 'pr-1',
  number: 42,
  title: 'Keep live session state current',
  body: '',
  body_html: '',
  repo: 'widgets',
  org: 'acme',
  author: 'developer',
  url: 'https://example.invalid/pr/42',
  branch: 'feature',
  base_branch: 'main',
  is_fork: false,
  draft: false,
  mergeable: 'MERGEABLE',
  checks: [],
  reviews: [],
  labels: [],
  comments: [],
  created_at: '2026-08-25T00:00:00.000Z',
  updated_at: '2026-08-25T00:00:00.000Z',
  synced_at: '2026-08-25T00:00:00.000Z',
  ci_status: 'pass',
  review_status: 'approved',
  stack_parent: null,
  stack_children: [],
  stack_depth: 0,
  stack_root: 'pr-1',
  is_stacked: false,
  stack_size: 1,
  stack_position: 1,
  has_workspace: true,
  has_session: true,
  workspace_id: 'workspace-1',
};

test('live session activity invalidates the local-status accessor cache', () => {
  const props = {
    prs: [pr],
    sorting: [],
    onSortingChange: vi.fn(),
  };
  const { rerender } = render(<PRTable {...props} workspaceStates={new Map()} />);
  assert.ok(screen.getByText('Session'));

  rerender(<PRTable {...props} workspaceStates={new Map([['workspace:workspace-1', 'working']])} />);

  const working = screen.getByText('Working');
  assert.ok(working.querySelector('[data-spinner="true"]'));
  assert.equal(screen.queryByText('Session'), null);
});
