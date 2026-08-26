import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { test, vi } from 'vitest';
import { LinkedPullRequests } from './LinkedPullRequests.jsx';

const api = vi.hoisted(() => ({
  fetchPR: vi.fn(),
  fetchPRComments: vi.fn(),
  linkWorkItemPullRequest: vi.fn(),
  refreshPR: vi.fn(),
  setPRDraft: vi.fn(),
  unlinkWorkItemPullRequest: vi.fn(),
}));

vi.mock('../../lib/api.js', () => api);
vi.mock('../../hooks/useSyncEvents.js', () => ({ useSyncEvents: () => {} }));
vi.mock('../RuleControls/RuleControls.jsx', () => ({ RuleControls: () => null }));
vi.mock('../PRDetail/PRDetail.jsx', () => ({
  PullRequestChecks: () => null,
  PullRequestComments: () => null,
  PullRequestDescription: () => null,
  PullRequestReviews: () => null,
}));

/** @param {string} id @param {string} repository @param {number} number */
function pullRequest(id, repository, number) {
  const [org, repo] = repository.split('/');
  return {
    id,
    org,
    repo,
    repository,
    number,
    title: null,
    url: `https://github.com/${repository}/pull/${number}`,
    branch: null,
    base_branch: null,
    draft: false,
    mergeable: /** @type {'UNKNOWN'} */ ('UNKNOWN'),
    ci_status: /** @type {'pending'} */ ('pending'),
    review_status: /** @type {'pending'} */ ('pending'),
    updated_at: null,
    tracked: false,
    linked_at: '2026-08-26T00:00:00.000Z',
    link_source: /** @type {'explicit'} */ ('explicit'),
  };
}

/** @returns {import('../../types').WorkItemDetail} */
function workItem() {
  const pullRequests = [
    pullRequest('acme/widgets#11', 'acme/widgets', 11),
    pullRequest('acme/tools#12', 'acme/tools', 12),
  ];
  return {
    id: 'item-1',
    reference: 'PROJECT-1',
    title: 'Ship coordinated changes',
    summary: 'Update both repositories.',
    work_provider: 'codex',
    resolver_provider: 'codex',
    state: 'ready',
    stage: 'complete',
    progress: { current: 0, total: 0 },
    repositories: ['acme/widgets', 'acme/tools'],
    pull_request_count: pullRequests.length,
    pull_requests: pullRequests,
    updated_at: '2026-08-26T00:00:00.000Z',
    created_at: '2026-08-25T00:00:00.000Z',
    destroyed_at: null,
    root_path: '/tmp/item-1',
    has_session_history: false,
    session: null,
    error: null,
    repository_workspaces: [],
  };
}

test('renders multiple owned pull requests and attaches another by URL', async () => {
  const user = userEvent.setup();
  const reload = vi.fn();
  const linked = pullRequest('acme/widgets#13', 'acme/widgets', 13);
  api.linkWorkItemPullRequest.mockResolvedValue({ pull_request: linked });
  render(
    <LinkedPullRequests
      workItem={workItem()}
      onWorkItemReload={reload}
      ensureSession={vi.fn()}
      wsRef={{ current: null }}
    />,
  );

  assert.ok(screen.getByRole('link', { name: /acme\/widgets #11/u }));
  assert.ok(screen.getByRole('link', { name: /acme\/tools #12/u }));
  assert.equal(
    screen.getByRole('link', { name: /acme\/tools #12/u }).getAttribute('href'),
    '#/work-item/item-1?pr=acme%2Ftools%2312',
  );
  await user.click(screen.getByText('Attach existing PR'));
  await user.type(screen.getByRole('textbox', { name: 'PR URL or ID' }), linked.url);
  await user.click(screen.getByRole('button', { name: 'Attach' }));

  assert.deepEqual(api.linkWorkItemPullRequest.mock.calls[0], ['item-1', linked.url]);
  assert.equal(reload.mock.calls.length, 1);
});
