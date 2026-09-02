import assert from 'node:assert/strict';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, test, vi } from 'vitest';
import { CommandPalette } from './CommandPalette.jsx';

// jsdom has no scrollIntoView; the palette calls it whenever the highlighted row changes.
const scrollIntoView = vi.fn();
Element.prototype.scrollIntoView = scrollIntoView;

const standalonePR = /** @type {import('../../types').PullRequest} */ ({
  id: 'acme/api#12',
  number: 12,
  title: 'Fix login redirect loop',
  body: 'Users bounce between /login and /home',
  org: 'acme',
  repo: 'api',
  branch: 'fix-login-loop',
  draft: false,
  mergeable: 'MERGEABLE',
  ci_status: 'pass',
  review_status: 'pending',
  workspace_id: null,
  work_item_id: null,
});
const ownedPR = { ...standalonePR, id: 'acme/api#13', number: 13, title: 'Owned by a work item', work_item_id: 'wi-1' };
/** @type {import('../../types').WorkItemListItem} */
const workItem = {
  id: 'wi-1',
  creation_source: 'reference',
  reference: 'ECO-77',
  reference_display: 'ECO-77',
  reference_system: 'tracker',
  reference_url: null,
  title: 'Rotate signing keys',
  resolver_provider: 'claude',
  state: 'ready',
  stage: 'complete',
  progress: { current: 1, total: 1 },
  repositories: ['acme/api'],
  pull_request_count: 0,
  pull_requests: [],
  repository_workspaces: [],
  updated_at: '2026-08-30T10:00:00.000Z',
  has_session_history: false,
  session: null,
  error: null,
};
const scratch = /** @type {import('../../types').Workspace} */ ({
  id: 'ws-1',
  bookmark: 'patrol/spike-cache',
  repo: 'acme/widgets',
});
const globalSession = /** @type {import('../../types').Session} */ ({
  id: 'sess-1',
  name: 'Ops shell',
  provider: 'claude',
  status: 'active',
});

function renderPalette() {
  const callbacks = {
    onNavigate: vi.fn(),
    onNavigateWorkspace: vi.fn(),
    onNavigateWorkItem: vi.fn(),
    onOpenGlobalTerminal: vi.fn(),
    onCloseGlobalTerminal: vi.fn(),
  };
  render(
    <CommandPalette
      prs={[standalonePR, ownedPR]}
      workItems={[workItem]}
      scratchWorkspaces={[scratch]}
      globalSessions={[globalSession]}
      {...callbacks}
    />,
  );
  return callbacks;
}

beforeEach(() => {
  scrollIntoView.mockReset();
});

/** @param {ReturnType<typeof userEvent.setup>} user */
async function openPalette(user) {
  await user.keyboard('{Control>}k{/Control}');
  const input = screen.getByRole('textbox');
  await user.click(input);
  return input;
}

test('Ctrl+K toggles the palette, which lists standalone PRs, work items, scratch workspaces, and global sessions', async () => {
  const user = userEvent.setup();
  renderPalette();
  assert.equal(screen.queryByRole('textbox'), null);

  const input = await openPalette(user);
  assert.equal(input.getAttribute('placeholder'), 'Search PRs, work items, and workspaces...');
  assert.ok(screen.getByText('Fix login redirect loop'));
  assert.ok(screen.getByText('Rotate signing keys'));
  assert.ok(screen.getByText('patrol/spike-cache'));
  assert.ok(screen.getByText('Ops shell'));
  assert.equal(
    screen.queryByText('Owned by a work item'),
    null,
    'PRs owned by a work item are listed via the work item',
  );

  await user.keyboard('{Control>}k{/Control}');
  assert.equal(screen.queryByRole('textbox'), null);
});

test('typing filters every source by its own search text', async () => {
  const user = userEvent.setup();
  renderPalette();
  const input = await openPalette(user);

  await user.type(input, 'rotate');
  assert.ok(screen.getByText('Rotate signing keys'));
  assert.equal(screen.queryByText('Fix login redirect loop'), null);
  assert.equal(screen.queryByText('patrol/spike-cache'), null);
  assert.equal(screen.queryByText('Ops shell'), null);

  await user.clear(input);
  await user.type(input, 'bounce');
  assert.ok(screen.getByText('Fix login redirect loop'), 'PR bodies are searched');
  assert.equal(screen.queryByText('Rotate signing keys'), null);

  await user.clear(input);
  await user.type(input, 'spike');
  assert.ok(screen.getByText('patrol/spike-cache'));
  assert.equal(screen.queryByText('Fix login redirect loop'), null);

  await user.clear(input);
  await user.type(input, 'ops');
  assert.ok(screen.getByText('Ops shell'));
  assert.equal(screen.queryByText('patrol/spike-cache'), null);

  await user.clear(input);
  await user.type(input, 'zzz');
  assert.ok(screen.getByText('No results'));
});

test('Enter opens the highlighted result and closes the palette', async () => {
  const user = userEvent.setup();
  const callbacks = renderPalette();

  await openPalette(user);
  await user.keyboard('{ArrowDown}');
  assert.deepEqual(scrollIntoView.mock.calls, [[{ block: 'nearest' }]], 'the highlighted row is kept in view');
  await user.keyboard('{Enter}');
  assert.deepEqual(callbacks.onNavigateWorkItem.mock.calls, [['wi-1']]);
  assert.equal(callbacks.onCloseGlobalTerminal.mock.calls.length, 1);
  assert.equal(callbacks.onNavigate.mock.calls.length, 0);
  assert.equal(screen.queryByRole('textbox'), null);

  const input = await openPalette(user);
  await user.type(input, 'ops');
  await user.keyboard('{Enter}');
  assert.deepEqual(callbacks.onOpenGlobalTerminal.mock.calls, [['sess-1']]);
  assert.equal(callbacks.onCloseGlobalTerminal.mock.calls.length, 1, 'a global session does not close the terminal');
  assert.equal(screen.queryByRole('textbox'), null);
});

test('clicking a result navigates, and Escape closes and clears the query', async () => {
  const user = userEvent.setup();
  const callbacks = renderPalette();

  await openPalette(user);
  await user.click(screen.getByText('Fix login redirect loop'));
  assert.deepEqual(callbacks.onNavigate.mock.calls, [['acme/api#12']]);
  assert.equal(callbacks.onCloseGlobalTerminal.mock.calls.length, 1);
  assert.equal(screen.queryByRole('textbox'), null);

  const input = await openPalette(user);
  await user.type(input, 'spike');
  assert.equal(screen.queryByText('Ops shell'), null);
  await user.keyboard('{Escape}');
  assert.equal(screen.queryByRole('textbox'), null);

  const reopened = await openPalette(user);
  assert.equal(/** @type {HTMLInputElement} */ (reopened).value, '');
  assert.ok(screen.getByText('Ops shell'));
  assert.equal(callbacks.onNavigateWorkspace.mock.calls.length, 0);
});
