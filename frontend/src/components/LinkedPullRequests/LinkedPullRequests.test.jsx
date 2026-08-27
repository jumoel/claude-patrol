import assert from 'node:assert/strict';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, test, vi } from 'vitest';
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
  /** @param {{pr: import('../../types').PullRequest}} props */
  PullRequestChecks: ({ pr }) => (
    <section aria-label="CI checks">
      {pr.checks.map((check) => (
        <span key={check.name}>{check.name}</span>
      ))}
    </section>
  ),
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
    creation_source: 'reference',
    reference: 'PROJECT-1',
    reference_display: null,
    reference_system: null,
    reference_url: null,
    title: 'Ship coordinated changes',
    summary: 'Update both repositories.',
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

/** @returns {import('../../types').PullRequest} */
function trackedPullRequest() {
  return {
    id: 'acme/tools#12',
    number: 12,
    title: 'Harden remediation parsing',
    body: '',
    body_html: '',
    repo: 'tools',
    org: 'acme',
    author: 'octocat',
    url: 'https://github.com/acme/tools/pull/12',
    branch: 'harden-parsing',
    base_branch: 'main',
    is_fork: false,
    draft: false,
    mergeable: 'MERGEABLE',
    checks: [{ name: 'unit-tests', status: 'COMPLETED', conclusion: 'SUCCESS', url: 'https://example.test/check' }],
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
    stack_root: 'acme/tools#12',
    is_stacked: false,
    stack_size: 1,
    stack_position: 1,
    work_item_id: 'item-1',
    work_item: { id: 'item-1', reference: 'PROJECT-1', title: 'Ship coordinated changes', state: 'ready' },
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchPRComments.mockResolvedValue({ reviews: [], conversation: [] });
});

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

  const pullRequestList = within(screen.getByRole('list', { name: 'Work item pull requests' }));
  assert.ok(pullRequestList.getByRole('link', { name: /#11 acme\/widgets/u }));
  assert.ok(pullRequestList.getByRole('link', { name: /#12 acme\/tools/u }));
  assert.equal(
    pullRequestList.getByRole('link', { name: /#12 acme\/tools/u }).getAttribute('href'),
    '#/work-item/item-1?pr=acme%2Ftools%2312',
  );
  assert.equal(screen.getAllByText('Waiting for sync').length, 3);
  assert.equal(api.fetchPR.mock.calls.length, 0);
  assert.equal(api.fetchPRComments.mock.calls.length, 0);
  await user.click(screen.getByText('Attach existing PR'));
  await user.type(screen.getByRole('textbox', { name: 'PR URL or ID' }), linked.url);
  await user.click(screen.getByRole('button', { name: 'Attach' }));

  assert.deepEqual(api.linkWorkItemPullRequest.mock.calls[0], ['item-1', linked.url]);
  assert.equal(reload.mock.calls.length, 1);
});

test('shows PR health in the list and all four statuses in the selected inspector', async () => {
  const item = workItem();
  item.pull_requests = item.pull_requests.map((link, index) =>
    index === 0
      ? {
          ...link,
          title: 'Judge JavaScript remediation fidelity',
          tracked: true,
          ci_status: 'pending',
          review_status: 'approved',
          mergeable: 'MERGEABLE',
        }
      : {
          ...link,
          title: 'Harden remediation parsing',
          tracked: true,
          ci_status: 'pass',
          review_status: 'approved',
          mergeable: 'MERGEABLE',
        },
  );
  api.fetchPR.mockResolvedValue(trackedPullRequest());

  render(
    <LinkedPullRequests
      workItem={item}
      selectedPrId="acme/tools#12"
      onWorkItemReload={vi.fn()}
      ensureSession={vi.fn()}
      wsRef={{ current: null }}
    />,
  );

  const pullRequestList = within(screen.getByRole('list', { name: 'Work item pull requests' }));
  const selected = pullRequestList.getByRole('link', {
    name: /#12 Harden remediation parsing/u,
  });
  assert.equal(selected.getAttribute('aria-current'), 'page');
  assert.equal(pullRequestList.getAllByLabelText(/CI (Pending|Pass)/u).length, 2);
  assert.equal(pullRequestList.getAllByLabelText('Review Approved').length, 2);
  assert.equal(pullRequestList.getAllByLabelText('Merge Clean').length, 2);
  assert.equal(pullRequestList.queryByLabelText('PR Open'), null);
  assert.ok(await screen.findByRole('heading', { name: '#12 Harden remediation parsing' }));
  assert.equal(screen.getAllByLabelText('PR Open').length, 1);
  assert.ok(screen.getByRole('region', { name: 'CI checks' }));
  assert.ok(screen.getByText('unit-tests'));
  assert.deepEqual(api.fetchPR.mock.calls, [['acme/tools#12']]);
  assert.deepEqual(api.fetchPRComments.mock.calls, [['acme/tools#12']]);
});
